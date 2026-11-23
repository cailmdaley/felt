package shuttlecli

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/spf13/cobra"
)

const (
	handoffTailBytes    = 256 * 1024
	handoffMaxTailBytes = 16 * 1024 * 1024
)

// handoffUsage is the latest request's context, and the claim file's contents.
type handoffUsage struct {
	Tokens        float64 `json:"tokens"`
	ContextWindow float64 `json:"contextWindow"`
	Harness       string  `json:"harness"`
}

func (a *app) hookHandoffCmd() *cobra.Command {
	return &cobra.Command{Use: "handoff", Short: "Offer a one-shot context-budget handoff reminder", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		// Advisory only: malformed input, missing transcripts and unwritable state
		// must never fail an agent event.
		_ = a.runHandoffHook(a.env.Stdin, a.env.Stdout)
		return nil
	}}
}

// runHandoffHook nudges a session once per level as its context crosses two
// thresholds. Codex shares Pi's defaults and wording from
// claude-plugin/hooks/lib/handoff.mjs. Claude Code is nudged only as a Shuttle
// worker (SHUTTLE_FIBER_PATH set), at 350k and 400k tokens, toward `shuttle
// handoff`; any other Claude session returns before its transcript is read.
func (a *app) runHandoffHook(in io.Reader, out io.Writer) error {
	var input struct {
		Event      string `json:"hook_event_name"`
		Session    string `json:"session_id"`
		Transcript string `json:"transcript_path"`
	}
	if err := json.NewDecoder(in).Decode(&input); err != nil {
		return err
	}
	if (input.Event != "PostToolUse" && input.Event != "UserPromptSubmit") || input.Session == "" || input.Transcript == "" {
		return nil
	}
	values := []float64{75, 500000, 88, 750000}
	read := readCodexUsage
	if harness.ForTranscript(a.env, input.Transcript) == "claude" {
		if a.env.Getenv("SHUTTLE_FIBER_PATH") == "" {
			return nil
		}
		values = []float64{75, 350000, 88, 400000}
		read = readClaudeUsage
	}
	usage, err := read(input.Transcript)
	if err != nil || usage == nil {
		return err
	}
	for i, key := range []string{"SHUTTLE_HANDOFF_PCT", "SHUTTLE_HANDOFF_TOKENS", "SHUTTLE_HANDOFF_HARD_PCT", "SHUTTLE_HANDOFF_HARD_TOKENS"} {
		if raw, ok := a.env.LookupEnv(key); ok {
			v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || (i%2 == 0 && v > 100) {
				return nil
			}
			values[i] = v
		}
	}
	if values[2] < values[0] || values[3] < values[1] {
		return nil
	}
	root := a.env.Getenv("SHUTTLE_HANDOFF_STATE_DIR")
	if root == "" {
		home, _ := a.env.UserHomeDir()
		root = filepath.Join(home, ".shuttle", "handoff")
	}
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(usage.Harness+":"+input.Session)))
	dir := filepath.Join(root, key)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	for i, level := range []string{"soft", "hard"} {
		threshold := values[2*i+1]
		if usage.ContextWindow > 0 {
			threshold = math.Min(threshold, usage.ContextWindow*values[2*i]/100)
		}
		if usage.Tokens < threshold {
			continue
		}
		// An exclusive create is the claim: concurrent hooks cannot both emit
		// a level, and a resumed session keeps the levels it already got.
		claim, err := os.OpenFile(filepath.Join(dir, level), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		err = json.NewEncoder(claim).Encode(usage)
		closeErr := claim.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		notice := handoffNotice(*usage, level)
		if usage.Harness == "claude" {
			notice = claudeHandoffNotice(usage.Tokens, threshold, level)
		}
		line, err := encodeJSONLine(sessionEnvelope{HookSpecificOutput: sessionInner{HookEventName: input.Event, AdditionalContext: notice}})
		if err != nil {
			return err
		}
		_, err = io.WriteString(out, line)
		return err
	}
	return nil
}

// transcriptTail is the complete lines in the last window bytes of file,
// newest last, and whether that is the whole file; a cut first line is dropped.
func transcriptTail(file string, window int64) ([][]byte, bool, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	start := max(int64(0), info.Size()-window)
	tail := make([]byte, info.Size()-start)
	n, err := f.ReadAt(tail, start)
	if err != nil && err != io.EOF {
		return nil, false, err
	}
	tail = tail[:n]
	if start > 0 {
		if i := bytes.IndexByte(tail, '\n'); i >= 0 {
			tail = tail[i+1:]
		}
	}
	return bytes.Split(tail, []byte{'\n'}), start == 0, nil
}

