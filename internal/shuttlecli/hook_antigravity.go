package shuttlecli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// ----------------------------------------------------------------------------
// `shuttle hook antigravity` — the Antigravity CLI's hooks, in Shuttle's shape
// ----------------------------------------------------------------------------
//
// agy's hooks carry camelCase payloads and read a JSON answer on stdout. This
// verb translates each one into the Claude-shaped event `shuttle hook event`
// handles, with harness "antigravity", and answers in agy's shape:
//
//   - SessionStart starts the session (its line on the stream reports the
//     conversation id the daemon binds the worker to).
//   - PreInvocation before a turn's first model call is a prompt
//     (UserPromptSubmit), unless agy started the turn itself after a
//     background command ended; every PreInvocation offers queued context,
//     injected as a system message.
//   - Stop ends the turn; with fullyIdle false a background command is still
//     running and the agent wakes itself when it ends, so the turn stays open.
//   - PreToolUse and PostToolUse are activity. agy reads any JSON a PreToolUse
//     hook prints as a decision, and `{}` denies the tool, so tool events
//     print nothing.

type antigravityHookInput struct {
	HookEventName  string          `json:"hookEventName"`
	ConversationID string          `json:"conversationId"`
	CWD            string          `json:"cwd"`
	TranscriptPath string          `json:"transcriptPath"`
	ModelName      string          `json:"modelName"`
	LastUserInput  string          `json:"lastUserInput"`
	InvocationNum  int             `json:"invocationNum"`
	FullyIdle      *bool           `json:"fullyIdle"`
	ToolCall       antigravityTool `json:"toolCall"`
}

type antigravityTool struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// antigravityInjection is the answer that adds a system message to the
// conversation before the model runs.
type antigravityInjection struct {
	InjectSteps []antigravityStep `json:"injectSteps"`
}

type antigravityStep struct {
	SystemMessage struct {
		SystemMessage string `json:"systemMessage"`
	} `json:"systemMessage"`
}

func (a *app) hookAntigravityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "antigravity",
		Short: "Translate one Antigravity CLI hook into a Shuttle event",
		Long: `Reads one Antigravity CLI (agy) hook payload from stdin, records it on the
host-local event stream as ` + "`shuttle hook event`" + ` records Claude Code's hooks,
and registers the conversation for messages. On SessionStart and PreInvocation
it prints queued context as {"injectSteps":[...]}; on every other event it
prints nothing, since agy reads a tool hook's JSON as a decision. Exits 0 on
every path. The felt plugin for agy installs this hook.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runAntigravityHook(a.env.Stdin, a.env.Stdout)
		},
	}
}

func (a *app) runAntigravityHook(r io.Reader, w io.Writer) error {
	b, err := io.ReadAll(io.LimitReader(r, 4<<20+1))
	if err != nil || len(b) > 4<<20 {
		return nil
	}
	var payload antigravityHookInput
	if json.NewDecoder(bytes.NewReader(b)).Decode(&payload) != nil || payload.ConversationID == "" {
		return nil
	}
	input, ok := a.antigravityEvent(payload)
	if !ok {
		return nil
	}
	return a.handleHook(input, func(text string) error {
		if payload.HookEventName != "SessionStart" && payload.HookEventName != "PreInvocation" {
			return nil
		}
		var step antigravityStep
		step.SystemMessage.SystemMessage = text
		return json.NewEncoder(w).Encode(antigravityInjection{InjectSteps: []antigravityStep{step}})
	})
}

// antigravityEvent is the Claude-shaped event an agy hook stands for, or
// ok=false for one Shuttle does not follow.
func (a *app) antigravityEvent(p antigravityHookInput) (eventHookInput, bool) {
	input := eventHookInput{
		HookEventName:  p.HookEventName,
		Harness:        "antigravity",
		SessionID:      p.ConversationID,
		CWD:            p.CWD,
		TranscriptPath: p.TranscriptPath,
		Model:          p.ModelName,
	}
	switch p.HookEventName {
	case "SessionStart":
	case "PreInvocation":
		if p.InvocationNum == 0 && a.antigravityTurnStarted(p.ConversationID, p.LastUserInput) {
			input.HookEventName = "UserPromptSubmit"
			input.Prompt = p.LastUserInput
		}
	case "PreToolUse", "PostToolUse":
		input.ToolName = p.ToolCall.Name
		input.ToolInput = p.ToolCall.Args
	case "Stop":
		left := p.FullyIdle != nil && !*p.FullyIdle
		if left {
			input.BackgroundTasks = json.RawMessage(`[{"fullyIdle":false}]`)
		}
		a.antigravityTurnEnded(p.ConversationID, p.LastUserInput, left)
	default:
		return eventHookInput{}, false
	}
	return input, true
}

// agy starts a turn on its own when a background command a turn left running
// ends, repeating that turn's input. A conversation's turn state remembers
// the input its last turn started from and whether its last Stop left work
// running, so a turn that repeats the input after such a Stop is agy's own,
// and any other is a prompt.

// antigravityTurnStarted reports whether a turn starting from text is a
// prompt rather than agy waking itself, and records the turn.
func (a *app) antigravityTurnStarted(conversation, text string) bool {
	path, ok := a.antigravityTurnPath(conversation)
	if !ok {
		return true
	}
	previous, err := os.ReadFile(path)
	self := err == nil && string(previous) == "running\n"+text
	a.writeAntigravityTurn(path, "open", text)
	return !self
}

// antigravityTurnEnded records the end of a turn, and whether it left work
// running.
func (a *app) antigravityTurnEnded(conversation, text string, running bool) {
	path, ok := a.antigravityTurnPath(conversation)
	if !ok {
		return
	}
	state := "idle"
	if running {
		state = "running"
	}
	a.writeAntigravityTurn(path, state, text)
}

func (a *app) antigravityTurnPath(conversation string) (string, bool) {
	dir, err := shuttle.DataDir(a.env)
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256([]byte(conversation))
	return filepath.Join(dir, "antigravity", hex.EncodeToString(sum[:])+".turn"), true
}

func (a *app) writeAntigravityTurn(path, state, text string) {
	if os.MkdirAll(filepath.Dir(path), 0o700) == nil {
		_ = atomicfile.Write(path, []byte(state+"\n"+text), 0o600)
	}
}
