package shuttlecli

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/progstatus"
)

// programStatusFor maps a hook to one root record, without prompt or tool input.
// Native reporters own child records and direct-terminal status.
func programStatusFor(input eventHookInput, harness, fiberPath string) (progstatus.Report, bool) {
	r := progstatus.Report{}
	switch harness {
	case "claude":
		r.App = "claude-code"
	case "pi":
		r.App = "pi"
	default:
		return r, false
	}
	if fiberPath != "" {
		r.Title = strings.TrimSuffix(filepath.Base(fiberPath), ".md")
	}
	switch input.HookEventName {
	case "SessionStart":
		r.State = "idle"
	case "UserPromptSubmit":
		r.State = "working"
	case "PreToolUse":
		switch input.ToolName {
		case "AskUserQuestion":
			r.State, r.Kind, r.Msg = "blocked", "question", "Question"
		case "ExitPlanMode":
			r.State, r.Kind, r.Msg = "blocked", "permission", "Plan approval"
		default:
			r.State, r.Msg = "working", input.ToolName
		}
	case "PostToolUse":
		r.State, r.Msg = "working", input.ToolName
	case "Notification":
		if input.NotificationType == "idle_prompt" {
			return progstatus.Report{}, false
		}
		r.State, r.Msg = "blocked", input.Message
		switch input.NotificationType {
		case "permission_prompt":
			r.Kind = "permission"
		case "elicitation_dialog":
			r.Kind = "question"
		}
	case "Stop":
		if n := countBackgroundTasks(input.BackgroundTasks); n > 0 {
			r.State, r.Msg = "working", strconv.Itoa(n)+" background tasks"
		} else {
			r.State = "done"
		}
	case "SessionEnd":
		r.State = "clear"
	default:
		return progstatus.Report{}, false
	}
	return r, true
}

// reportProgramStatus bridges tmux only: Claude and Pi report natively in a
// direct terminal. Codex hooks run in the shared App Server, not its viewer.
// Terminal lookup and write failures never affect a hook's result or output.
func (a *app) reportProgramStatus(input eventHookInput) {
	if off := a.env.Getenv("SHUTTLE_PROGRAM_STATUS"); off == "off" || off == "0" {
		return
	}
	if a.env.Getenv("TMUX") == "" || a.env.Getenv("TMUX_PANE") == "" {
		return
	}
	harness := input.Harness
	if harness != "claude" && harness != "pi" && harness != "codex" {
		harness = messaging.NormalizeHarness(a.harnessFor(input.TranscriptPath))
	}
	report, ok := programStatusFor(input, harness, a.env.Getenv("SHUTTLE_FIBER_PATH"))
	if !ok {
		return
	}
	receiver := input.NativePID
	if harness != "pi" {
		receiver = a.eventReceiverPID()
	}
	path := a.programStatusTTY(receiver)
	if path == "" {
		path = "/dev/tty"
	}
	_ = a.programStatusWrite(path, progstatus.WrapTmux(report.Encode()))
}
