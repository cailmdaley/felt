package shuttlecli

import (
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

const ambientDaemonProbeTimeout = 250 * time.Millisecond

func combineHookContext(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	return strings.Join(nonEmpty, "\n\n")
}

// ambientSessionContext emits concise opt-in adoption instructions on
// SessionStart for unattached sessions when ambient mode is enabled and the
// local daemon is reachable. Never errors or blocks SessionStart.
func (a *app) ambientSessionContext(input eventHookInput, host string) string {
	if input.HookEventName != "SessionStart" {
		return ""
	}
	if strings.TrimSpace(a.env.Getenv("SHUTTLE_FIBER")) != "" || strings.TrimSpace(a.env.Getenv("SHUTTLE_FIBER_PATH")) != "" {
		return ""
	}
	enabled, err := shuttle.HostAmbient(a.env)
	if err != nil || !enabled {
		return ""
	}
	if !a.daemonReachableQuick() {
		return ""
	}

	projectDir := strings.TrimSpace(input.CWD)
	if projectDir == "" {
		if wd, err := a.env.Getwd(); err == nil {
			projectDir = wd
		}
	}
	storeRoot := ""
	if projectDir != "" {
		if root, err := felt.ProjectRoot(a.env, projectDir); err == nil {
			storeRoot = root
		}
	}

	var termFlags []string
	var termDesc string
	if a.env.Getenv("TMUX") != "" {
		if ref, err := a.currentTerminal(); err == nil && ref.NativeSession != "" {
			termDesc = fmt.Sprintf("tmux session=%s", ref.NativeSession)
			termFlags = append(termFlags, "--tmux-session", shellQuoteArg(ref.NativeSession))
			if ref.NativePane != "" {
				termDesc += fmt.Sprintf(" pane=%s", ref.NativePane)
				termFlags = append(termFlags, "--tmux-pane", shellQuoteArg(ref.NativePane))
			}
		}
	} else if sid, bid := strings.TrimSpace(a.env.Getenv("REX_SESSION")), strings.TrimSpace(a.env.Getenv("REX_BLOCK")); sid != "" {
		termDesc = fmt.Sprintf("rex session=%s", sid)
		termFlags = append(termFlags, "--rex-session", shellQuoteArg(sid))
		if bid != "" {
			termDesc += fmt.Sprintf(" block=%s", bid)
			termFlags = append(termFlags, "--rex-block", shellQuoteArg(bid))
		}
	}

	var cmdParts []string
	cmdParts = append(cmdParts, "shuttle adopt <parent>/<slug> \"<title>\"")
	if input.SessionID != "" {
		cmdParts = append(cmdParts, "--session-uuid", shellQuoteArg(input.SessionID))
	}
	if projectDir != "" {
		cmdParts = append(cmdParts, "--project-dir", shellQuoteArg(projectDir))
	}
	if storeRoot != "" {
		cmdParts = append(cmdParts, "--store", shellQuoteArg(storeRoot))
	}
	cmdParts = append(cmdParts, termFlags...)

	var b strings.Builder
	b.WriteString("[Shuttle ambient mode]\n")
	b.WriteString("Ambient Shuttle mode is active for this unattached session.\n")
	fmt.Fprintf(&b, "- session_uuid: %s\n", input.SessionID)
	if host != "" {
		fmt.Fprintf(&b, "- host: %s\n", host)
	}
	if projectDir != "" {
		fmt.Fprintf(&b, "- project_dir: %s\n", projectDir)
	}
	if storeRoot != "" {
		fmt.Fprintf(&b, "- store: %s\n", storeRoot)
	}
	if termDesc != "" {
		fmt.Fprintf(&b, "- terminal: %s\n", termDesc)
	}
	b.WriteString("Once the user's request turns into substantive work (skip trivial one-off questions or if the user asks not to track), quietly choose a fitting parent/slug in the felt store and run:\n")
	fmt.Fprintf(&b, "  %s\n", strings.Join(cmdParts, " "))
	b.WriteString("This adopts the session into a fiber so it appears on Desk and in Rex's sidebar with its tapestry and handoffs.")
	return b.String()
}

func (a *app) daemonReachableQuick() bool {
	endpoint, err := a.daemonEndpoint("/api/v1/version")
	if err != nil {
		return false
	}
	_, err = a.getDaemon(endpoint, ambientDaemonProbeTimeout)
	return err == nil
}

func shellQuoteArg(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, " \t\n'\"\\$`!;|&()<>?*[]{}~#") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
