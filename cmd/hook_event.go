package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// ----------------------------------------------------------------------------
// `felt hook event` — the host-local activity stream
// ----------------------------------------------------------------------------
//
// Appends one JSONL line per harness hook event to the stream the shuttle
// daemon tails (see cmd/shuttle_events.go for the path and the write gate).
// Two readers consume it, and only these fields:
//
//   - lib/shuttle/waiting_tracker.ex — `type`, `tmuxSession`, `timestamp`,
//     plus the two fields that say whether an idle-looking session is really
//     waiting on a HUMAN: `notificationKind` and `backgroundTasks`.
//     Last-event-wins per session, so duplicate lines are idempotent.
//   - lib/shuttle/sent_files.ex — `tool == "SendUserFile"`, `toolInput.files`,
//     `sessionId`, `cwd`, `timestamp`, `tmuxSession`; deduped by path.
//
// Everything else on the line (`id`, `harness`, `originName`) is written for
// operators reading the raw stream and for readers not yet written.
//
// The contract with the harness is the same as runPostToolHook's: print
// nothing, exit 0, always. A tracking hook that can fail a tool call is worse
// than no tracking hook.

var hookEventCmd = &cobra.Command{
	Use:   "event",
	Short: "Record one harness hook event on the host-local activity stream",
	Long: `Reads any hook payload from stdin and appends one JSON line to the
host-local event stream (SHUTTLE_EVENTS_FILE, else $SHUTTLE_DATA_DIR/events.jsonl,
else ~/.shuttle/events.jsonl). The shuttle daemon tails that stream to rank
in-flight workers by idle time and to render the sent-files trail on each card.

Writes only when the stream's parent directory already exists — the daemon's
state directory is the opt-in. An explicit SHUTTLE_EVENTS_FILE overrides that
and creates the directory; SHUTTLE_EVENTS=off disables recording outright.

Prints nothing and exits 0 on every path, including malformed input.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runEventHook(os.Stdin)
	},
}

// eventTypes maps harness hook names to the snake_case `type` the Elixir
// readers switch on. An unlisted name records nothing — the stream carries
// activity, not every envelope the harness invents.
var eventTypes = map[string]string{
	"PreToolUse":       "pre_tool_use",
	"PostToolUse":      "post_tool_use",
	"Stop":             "stop",
	"SubagentStop":     "subagent_stop",
	"SessionStart":     "session_start",
	"SessionEnd":       "session_end",
	"UserPromptSubmit": "user_prompt_submit",
	"Notification":     "notification",
}

// eventMaxLineBytes bounds one encoded line. Past it, `toolInput` is replaced
// by the file paths it carried plus a `truncated` marker — a Write of a large
// file would otherwise park the whole body in the stream, which is what grew
// the maintainer's file to 23 MB. Both readers keep working: WaitingTracker
// never looks at toolInput, and SentFiles needs only `files`, which survives.
const eventMaxLineBytes = 8 << 10

// Injection points for the golden-file test: production never reassigns them.
var (
	eventNow  = time.Now
	eventRand = func() int { return rand.Intn(32768) }
)

type eventHookInput struct {
	HookEventName  string `json:"hook_event_name"`
	SessionID      string `json:"session_id"`
	CWD            string `json:"cwd"`
	TranscriptPath string `json:"transcript_path"`
	ToolName       string `json:"tool_name"`
	Prompt         string `json:"prompt"`
	// Notification's own discriminator: `idle_prompt`, `permission_prompt`,
	// `elicitation_dialog`, … The harness says WHY it is notifying, and only
	// `idle_prompt` means "nobody has typed in a while" rather than "I am
	// blocked on you".
	NotificationType string `json:"notification_type"`
	// Stop's and SubagentStop's own account of what they are leaving running:
	// the harness's whole background-task registry, not only detached Bash. A
	// turn that ends with work outstanding is not idle — it is waiting on
	// itself. Held RAW and counted tolerantly: this is the only
	// shape-constrained field on the payload, and a harness that reshapes it
	// must not take every `stop` line off the stream with it.
	BackgroundTasks json.RawMessage `json:"background_tasks"`
	ToolInput       json.RawMessage `json:"tool_input"`
}

// eventLine is the wire shape, in wire order. Field set and names are pinned
// by cmd/testdata/events_golden.jsonl, which the Elixir readers parse in
// test/shuttle/events_parity_test.exs — change either side and that test fails.
type eventLine struct {
	ID          string `json:"id"`
	Timestamp   int64  `json:"timestamp"`
	Type        string `json:"type"`
	SessionID   string `json:"sessionId"`
	CWD         string `json:"cwd"`
	TmuxSession string `json:"tmuxSession"`
	Harness     string `json:"harness"`
	OriginName  string `json:"originName"`
	// Machine marks a prompt the harness injected rather than one a person
	// typed — see machinePrompt. Omitted when false, so an ordinary event's
	// line is byte-identical to what it has always been.
	Machine bool `json:"machine,omitempty"`
	// NotificationKind carries the harness's `notification_type` through. The
	// idle timeout and a permission request arrive as the same event `type`,
	// and this is the only thing that tells them apart.
	NotificationKind string `json:"notificationKind,omitempty"`
	// BackgroundTasks is how much work a `stop` or `subagent_stop` left
	// running — see countBackgroundTasks. Zero is the
	// overwhelmingly common case and is omitted, so an ordinary line is
	// byte-identical to what it has always been.
	BackgroundTasks int             `json:"backgroundTasks,omitempty"`
	Tool            string          `json:"tool,omitempty"`
	ToolInput       json.RawMessage `json:"toolInput,omitempty"`
}

// machinePromptPrefixes are the wrappers the harness puts around a prompt it
// injects itself: a finished task's notification, another session's message, a
// system notice. Each fires UserPromptSubmit exactly as a person typing does.
//
// PREFIXES, not a search. An injected prompt is a wrapper around its payload,
// so the marker is always at the front; matching anywhere in the text would
// demote a real message that quoted one of these.
// Measured against the recorded history when a cinnabar spine turned out to be
// claiming a message nobody wrote: of ~2400 unflagged prompts on this host, 935
// were injections. The `<task-notification` / `<teammate-message` pair caught
// most; the rest were the four groups added below, and a dispatched worker's
// opening prompt was the single largest ongoing leak.
var machinePromptPrefixes = []string{
	"<task-notification",
	"<teammate-message",
	"Another Claude session sent a message:",
	"[SYSTEM NOTIFICATION",
	"<system-notification",
	// The dispatcher's own preamble. All three variants (fiber, ad-hoc role,
	// scheduled role — lib/shuttle/dispatcher.ex) open with this clause, so the
	// shared head is the anchor rather than any one of the three.
	"The orchestration system Shuttle dispatched you",
	// A slash command expands into as many as three prompt submissions. The
	// `<command-name>` one IS the human's act and stays attention; these two are
	// the harness's wrappers around it, and counting them made one keystroke
	// draw three spines.
	"<local-command-caveat",
	"<local-command-stdout",
	// An interrupt is a human ACT but not a human MESSAGE: there are no words
	// behind it for a tooltip to show, and a spine is a mark that says "you
	// spoke here".
	"[Request interrupted",
	// The /loop skill's injected tick.
	"# Autonomous loop tick",
	// The dispatcher's other two injected openings: a resumed session's
	// wake-up prompt and a capture session's framing (lib/shuttle/dispatcher.ex
	// render_resume_prompt/2, render_capture_prompt/2). Same module, same
	// here-string delivery, same UserPromptSubmit — no human typed either.
	"Shuttle resumed your previous session",
	"Shuttle capture session.",
}

// machinePrompt reports whether a prompt was injected rather than typed.
//
// This is the ONLY place the question can be answered: the daemon receives an
// event with no prompt text in it, and a daemon that sniffed content to guess
// would be inventing a fact it cannot know. So the writer decides and the
// reader trusts the flag (lib/shuttle/activity.ex buckets a flagged prompt as
// agent activity instead of as your attention).
func machinePrompt(prompt string) bool {
	trimmed := strings.TrimLeft(prompt, " \t\r\n")
	for _, prefix := range machinePromptPrefixes {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

// countBackgroundTasks counts what a turn is leaving running. The harness has
// already filtered the registry to entries that are running or pending, so the
// length is the answer — including the kinds that are alive by design for the
// session's whole life (an MCP monitor, an in-process teammate). Those ARE
// something the session is waiting on, and the reader's own bound is what keeps
// a long-lived one from silencing a lane; a list of harness-internal type names
// here would drift with every kind Claude Code adds, for no coverage the bound
// does not already give.
//
// TOLERANT BY CONSTRUCTION. Every unexpected shape — an object instead of an
// array, a bare count, an entry that is not an object — yields zero rather than
// an error, because the caller's error path drops the WHOLE LINE. A harness
// that reshapes this key would otherwise take every `stop` off the stream, and
// a stream with no stops reads as a fleet that never finishes a turn.
func countBackgroundTasks(raw json.RawMessage) int {
	if len(bytes.TrimSpace(raw)) == 0 {
		return 0
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return 0
	}
	return len(entries)
}

// runEventHook decodes the payload, renders the line, and appends it. Every
// failure — unparseable stdin, unknown event name, disabled stream, unwritable
// file — returns nil without output.
func runEventHook(stdin io.Reader) error {
	line, ok := renderEventLine(stdin)
	if !ok {
		return nil
	}
	path, enabled := eventsSink()
	if !enabled {
		return nil
	}
	_ = appendEventLine(path, line)
	return nil
}

// renderEventLine builds the newline-terminated JSONL line for a payload, or
// ok=false when the payload records nothing.
func renderEventLine(stdin io.Reader) (string, bool) {
	var input eventHookInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return "", false
	}
	eventType, known := eventTypes[input.HookEventName]
	if !known {
		return "", false
	}

	sessionID := input.SessionID
	if sessionID == "" {
		sessionID = "unknown"
	}
	timestamp := eventNow().UnixMilli()
	origin, err := resolveOwnHost("")
	if err != nil {
		origin = ""
	}

	line := eventLine{
		ID:          sessionID + "-" + strconv.FormatInt(timestamp, 10) + "-" + strconv.Itoa(eventRand()),
		Timestamp:   timestamp,
		Type:        eventType,
		SessionID:   sessionID,
		CWD:         input.CWD,
		TmuxSession: currentTmuxSession(),
		Harness:     harnessFor(input.TranscriptPath),
		OriginName:  origin,
	}
	if eventType == "user_prompt_submit" && machinePrompt(input.Prompt) {
		line.Machine = true
	}
	if eventType == "notification" {
		line.NotificationKind = input.NotificationType
	}
	if eventType == "stop" || eventType == "subagent_stop" {
		line.BackgroundTasks = countBackgroundTasks(input.BackgroundTasks)
	}
	if input.ToolName != "" {
		line.Tool = input.ToolName
		// PreToolUse is the event's one copy of the payload. PostToolUse still
		// carries the tool name (which closes activity spans), but repeating the
		// whole input doubles sensitive paths/content in the shared stream and
		// makes a cross-harness event count look like two tool observations.
		if eventType != "post_tool_use" {
			line.ToolInput = normalizeToolInput(input.ToolInput)
		}
	}

	encoded, err := encodeEventLine(line)
	if err != nil {
		return "", false
	}
	if len(encoded) > eventMaxLineBytes && line.ToolInput != nil {
		line.ToolInput = trimToolInput(line.ToolInput)
		encoded, err = encodeEventLine(line)
		if err != nil {
			return "", false
		}
	}
	return encoded, true
}

// encodeEventLine renders one compact, newline-terminated line with `<>&` left
// alone (Go escapes them by default; jq did not, and the stream is read by
// humans as often as by the daemon).
func encodeEventLine(line eventLine) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(line); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// normalizeToolInput passes `tool_input` through, adding the normalized
// `file_path` key the sent-files reader and the raw-stream reader both expect.
// The precedence — file_path, path, filePath, files[0] — is the one the bash
// hook expressed in jq; it is load-bearing and must not drift.
//
// A payload with no `tool_input` records `null`, matching jq's `.tool_input //
// null`: the field's presence tracks the tool's, not the input's.
func normalizeToolInput(raw json.RawMessage) json.RawMessage {
	if len(bytes.TrimSpace(raw)) == 0 {
		return json.RawMessage("null")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		// Not an object (null, array, scalar) — nothing to normalize against.
		return raw
	}
	fp := extractFilePath(obj)
	if fp == "" {
		return raw
	}
	encoded, err := json.Marshal(fp)
	if err != nil {
		return raw
	}
	obj["file_path"] = encoded
	merged, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return merged
}

// extractFilePath resolves the first non-empty string among file_path, path,
// filePath, and files[0]. Empty string means "no usable path".
func extractFilePath(obj map[string]json.RawMessage) string {
	for _, key := range []string{"file_path", "path", "filePath"} {
		var s string
		if err := json.Unmarshal(obj[key], &s); err == nil && s != "" {
			return s
		}
	}
	var files []json.RawMessage
	if err := json.Unmarshal(obj["files"], &files); err == nil && len(files) > 0 {
		var s string
		if err := json.Unmarshal(files[0], &s); err == nil && s != "" {
			return s
		}
	}
	return ""
}

// trimToolInput reduces an oversized tool input to what a reader actually
// consumes — `files` (SentFiles) and the normalized `file_path` — plus
// `truncated: true` so nobody mistakes the remainder for the whole payload.
func trimToolInput(raw json.RawMessage) json.RawMessage {
	trimmed := map[string]json.RawMessage{"truncated": json.RawMessage("true")}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err == nil && obj != nil {
		if v, ok := obj["files"]; ok {
			trimmed["files"] = v
		}
		if v, ok := obj["file_path"]; ok {
			trimmed["file_path"] = v
		}
	}
	out, err := json.Marshal(trimmed)
	if err != nil {
		return json.RawMessage(`{"truncated":true}`)
	}
	return out
}

// currentTmuxSession names the tmux session this hook fired inside — the
// carrier of the fiber ULID for every dispatched worker, so it is the join key
// between the stream and the board.
//
// SHUTTLE_TMUX_SESSION wins when set (the dispatcher knows the name it chose,
// and reading it costs nothing). Otherwise ask tmux, but only inside tmux and
// only for a second: this runs on the PreToolUse hot path, and a wedged tmux
// server must not stall the agent.
func currentTmuxSession() string {
	if s := strings.TrimSpace(os.Getenv("SHUTTLE_TMUX_SESSION")); s != "" {
		return s
	}
	if os.Getenv("TMUX") == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "display-message", "-p", "#S").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
