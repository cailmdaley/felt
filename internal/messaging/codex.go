package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type codexAdapter struct{}
type rpcClient struct {
	c   *websocket.Conn
	seq atomic.Int64
}
type rpcPeerError struct{ method, message string }

func (e *rpcPeerError) Error() string { return "codex " + e.method + ": " + e.message }

type codexThread struct {
	ID      string  `json:"id"`
	Name    *string `json:"name"`
	Preview string  `json:"preview"`
	CWD     string  `json:"cwd"`
	Status  struct {
		Type        string   `json:"type"`
		ActiveFlags []string `json:"activeFlags"`
	} `json:"status"`
	Turns                []struct{ ID, Status string } `json:"turns"`
	CanAcceptDirectInput *bool                         `json:"canAcceptDirectInput"`
}

func codexSocket() string {
	if p := os.Getenv("SHUTTLE_CODEX_SOCKET"); p != "" {
		return p
	}
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, ".codex")
	}
	return filepath.Join(home, "app-server-control", "app-server-control.sock")
}

func dialCodex(ctx context.Context) (*rpcClient, error) {
	d := websocket.Dialer{EnableCompression: false, HandshakeTimeout: 3 * time.Second, NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", codexSocket())
	}}
	c, _, err := d.DialContext(ctx, "ws://localhost/", http.Header{"Host": []string{"localhost"}})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(2 << 20)
	r := &rpcClient{c: c}
	var init json.RawMessage
	if err = r.call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "shuttle", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &init); err != nil {
		c.Close()
		return nil, err
	}
	if err = c.WriteJSON(map[string]any{"method": "initialized"}); err != nil {
		c.Close()
		return nil, err
	}
	return r, nil
}

func (r *rpcClient) call(ctx context.Context, method string, params any, out any) error {
	id := r.seq.Add(1)
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	r.c.SetWriteDeadline(deadline)
	if err := r.c.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	for frames := 0; frames < 256; frames++ {
		r.c.SetReadDeadline(deadline)
		_, b, err := r.c.ReadMessage()
		if err != nil {
			return err
		}
		var envelope map[string]json.RawMessage
		if json.Unmarshal(b, &envelope) != nil {
			continue
		}
		if _, isRequest := envelope["method"]; isRequest {
			continue
		}
		var responseID int64
		if raw, ok := envelope["id"]; !ok || json.Unmarshal(raw, &responseID) != nil || responseID != id {
			continue
		}
		result, hasResult := envelope["result"]
		rawError, hasError := envelope["error"]
		if hasResult == hasError {
			return fmt.Errorf("codex %s: malformed response envelope", method)
		}
		if hasError {
			var peer struct {
				Code    *int    `json:"code"`
				Message *string `json:"message"`
			}
			if json.Unmarshal(rawError, &peer) != nil || peer.Code == nil || peer.Message == nil || *peer.Message == "" {
				return fmt.Errorf("codex %s: malformed error response", method)
			}
			return &rpcPeerError{method: method, message: *peer.Message}
		}
		return json.Unmarshal(result, out)
	}
	return fmt.Errorf("codex %s: too many unrelated frames", method)
}

func (codexAdapter) discover(ctx context.Context, host string) ([]Session, error) {
	hookSessions := MailboxSessions("codex", host)
	r, err := dialCodex(ctx)
	if err != nil {
		return hookSessions, err
	}
	defer r.c.Close()
	var loaded struct {
		Data []string `json:"data"`
	}
	if err = r.call(ctx, "thread/loaded/list", map[string]any{}, &loaded); err != nil {
		return hookSessions, err
	}
	ss := make([]Session, 0, len(loaded.Data))
	failed := 0
	for _, id := range loaded.Data {
		var out struct {
			Thread codexThread `json:"thread"`
		}
		if err = r.call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false}, &out); err != nil {
			failed++
			continue
		}
		title := out.Thread.Preview
		if out.Thread.Name != nil && *out.Thread.Name != "" {
			title = *out.Thread.Name
		}
		addr, _ := FormatAddress(host, "codex", id)
		caps := []string{}
		if out.Thread.CanAcceptDirectInput == nil || *out.Thread.CanAcceptDirectInput {
			caps = append(caps, "context")
		}
		if (out.Thread.CanAcceptDirectInput == nil || *out.Thread.CanAcceptDirectInput) && out.Thread.Status.Type == "active" {
			caps = append(caps, "steer")
		}
		if (out.Thread.CanAcceptDirectInput == nil || *out.Thread.CanAcceptDirectInput) && out.Thread.Status.Type == "idle" {
			caps = append(caps, "wake")
		}
		ss = append(ss, Session{Address: addr, Host: host, Harness: "codex", ID: id, Title: title, CWD: out.Thread.CWD, State: out.Thread.Status.Type, Capabilities: caps})
	}
	if failed > 0 {
		return mergeNativeAndHookSessions(ss, hookSessions), fmt.Errorf("%d loaded Codex thread(s) could not be inspected", failed)
	}
	return mergeNativeAndHookSessions(ss, hookSessions), nil
}

func mergeNativeAndHookSessions(native, hooks []Session) []Session {
	seen := make(map[string]bool, len(native))
	merged := make([]Session, 0, len(native)+len(hooks))
	for _, source := range [][]Session{native, hooks} {
		for _, session := range source {
			if !seen[session.Address] {
				seen[session.Address] = true
				merged = append(merged, session)
			}
		}
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].Address < merged[j].Address })
	return merged
}

