package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/cailmdaley/felt/internal/messaging"
)

// The activity hook also offers peer messages on hooks that add context without
// continuing a stopped turn.
func (a *app) runEventAndMessageHook(r io.Reader, w io.Writer) error {
	b, err := io.ReadAll(io.LimitReader(r, 4<<20+1))
	if err != nil || len(b) > 4<<20 {
		return nil
	}
	var input eventHookInput
	if json.NewDecoder(bytes.NewReader(b)).Decode(&input) != nil {
		return nil
	}
	if input.Harness == "" {
		input.Harness = a.env.Getenv("SHUTTLE_HOOK_HARNESS")
	}
	return a.handleHook(input, func(text string) error {
		return json.NewEncoder(w).Encode(sessionEnvelope{HookSpecificOutput: sessionInner{HookEventName: input.HookEventName, AdditionalContext: text}})
	})
}

// handleHook records one Claude-shaped hook event, registers its session's
// mailbox and offers queued context through emit, which writes it in the
// envelope the harness reads.
func (a *app) handleHook(input eventHookInput, emit func(string) error) error {
	harness := a.messageHookHarness(input)
	// Only Claude child lifecycle/tool events would impersonate the parent's
	// turn. Other harness events and SendUserFile retain their event trail.
	if harness == "claude" && input.AgentID != "" {
		if input.ToolName == "SendUserFile" && input.HookEventName == "PreToolUse" {
			input.Harness = harness
			a.recordEvent(input)
		}
		return nil
	}
	a.reportProgramStatus(input)
	a.recordEvent(input)
	if input.SessionID == "" {
		return nil
	}
	// A subagent's hooks are not its parent's lifecycle. SubagentStop can arrive
	// late, and must not overwrite or resurrect the parent's registration after
	// a resume or SessionEnd; a subagent's tool hook must not consume mail
	// addressed to its parent.
	if input.HookEventName == "SubagentStop" {
		return nil
	}
	if input.AgentID != "" || harness == "" {
		return nil
	}
	if input.NativePID > 0 && !messaging.HookPIDIsAncestor(input.NativePID) {
		return nil
	}
	if _, ok := eventTypes[input.HookEventName]; !ok && input.HookEventName != "PreInvocation" {
		return nil
	}
	host, err := a.resolveOwnHost("")
	if err != nil {
		return nil
	}
	digest := ""
	var acknowledgeDigest func()
	writeContext := func(text string) error {
		err := emit(text)
		if err == nil && acknowledgeDigest != nil {
			acknowledgeDigest()
		}
		return err
	}
	if input.HookEventName == "UserPromptSubmit" && a.env.Getenv("SHUTTLE_BOARD") != "off" {
		input.Harness = harness
		a.recordHumanPrompt(input)
		digest, acknowledgeDigest = a.boardDigest(harness, input.SessionID)
	}
	ambient := a.ambientSessionContext(input, host)
	standaloneContext := combineHookContext(digest, ambient)
	if a.env.Getenv("SHUTTLE_MESSAGES") == "off" {
		if standaloneContext != "" {
			return writeContext(standaloneContext)
		}
		return nil
	}
	// Pi's extension runs in the harness process and names it; Claude Code and
	// Codex run this hook as a child, possibly through a shell.
	receiver := input.NativePID
	if harness != "pi" || receiver <= 0 {
		receiver = messaging.HookReceiverPID()
	}
	if messaging.RegisterMailbox(a.env, harness, input.SessionID, host, input.CWD, receiver, input.HookEventName != "SessionEnd") != nil {
		if standaloneContext != "" {
			return writeContext(standaloneContext)
		}
		return nil
	}
	if harness != "pi" {
		input.Harness = harness
		state := turnMailboxState(input)
		if state != "" {
			_ = messaging.SetMailboxState(a.env, harness, input.SessionID, host, state)
		}
	}
	if harness == "pi" && input.NativeSocket != "" {
		_ = messaging.RegisterPiNative(a.env, input.SessionID, host, input.CWD, input.NativeSocket, input.TranscriptPath, input.NativePID, input.HookEventName != "SessionEnd")
	}
	if harness == "claude" {
		_ = messaging.RegisterClaudeNative(a.env, input.SessionID, host, input.CWD,
			a.env.Getenv("CLAUDE_CODE_MESSAGING_SOCKET"), input.TranscriptPath,
			input.HookEventName != "SessionEnd")
	}
	offer := input.HookEventName == "UserPromptSubmit" || harness == "claude" && input.HookEventName == "PostToolUse" || harness == "codex" && (input.HookEventName == "SessionStart" || input.HookEventName == "PreToolUse" || input.HookEventName == "PostToolUse") || harness == "antigravity" && (input.HookEventName == "SessionStart" || input.HookEventName == "PreInvocation")
	wrote := false
	if offer {
		var outputErr error
		_ = messaging.OfferMailbox(a.env, harness, input.SessionID, host, func(requests []messaging.Request) error {
			var context strings.Builder
			for _, r := range requests {
				fmt.Fprintf(&context, "%s\n\n", messaging.Labeled(r))
			}
			if digest != "" {
				context.WriteString("\n[Shuttle family board digest]\n")
				context.WriteString(digest)
			}
			if ambient != "" {
				context.WriteString("\n")
				context.WriteString(ambient)
			}
			wrote = true
			outputErr = writeContext(context.String())
			return outputErr
		})
		if wrote {
			return outputErr
		}
	}
	if !wrote && standaloneContext != "" {
		return writeContext(standaloneContext)
	}
	return nil
}

func turnMailboxState(input eventHookInput) string {
	switch input.HookEventName {
	case "SessionStart":
		return "idle"
	case "UserPromptSubmit", "PreInvocation", "PreToolUse", "PostToolUse":
		return "working"
	case "StopFailure":
		return "idle"
	case "Stop":
		if input.Harness != "claude" && countBackgroundTasks(input.BackgroundTasks) > 0 {
			return "working"
		}
		return "idle"
	default:
		return ""
	}
}

// messageHookHarness is the harness a hook payload names. Every shim names it;
// a payload without one comes from a shim installed before they did, which a
// running session keeps until it restarts and a Codex cache keeps until
// `felt setup codex`, so it is inferred from the transcript path and Codex's
// payload fields.
func (a *app) messageHookHarness(input eventHookInput) string {
	if harness.Known(input.Harness) {
		return input.Harness
	}
	if harness.Normalize(a.harnessFor(input.TranscriptPath)) == "claude" {
		return "claude"
	}
	if harness.Normalize(a.harnessFor(input.TranscriptPath)) != "codex" {
		return ""
	}
	if input.Model != "" || strings.TrimSpace(a.env.Getenv("CODEX_THREAD_ID")) == input.SessionID || strings.Contains(filepath.ToSlash(input.TranscriptPath), "/.codex/") {
		return "codex"
	}
	return ""
}
