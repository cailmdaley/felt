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

	"github.com/spf13/cobra"
)

const handoffTailBytes = 256 * 1024

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

func (a *app) runHandoffHook(in io.Reader, out io.Writer) error {
	var input struct {
		Event      string `json:"hook_event_name"`
		Session    string `json:"session_id"`
		Transcript string `json:"transcript_path"`
		Window     any    `json:"context_window"`
	}
	if err := json.NewDecoder(in).Decode(&input); err != nil {
		return err
	}
	if (input.Event != "PostToolUse" && input.Event != "UserPromptSubmit") || input.Session == "" || input.Transcript == "" {
		return nil
	}
	usage, err := readHandoffUsage(input.Transcript, input.Window, a.env.Getenv("SHUTTLE_HANDOFF_CONTEXT_WINDOW"))
	if err != nil || usage == nil {
		return err
	}
	values := []float64{75, 500000, 88, 750000}
	if usage.Harness == "claude" {
		values[1], values[3] = 250000, 350000
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
		line, err := encodeJSONLine(sessionEnvelope{HookSpecificOutput: sessionInner{HookEventName: input.Event, AdditionalContext: handoffNotice(*usage, level)}})
		if err != nil {
			return err
		}
		_, err = io.WriteString(out, line)
		return err
	}
	return nil
}

func handoffNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f
	}
	return 0
}

func readHandoffUsage(file string, window any, override string) (*handoffUsage, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := max(int64(0), info.Size()-handoffTailBytes)
	tail := make([]byte, info.Size()-start)
	n, err := f.ReadAt(tail, start)
	if err != nil && err != io.EOF {
		return nil, err
	}
	tail = tail[:n]
	if start > 0 {
		if i := bytes.IndexByte(tail, '\n'); i >= 0 {
			tail = tail[i+1:]
		}
	}
	lines := bytes.Split(tail, []byte{'\n'})
	for i := len(lines) - 1; i >= 0; i-- {
		var row struct {
			Type    string `json:"type"`
			Message struct {
				Role   string         `json:"role"`
				Model  string         `json:"model"`
				Window any            `json:"context_window"`
				Usage  map[string]any `json:"usage"`
			} `json:"message"`
			Payload struct {
				Type string `json:"type"`
				Info struct {
					Last   map[string]any `json:"last_token_usage"`
					Window float64        `json:"model_context_window"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &row) != nil {
			continue
		}
		if row.Type == "event_msg" && row.Payload.Type == "token_count" {
			if tokens, ok := row.Payload.Info.Last["total_tokens"].(float64); ok {
				return &handoffUsage{tokens, row.Payload.Info.Window, "codex"}, nil
			}
		}
		u := row.Message.Usage
		if row.Type != "assistant" || row.Message.Role != "assistant" {
			continue
		}
		if _, ok := u["input_tokens"].(float64); !ok {
			continue
		}
		total := 0.0
		valid := true
		for _, key := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"} {
			if v := u[key]; v != nil {
				n, ok := v.(float64)
				if !ok || n < 0 {
					valid = false
					break
				}
				total += n
			}
		}
		if !valid {
			continue
		}
		w := window
		if w == nil {
			w = u["context_window"]
		}
		if w == nil {
			w = row.Message.Window
		}
		if w == nil {
			w = override
		}
		size := handoffNumber(w)
		if size <= 0 && strings.Contains(strings.ToLower(row.Message.Model), "[1m]") {
			size = 1000000
		}
		return &handoffUsage{total, size, "claude"}, nil
	}
	return nil, nil
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
