package transcriptindex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// format is how the index reads one harness's transcripts. Every harness in
// internal/harness has one.
type format struct {
	// indexes reports whether a .jsonl file under the harness's root holds a
	// conversation, rather than a copy or a fragment of one.
	indexes func(path string) bool
	// session names the conversation a file holds before any line does.
	session func(path string) string
	// line parses one complete JSONL line into searchable messages.
	line func(line []byte, meta *metadata) ([]message, error)
}

var formats = map[string]format{
	"claude": {indexes: anyFile, session: uuidSuffix, line: native("claude")},
	"codex": {
		indexes: func(path string) bool { return strings.HasPrefix(filepath.Base(path), "rollout-") },
		session: uuidSuffix, line: native("codex"),
	},
	"pi":          {indexes: anyFile, session: uuidSuffix, line: native("pi")},
	"antigravity": {indexes: antigravityTranscript, session: antigravitySession, line: antigravityLine},
}

func parseLine(harness string, line []byte, meta *metadata) ([]message, error) {
	return formats[harness].line(line, meta)
}

func anyFile(string) bool { return true }

// uuidSuffix reads the native UUID rollout, Pi and Claude file names end in.
func uuidSuffix(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if len(name) >= 36 {
		return name[len(name)-36:]
	}
	return name
}

func native(harness string) func([]byte, *metadata) ([]message, error) {
	return func(line []byte, meta *metadata) ([]message, error) { return nativeLine(harness, line, meta) }
}

// The Antigravity CLI writes each conversation's steps to
// brain/<id>/.system_generated/logs/transcript_full.jsonl, and a copy with
// long fields truncated to transcript.jsonl beside it. The index reads the
// full one, and the truncated one only when it stands alone.
func antigravityTranscript(path string) bool {
	if filepath.Base(filepath.Dir(path)) != "logs" {
		return false
	}
	switch filepath.Base(path) {
	case "transcript_full.jsonl":
		return true
	case "transcript.jsonl":
		_, err := os.Stat(filepath.Join(filepath.Dir(path), "transcript_full.jsonl"))
		return err != nil
	}
	return false
}

// antigravitySession is the conversation id, the brain directory's name.
func antigravitySession(path string) string {
	return filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path))))
}

type antigravityStep struct {
	Source    string `json:"source"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
	Content   string `json:"content"`
	ToolCalls []struct {
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	} `json:"tool_calls"`
}

// antigravityLine reads one step. The human's input, the model's replies and
// tool calls, and tool output are searchable; thinking and the system's own
// steps (including messages a hook injected) are not.
func antigravityLine(line []byte, _ *metadata) ([]message, error) {
	var s antigravityStep
	if err := json.Unmarshal(line, &s); err != nil {
		return nil, err
	}
	var out []message
	add := func(role, text string, cap int) {
		text = strings.TrimSpace(text)
		if cap > 0 {
			text = head(text, cap)
		}
		if text != "" {
			out = append(out, message{role, text, s.CreatedAt})
		}
	}
	switch {
	case s.Type == "USER_INPUT" && s.Source == "USER_EXPLICIT":
		add("user", userRequest(s.Content), 0)
	case s.Type == "PLANNER_RESPONSE" && s.Source == "MODEL":
		add("assistant", s.Content, 0)
		for _, c := range s.ToolCalls {
			add("tool_call", c.Name+" "+argumentText(c.Args), ToolCallCap)
		}
	case s.Type == "GENERIC" && s.Source == "MODEL":
		add("tool_result", s.Content, ToolResultCap)
	}
	return out, nil
}

// userRequest is what the human typed: the text inside <USER_REQUEST>, which
// agy follows with metadata of its own (the time, a settings change).
func userRequest(content string) string {
	_, rest, ok := strings.Cut(content, "<USER_REQUEST>")
	if !ok {
		return content
	}
	request, _, _ := strings.Cut(rest, "</USER_REQUEST>")
	return request
}
