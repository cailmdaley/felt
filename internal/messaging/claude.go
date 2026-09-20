package messaging

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
)

type claudeAdapter struct{}

func (claudeAdapter) discover(ctx context.Context, host string) ([]Session, error) {
	hookSessions := MailboxSessions("claude", host)
	for i := range hookSessions {
		if claudeNativeAvailable(hookSessions[i].ID, host) {
			hookSessions[i].Capabilities = append(hookSessions[i].Capabilities, "wake")
		}
	}
	cmd := exec.CommandContext(ctx, "claude", "agents", "--json")
	var out cappedBuffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return hookSessions, err
	}
	b := out.Bytes()
	var raw any
	if json.Unmarshal(b, &raw) != nil {
		return hookSessions, fmt.Errorf("claude agents returned invalid JSON")
	}
	var rows []any
	switch x := raw.(type) {
	case []any:
		rows = x
	case map[string]any:
		if y, ok := x["sessions"].([]any); ok {
			rows = y
		} else if y, ok := x["agents"].([]any); ok {
			rows = y
		}
	}
	ss := []Session{}
	for _, v := range rows {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		id := stringField(m, "sessionId", "id")
		if id == "" {
			continue
		}
		addr, _ := FormatAddress(host, "claude", id)
		capabilities := []string{}
		if MailboxAvailable("claude", id, host) {
			capabilities = append(capabilities, "context")
		}
		if claudeNativeAvailable(id, host) {
			capabilities = append(capabilities, "wake")
		}
		ss = append(ss, Session{Address: addr, Host: host, Harness: "claude", ID: id, Title: stringField(m, "name"), CWD: stringField(m, "cwd", "workspace"), State: stringField(m, "status"), Capabilities: capabilities})
	}
	return mergeNativeAndHookSessions(ss, hookSessions), nil
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1<<20 {
		return 0, fmt.Errorf("command output exceeds 1 MiB")
	}
	return b.Buffer.Write(p)
}
func stringField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok {
			return s
		}
	}
	return ""
}
func (claudeAdapter) send(ctx context.Context, a Address, r Request) (Receipt, error) {
	if r.Wake {
		return sendClaudeNative(ctx, a, r)
	}
	return QueueMailbox(a, r)
}
