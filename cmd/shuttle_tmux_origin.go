package cmd

import (
	"os/exec"
	"strings"
)

// Who forked the tmux server on this host — a macOS-only question with
// day-ruining consequences.
//
// macOS privacy (TCC) charges a process tree's file access to the tree's
// *responsible process*. `tmux new-session` forks a server when none is
// running, so if the Shuttle daemon is what runs it first, the server — and
// therefore every worker on it, every shell, every tool — is charged to the
// daemon's executable, surfaced to the human as "erlexec". The daemon cannot
// hold those grants (Full Disk Access does not inherit under launchd), so the
// human gets an unending stream of "erlexec wants to access data from other
// apps" prompts that approving does not fix. The daemon now refuses to fork the
// server (Shuttle.TmuxServer), but a server forked before that change — or by
// an older daemon — keeps poisoning workers until a human restarts it.
//
// So the receipt has to be able to SAY so, and it asks the kernel rather than
// guessing. `launchctl procinfo <pid>` names the responsible process outright
// but needs root (verified: rc=1, "This subcommand requires root privileges:
// procinfo"). `launchctl print pid/<pid>` needs no privileges and prints the
// process's resource coalition, whose `name` is the launchd label (or app
// bundle id) of the job that rooted the tree — which is exactly the attribution
// TCC uses. Verified on this host: the daemon-born server → `io.shuttle.daemon`;
// a server forked by `kitty @ launch --type=background` →
// `com.koekeishiya.skhd`, the app that launched kitty.
const (
	tmuxOriginDaemonBorn = "daemon_born"
	tmuxOriginUserBorn   = "user_born"
	tmuxOriginUnknown    = "unknown"
	tmuxOriginAbsent     = "absent"
)

// daemonLaunchdLabel is the launchd label the daemon's own agent is installed
// under (`daemon/share/io.shuttle.daemon.plist.template`, and `install-agent
// --label`'s default). Built from the one reverse-DNS prefix the tunnel labels
// also derive from, so the label this compares against and the label the daemon
// is installed under cannot drift apart.
const daemonLaunchdLabel = defaultLaunchdLabelPrefix + ".daemon"

// tmuxOriginReport is what the receipt and `felt shuttle status` report about
// the running tmux server. Coalition is the raw launchd label the kernel
// attributes the server to — reported verbatim so a `user_born` server still
// says WHICH app owns it (the one the human will see in TCC prompts).
type tmuxOriginReport struct {
	Origin    string
	ServerPID string
	Coalition string
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

// classifyCoalition maps a resource-coalition name to an origin. Pure.
func classifyCoalition(name string) string {
	switch name {
	case "":
		return tmuxOriginUnknown
	case daemonLaunchdLabel:
		return tmuxOriginDaemonBorn
	default:
		return tmuxOriginUserBorn
	}
}

// detectTmuxOrigin reads the live server: its pid from tmux, then the launchd
// coalition the kernel charges it to. A func var so tests stub it out.
var detectTmuxOrigin = func() tmuxOriginReport {
	out, err := exec.Command("tmux", "display-message", "-p", "#{pid}").Output()
	pid := ""
	if err == nil {
		pid = strings.TrimSpace(string(out))
	}
	if pid == "" {
		return tmuxOriginReport{Origin: tmuxOriginAbsent}
	}

	// CombinedOutput, not Output: a launchctl that exits non-zero may still have
	// printed the block, and one that printed nothing parses to "" → unknown.
	printed, _ := exec.Command("launchctl", "print", "pid/"+pid).CombinedOutput()
	name := parseResourceCoalitionName(string(printed))

	return tmuxOriginReport{Origin: classifyCoalition(name), ServerPID: pid, Coalition: name}
}

// tmuxOriginRepair is the one-line remedy a human acts on. Deliberately spells
// out the ordering constraint: killing the server kills every worker on it.
const tmuxOriginRepair = "tmux server is charged to the Shuttle daemon (launchd coalition " + daemonLaunchdLabel + ") — macOS charges every worker's file access to the daemon binary; restart your tmux server from a terminal (kill it once no workers are live, then tmux new-session -d -s shuttle-anchor from a kitty window)"
