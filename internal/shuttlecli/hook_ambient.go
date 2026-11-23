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
	if a.env.Getenv("TMUX") != "" {
		if ref, err := a.currentTerminal(); err == nil && ref.NativeSession != "" {
			termFlags = append(termFlags, "--tmux-session", shellQuoteArg(ref.NativeSession))
			if ref.NativePane != "" {
				termFlags = append(termFlags, "--tmux-pane", shellQuoteArg(ref.NativePane))
			}
		}
	} else if sid, bid := strings.TrimSpace(a.env.Getenv("REX_SESSION")), strings.TrimSpace(a.env.Getenv("REX_BLOCK")); sid != "" {
		termFlags = append(termFlags, "--rex-session", shellQuoteArg(sid))
		if bid != "" {
			termFlags = append(termFlags, "--rex-block", shellQuoteArg(bid))
		}
	}

	var cmdParts []string
	cmdParts = append(cmdParts, "shuttle adopt <parent>/<slug> \"<title>\"")
	if sid := sanitizeAmbientArg(input.SessionID); sid != "" {
		cmdParts = append(cmdParts, "--session-uuid", shellQuoteArg(sid))
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
	b.WriteString("Load the `felt` skill. Once the user's request turns into substantive work (skip trivial one-off questions or if asked not to track), also load the `shuttle` skill and adopt this session into a fiber:\n")
	fmt.Fprintf(&b, "  %s", strings.Join(cmdParts, " "))
	return b.String()
}

func sanitizeAmbientArg(s string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(s))
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
