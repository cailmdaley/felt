package cmd

import (
	"os/exec"
	"regexp"
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
// So the receipt has to be able to SAY so. `launchctl procinfo <pid>` would
// name the responsible process outright, but it needs root (verified: rc=1,
// "This subcommand requires root privileges: procinfo"), so attribution is read
// from a marker the daemon stamps plus the server's own argv.

const (
	tmuxOriginMarkerVar = "SHUTTLE_TMUX_ORIGIN"

	tmuxOriginKittyBorn  = "kitty_born"
	tmuxOriginDaemonBorn = "daemon_born"
	tmuxOriginUnknown    = "unknown"
	tmuxOriginAbsent     = "absent"
)

// tmuxOriginReport is what the receipt and `felt shuttle status` report about
// the running tmux server.
type tmuxOriginReport struct {
	Origin    string
	ServerPID string
	Argv      string
}

// A daemon-forked server's argv is self-describing: the run script the
// dispatcher handed it (shuttle-run-<n>.sh) and/or the `-shuttle` worker
// session it was told to create.
var tmuxDaemonArgvPatterns = []*regexp.Regexp{
	regexp.MustCompile(`shuttle-run-`),
	regexp.MustCompile(`-s\s+\S+-shuttle\b`),
}

// classifyTmuxOrigin mirrors Shuttle.TmuxServer.classify_origin/2 exactly — the
// two must agree, or the receipt contradicts the daemon.
//
// A marker means the daemon started the server through kitty (the only time it
// stamps one). No marker plus daemon-shaped argv is daemon-born. No marker and
// some other argv is unknown — a human's own server, or one predating the
// marker; never punished, because a server we cannot attribute might be fine.
func classifyTmuxOrigin(marker, argv string) string {
	switch {
	case strings.TrimSpace(marker) != "":
		return tmuxOriginKittyBorn
	case strings.TrimSpace(argv) == "":
		return tmuxOriginAbsent
	}
	for _, re := range tmuxDaemonArgvPatterns {
		if re.MatchString(argv) {
			return tmuxOriginDaemonBorn
		}
	}
	return tmuxOriginUnknown
}

// detectTmuxOrigin reads the live server: marker, then pid, then argv. A func
// var so tests stub tmux and ps.
var detectTmuxOrigin = func() tmuxOriginReport {
	marker := ""
	if out, err := exec.Command("tmux", "show-environment", "-g", tmuxOriginMarkerVar).Output(); err == nil {
		marker = strings.TrimSpace(string(out))
	}

	pid := ""
	if out, err := exec.Command("tmux", "display-message", "-p", "#{pid}").Output(); err == nil {
		pid = strings.TrimSpace(string(out))
	}

	argv := ""
	if pid != "" {
		if out, err := exec.Command("ps", "-o", "args=", "-p", pid).Output(); err == nil {
			argv = strings.TrimSpace(string(out))
		}
	}

	return tmuxOriginReport{Origin: classifyTmuxOrigin(marker, argv), ServerPID: pid, Argv: argv}
}

// tmuxOriginRepair is the one-line remedy a human acts on. Deliberately spells
// out the ordering constraint: killing the server kills every worker on it.
const tmuxOriginRepair = "tmux server was started by the Shuttle daemon — macOS charges every worker's file access to the daemon binary; restart your tmux server from kitty (kill it once no workers are live, then tmux new-session -d -s shuttle-anchor from a kitty window)"
