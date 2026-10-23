package transcriptindex

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const ToolCallCap = 2 << 10
const ToolResultCap = 4 << 10

type message struct{ Role, Text, Timestamp string }
type metadata struct{ Session, Project string }
type envelope struct {
	Type      string          `json:"type"`
	Session   string          `json:"sessionId"`
	ID        string          `json:"id"`
	CWD       string          `json:"cwd"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
	Payload   json.RawMessage `json:"payload"`
}
type nativeMessage struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Name      string          `json:"name"`
	ToolName  string          `json:"toolName"`
	Arguments json.RawMessage `json:"arguments"`
	Input     json.RawMessage `json:"input"`
	Output    json.RawMessage `json:"output"`
}
type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Arguments json.RawMessage `json:"arguments"`
	Content   json.RawMessage `json:"content"`
}

// parseLine accepts only canonical conversation records. API request copies,
// reasoning, images, signatures, usage, compaction and event mirrors aren't
// conversation messages and never enter the index.
func parseLine(harness string, line []byte, meta *metadata) ([]message, error) {
	var e envelope
	if err := json.Unmarshal(line, &e); err != nil {
		return nil, err
	}
	raw := e.Message
	switch harness {
	case "claude":
		if e.Type != "user" && e.Type != "assistant" {
			return nil, nil
		}
		if e.Session != "" {
			meta.Session = e.Session
		}
		if e.CWD != "" {
			meta.Project = e.CWD
		}
	case "pi":
		if e.Type == "session" {
			meta.Session = e.ID
			meta.Project = e.CWD
			return nil, nil
		}
		if e.Type != "message" {
			return nil, nil
		}
	case "codex":
		// Early native rollouts use an untyped session header and unwrapped
		// conversation items. Their messages have no per-message timestamp.
		if e.Type == "" && e.ID != "" {
			meta.Session = e.ID
			if e.CWD != "" {
				meta.Project = e.CWD
			}
			return nil, nil
		}
		if e.Type == "session_meta" {
			var p struct {
				ID      string `json:"id"`
				Session string `json:"session_id"`
				CWD     string `json:"cwd"`
			}
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				return nil, err
			}
			meta.Session = p.ID
			if meta.Session == "" {
				meta.Session = p.Session
			}
			meta.Project = p.CWD
			return nil, nil
		}
		if e.Type == "turn_context" {
			var p struct {
				CWD string `json:"cwd"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.CWD != "" {
				meta.Project = p.CWD
			}
			return nil, nil
		}
		switch e.Type {
		case "response_item":
			raw = e.Payload
		case "message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output":
			raw = line
		default:
			return nil, nil
		}
	default:
		return nil, nil
	}
	var m nativeMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	var out []message
	add := func(role, text string, cap int) {
		text = strings.TrimSpace(text)
		if cap > 0 {
			text = head(text, cap)
		}
		if text != "" {
			out = append(out, message{role, text, e.Timestamp})
		}
	}
	if harness == "codex" {
		switch m.Type {
		case "function_call", "custom_tool_call":
			args := m.Arguments
			if len(args) == 0 {
				args = m.Input
			}
			add("tool_call", m.Name+" "+argumentText(args), ToolCallCap)
			return out, nil
		case "function_call_output", "custom_tool_call_output":
			add("tool_result", textContent(m.Output), ToolResultCap)
			return out, nil
		case "message":
		default:
			return nil, nil
		}
	}
	if m.Role == "toolResult" {
		add("tool_result", m.ToolName+" "+textContent(m.Content), ToolResultCap)
		return out, nil
	}
	if m.Role != "user" && m.Role != "assistant" {
		return nil, nil
	}
	var plain string
	if json.Unmarshal(m.Content, &plain) == nil {
		add(m.Role, plain, 0)
		return out, nil
	}
	var blocks []block
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return nil, err
	}
	// Text blocks form one message; each tool block is its own searchable unit.
	var texts []string
	for _, b := range blocks {
		switch b.Type {
		case "text", "input_text", "output_text":
			texts = append(texts, b.Text)
		case "tool_use", "toolCall":
			args := b.Input
			if len(args) == 0 {
				args = b.Arguments
			}
			add("tool_call", b.Name+" "+argumentText(args), ToolCallCap)
		case "tool_result":
			add("tool_result", textContent(b.Content), ToolResultCap)
		}
	}
	add(m.Role, strings.Join(texts, "\n"), 0)
	return out, nil
}

func head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
func textContent(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []block
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var texts []string
	for _, b := range blocks {
		switch b.Type {
		case "text", "input_text", "output_text":
			texts = append(texts, b.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// Tool arguments retain commands, paths and patterns, but not binary payloads
// hidden in a tool's image/source/data fields.
func argumentText(raw json.RawMessage) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	// Codex stores function arguments as JSON inside a JSON string.
	// Decode that structured value before scrubbing binary/signature fields.
	if s, ok := v.(string); ok {
		var inner any
		if json.Unmarshal([]byte(s), &inner) == nil {
			switch inner.(type) {
			case map[string]any, []any:
				v = inner
			}
		}
	}
	var clean func(any) any
	clean = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			for k, val := range x {
				switch k {
				case "data", "image", "images", "source", "signature", "thinkingSignature":
					delete(x, k)
				default:
					x[k] = clean(val)
				}
			}
			return x
		case []any:
			for i := range x {
				x[i] = clean(x[i])
			}
			return x
		case string:
			if strings.HasPrefix(x, "data:image/") {
				return ""
			}
		}
		return v
	}
	v = clean(v)
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}
