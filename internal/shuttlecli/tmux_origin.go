package shuttlecli

import (
	"strings"
)

// Who rooted the tmux server on this host — a macOS-only question with
// day-ruining consequences.
//
// macOS privacy (TCC) charges a process tree's file, microphone and
// system-audio access to the tree's *responsible app*: the launchd resource
// coalition the tree sits in. Every worker on the tmux server inherits the
// server's coalition, so the app that rooted the server is the app whose grants
// every worker gets. Three cases matter:
//
//   - the Shuttle daemon (`io.shuttle.daemon`): `tmux new-session` forked the
//     server under the daemon, which cannot hold grants (Full Disk Access does
//     not inherit under launchd), so every worker raises "erlexec wants to
//     access data from other apps" prompts that approving does not fix. A
//     receipt mismatch: the daemon refuses to fork the server
//     (Shuttle.TmuxServer), so only a server it should not have made gets here.
//   - kitty itself (`application.net.kovidgoyal.kitty.<n>.<n>`): the intended
//     root, the app the human grants once.
//   - any other app: a kitty started by another app's child process sits in
//     that app's coalition — the Quick Access panel toggled by an Alfred or
//     skhd hotkey is charged to the launcher — and so does a server forked
//     through it. Workers then get that app's grants, typically none: an
//     all-zero microphone. Reported as a warning, since a server rooted by
//     another terminal the human granted is legitimate.
//
// The kernel is asked rather than guessed at. `launchctl procinfo <pid>` names
// the responsible process outright but needs root; `launchctl print pid/<pid>`
// needs no privileges and prints the resource coalition, whose `name` is the
// launchd label, or `application.<bundle id>.<n>.<n>` for an app LaunchServices
// started.
const (
	tmuxOriginDaemonBorn = "daemon_born"
	tmuxOriginKittyBorn  = "kitty_born"
	tmuxOriginAppBorn    = "app_born"
	tmuxOriginUnknown    = "unknown"
	tmuxOriginAbsent     = "absent"
)

// kittyBundleID is the bundle id of kitty's main app. The Quick Access panel
// is a separate bundle with its own grants and does not count.
const kittyBundleID = "net.kovidgoyal.kitty"

// daemonLaunchdLabel is the launchd label the daemon's own agent is installed
// under (`daemon/share/io.shuttle.daemon.plist.template`, and `install-agent
// --label`'s default). Built from the one reverse-DNS prefix the tunnel labels
// also derive from, so the label this compares against and the label the daemon
// is installed under cannot drift apart.
const daemonLaunchdLabel = defaultLaunchdLabelPrefix + ".daemon"

// tmuxOriginReport is what the receipt and `shuttle status` report about
// the running tmux server. Coalition is the raw resource-coalition name the
// kernel attributes the server to; RootedBy is the app or launchd job it names
// (coalitionRoot), the one the human will see in TCC prompts and settings.
type tmuxOriginReport struct {
	Origin    string
	ServerPID string
	Coalition string
	RootedBy  string
}

// parseResourceCoalitionName pulls the `name` out of `launchctl print
// pid/<pid>`'s **resource** coalition block. Pure, so the parser is tested
// against captured real output.
//
// The output carries two coalition blocks — `resource` and `jetsam` — and only
// the resource coalition is the file-access attribution TCC follows, so the
// block is selected by name rather than by taking the first `name =` line.
// Returns "" for output with no parsable resource-coalition name (a launchctl
// whose format moved, or a pid that vanished mid-call): the caller reports that
// as `unknown` rather than blaming anyone.
func parseResourceCoalitionName(out string) string {
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "resource coalition") || !strings.Contains(trimmed, "{") {
			continue
		}
		depth := 1
		for _, inner := range lines[i+1:] {
			t := strings.TrimSpace(inner)
			if depth == 1 && strings.HasPrefix(t, "name = ") {
				return strings.TrimSpace(strings.TrimPrefix(t, "name = "))
			}
			depth += strings.Count(t, "{") - strings.Count(t, "}")
			if depth <= 0 {
				break
			}
		}
		return ""
	}
	return ""
}

// coalitionRoot names the app or launchd job a resource coalition belongs to:
// the bundle id of an `application.<bundle id>.<n>.<n>` coalition, else the
// name verbatim (a launchd label such as io.shuttle.daemon). Pure.
func coalitionRoot(name string) string {
	rest, ok := strings.CutPrefix(name, "application.")
	if !ok {
		return name
	}
	parts := strings.Split(rest, ".")
	end := len(parts)
	for end > 1 && isDigits(parts[end-1]) {
		end--
	}
	return strings.Join(parts[:end], ".")
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// classifyCoalition maps a resource-coalition name to an origin. Pure.
func classifyCoalition(name string) string {
	switch {
	case name == "":
		return tmuxOriginUnknown
	case name == daemonLaunchdLabel:
		return tmuxOriginDaemonBorn
	case strings.HasPrefix(name, "application.") && coalitionRoot(name) == kittyBundleID:
		return tmuxOriginKittyBorn
	default:
		return tmuxOriginAppBorn
	}
}

// probeTmuxOrigin reads the live server (app.detectTmuxOrigin): its pid from
// tmux, then the launchd coalition the kernel charges it to.
func (a *app) probeTmuxOrigin() tmuxOriginReport {
	out, err := a.env.Command("tmux", "display-message", "-p", "#{pid}").Output()
	pid := ""
	if err == nil {
		pid = strings.TrimSpace(string(out))
	}
	if pid == "" {
		return tmuxOriginReport{Origin: tmuxOriginAbsent}
	}

	// CombinedOutput, not Output: a launchctl that exits non-zero may still have
	// printed the block, and one that printed nothing parses to "" → unknown.
	printed, _ := a.env.Command("launchctl", "print", "pid/"+pid).CombinedOutput()
	name := parseResourceCoalitionName(string(printed))

	return tmuxOriginReport{Origin: classifyCoalition(name), ServerPID: pid, Coalition: name, RootedBy: coalitionRoot(name)}
}

// tmuxOriginRepair is the one-line remedy a human acts on. Deliberately spells
// out the ordering constraint: killing the server kills every worker on it.
const tmuxOriginRepair = "tmux server is charged to the Shuttle daemon (launchd coalition " + daemonLaunchdLabel + ") — macOS charges every worker's file access to the daemon binary; restart your tmux server from a terminal (kill it once no workers are live, then tmux new-session -d -s shuttle-anchor from a kitty window)"

// tmuxOriginWarning is the advisory for a server rooted by an app other than
// kitty or the daemon; "" for every other origin.
func tmuxOriginWarning(report tmuxOriginReport) string {
	if report.Origin != tmuxOriginAppBorn {
		return ""
	}
	return "tmux server rooted by " + report.RootedBy + ": workers inherit that app's privacy grants (mic, system audio); restart the server from kitty (kill it once no workers are live, then tmux new-session -d -s shuttle-anchor from a kitty opened from the Dock or Finder)"
}