// readCodexUsage is the newest `token_count` event in a Codex rollout's tail:
// the latest request's own tokens, not the cumulative total. A tail without
// one is nil, never a whole-history scan.
func readCodexUsage(file string) (*handoffUsage, error) {
	lines, _, err := transcriptTail(file, handoffTailBytes)
	if err != nil {
		return nil, err
	}
	for i := len(lines) - 1; i >= 0; i-- {
		var row struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
				Info struct {
					Last   map[string]any `json:"last_token_usage"`
					Window float64        `json:"model_context_window"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &row) != nil || row.Type != "event_msg" || row.Payload.Type != "token_count" {
			continue
		}
		if tokens, ok := row.Payload.Info.Last["total_tokens"].(float64); ok {
			return &handoffUsage{tokens, row.Payload.Info.Window, "codex"}, nil
		}
	}
	return nil, nil
}

// readClaudeUsage is the prompt size of the newest main-thread assistant turn
// in a Claude Code transcript's tail: input plus cache reads plus cache writes.
// Sidechain and `<synthetic>` records carry no prompt of the main thread; a
// compaction newer than any turn leaves the size unknown until the next turn.
// Claude transcripts record no window, so only the token thresholds apply. As
// in the daemon's Shuttle.TranscriptUsage, a 256 KiB tail that holds neither
// widens fourfold up to 16 MiB, so one large tool result does not hide the turn.
func readClaudeUsage(file string) (*handoffUsage, error) {
	for window := int64(handoffTailBytes); ; window *= 4 {
		lines, whole, err := transcriptTail(file, window)
		if err != nil {
			return nil, err
		}
		usage, found := claudeUsageIn(lines)
		if found || whole || window >= handoffMaxTailBytes {
			return usage, nil
		}
	}
}

// claudeUsageIn is the newest reading in lines, and whether lines held a
// reading or a compaction.
func claudeUsageIn(lines [][]byte) (*handoffUsage, bool) {
	for i := len(lines) - 1; i >= 0; i-- {
		var row struct {
			Type      string `json:"type"`
			Subtype   string `json:"subtype"`
			Sidechain bool   `json:"isSidechain"`
			Message   struct {
				Model string `json:"model"`
				Usage *struct {
					Input      float64 `json:"input_tokens"`
					CacheRead  float64 `json:"cache_read_input_tokens"`
					CacheWrite float64 `json:"cache_creation_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &row) != nil || row.Sidechain {
			continue
		}
		if row.Type == "system" && row.Subtype == "compact_boundary" {
			return nil, true
		}
		if row.Type == "assistant" && row.Message.Model != "<synthetic>" && row.Message.Usage != nil {
			u := row.Message.Usage
			return &handoffUsage{u.Input + u.CacheRead + u.CacheWrite, 0, "claude"}, true
		}
	}
	return nil, false
}

// claudeHandoffNotice states a Claude worker's context and threshold, then the
// next step.
func claudeHandoffNotice(tokens, threshold float64, level string) string {
	limit := strconv.FormatFloat(math.Round(threshold/100)/10, 'f', -1, 64) + "k"
	if level == "hard" {
		return fmt.Sprintf("Context is ~%.0fk tokens (hard threshold %s). Finish your current step, update `## Status`, commit, and run `shuttle handoff`.", tokens/1000, limit)
	}
	return fmt.Sprintf("Context is ~%.0fk tokens (soft threshold %s). Look for a natural point to update `## Status` and run `shuttle handoff`.", tokens/1000, limit)
}

func handoffNotice(usage handoffUsage, level string) string {
	percent := "window unknown"
	if usage.ContextWindow > 0 {
		percent = fmt.Sprintf("%.1f%% of the window", 100*usage.Tokens/usage.ContextWindow)
	}
	tokens := strconv.FormatFloat(math.Round(usage.Tokens), 'f', 0, 64)
	for i := len(tokens) - 3; i > 0; i -= 3 {
		tokens = tokens[:i] + "," + tokens[i:]
	}
	text := fmt.Sprintf("Context is at %s tokens (%s). Bring your handoff surfaces current now — your fiber's `## Status` (and report, if you keep one), commits — then hand off: a shuttle worker runs `shuttle handoff <fiber>`; a confer worker ends its reply with `HANDOFF: <fiber or none>` and stops; an interactive session tells the human it's time to hand off.", tokens, percent)
	if level == "hard" {
		text = "HARD CONTEXT LIMIT: stop taking on work; finish only the durable handoff. " + text
	}
	return text
}