func labeled(r Request) string {
	if r.From != "" {
		return "[Shuttle message " + r.MessageID + " from " + r.From + "]\n" + r.Text
	}
	return "[Shuttle message " + r.MessageID + "]\n" + r.Text
}
func userInput(text string) []map[string]any {
	return []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}
}

type steerResult struct {
	TurnID string `json:"turnId"`
}
type startResult struct {
	Turn struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"turn"`
}

func validObjectResult(raw json.RawMessage) bool {
	var v map[string]json.RawMessage
	return len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &v) == nil && v != nil
}

func (codexAdapter) send(ctx context.Context, a Address, req Request) (Receipt, error) {
	r, err := dialCodex(ctx)
	if err != nil {
		if !req.Wake {
			return QueueMailbox(a, req)
		}
		return rejected(req, "codex-app-server", "Codex control socket unavailable"), errCode("preflight_failed", "Codex control socket unavailable: %v", err)
	}
	defer r.c.Close()
	var read struct {
		Thread codexThread `json:"thread"`
	}
	if err = r.call(ctx, "thread/read", map[string]any{"threadId": a.ID, "includeTurns": false}, &read); err != nil {
		if _, ok := err.(*rpcPeerError); ok {
			if !req.Wake {
				return QueueMailbox(a, req)
			}
			return rejected(req, "codex-app-server", err.Error()), errCode("session_not_found", "Codex thread unavailable: %v", err)
		}
		if !req.Wake {
			return QueueMailbox(a, req)
		}
		return rejected(req, "codex-app-server", "Codex thread lookup failed"), errCode("preflight_failed", "Codex thread lookup failed: %v", err)
	}
	t := read.Thread
	if t.ID != a.ID {
		if !req.Wake {
			return QueueMailbox(a, req)
		}
		return rejected(req, "codex-app-server", "thread identity mismatch"), errCode("session_not_found", "thread identity mismatch")
	}
	if t.CanAcceptDirectInput != nil && !*t.CanAcceptDirectInput {
		return rejected(req, "codex-app-server", "thread does not accept direct input"), errCode("session_unavailable", "thread does not accept direct input")
	}
	text := labeled(req)
	switch t.Status.Type {
	case "active":
		if req.Wake {
			for _, flag := range t.Status.ActiveFlags {
				if flag == "waitingOnApproval" || flag == "waitingOnUserInput" {
					return rejected(req, "codex-app-server", "active turn requires approval or user input; answer its pending request before waking"), errCode("pending_input", "active turn requires approval or user input; answer its pending request before waking")
				}
			}
		}
		var turns struct {
			Data []struct{ ID, Status string } `json:"data"`
		}
		if err = r.call(ctx, "thread/turns/list", map[string]any{"threadId": a.ID, "limit": 1, "sortDirection": "desc"}, &turns); err != nil {
			return rejected(req, "codex-app-server", "could not inspect active turn"), errCode("preflight_failed", "could not inspect active turn: %v", err)
		}
		if len(turns.Data) == 0 || turns.Data[0].ID == "" || turns.Data[0].Status != "inProgress" {
			return rejected(req, "codex-app-server", "active turn unavailable"), errCode("busy_race", "active turn unavailable")
		}
		var result steerResult
		err = r.call(ctx, "turn/steer", map[string]any{"threadId": a.ID, "expectedTurnId": turns.Data[0].ID, "input": userInput(text), "clientUserMessageId": req.MessageID}, &result)
		if err == nil && result.TurnID == turns.Data[0].ID {
			return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: "codex-app-server", Detail: "steered active turn"}, nil
		}
		if err == nil {
			err = fmt.Errorf("codex turn/steer returned incomplete or mismatched acknowledgement")
		}
	case "idle":
		if req.Wake {
			var result startResult
			err = r.call(ctx, "turn/start", map[string]any{"threadId": a.ID, "input": userInput(text), "clientUserMessageId": req.MessageID}, &result)
			if err == nil && result.Turn.ID != "" && (result.Turn.Status == "inProgress" || result.Turn.Status == "completed") {
				return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: "codex-app-server", Detail: "started turn"}, nil
			}
			if err == nil {
				err = fmt.Errorf("codex turn/start did not confirm a running or completed turn (status %q)", result.Turn.Status)
			}
		} else {
			items := []map[string]any{{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": text}}}}
			var result json.RawMessage
			err = r.call(ctx, "thread/inject_items", map[string]any{"threadId": a.ID, "items": items}, &result)
			if err == nil && validObjectResult(result) {
				return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusContextAdded, Transport: "codex-app-server", Detail: "added persistent context"}, nil
			}
			if err == nil {
				err = fmt.Errorf("codex thread/inject_items returned incomplete acknowledgement")
			}
		}
	case "notLoaded", "notFound":
		if !req.Wake {
			return QueueMailbox(a, req)
		}
		return rejected(req, "codex-app-server", "thread is not loaded by this Codex runtime"), errCode("session_unavailable", "thread is not loaded by this Codex runtime")
	default:
		return rejected(req, "codex-app-server", "thread cannot accept input in state "+t.Status.Type), errCode("session_unavailable", "thread cannot accept input")
	}
	return codexMutationFailure(req, err)
}

func codexMutationFailure(req Request, err error) (Receipt, error) {
	if _, ok := err.(*rpcPeerError); ok {
		return rejected(req, "codex-app-server", err.Error()), errCode("peer_rejected", "Codex rejected message: %v", err)
	}
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "codex-app-server", Detail: "Codex delivery outcome is unknown"}, errCode("ambiguous_delivery", "Codex delivery outcome unknown: %v", err)
}
