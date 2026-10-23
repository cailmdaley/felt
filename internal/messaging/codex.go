package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync/atomic"
	"time"

	"github.com/cailmdaley/felt/internal/codexendpoint"
	"github.com/cailmdaley/felt/internal/sysenv"
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
	ID        string  `json:"id"`
	SessionID string  `json:"sessionId"`
	Name      *string `json:"name"`
	Preview   string  `json:"preview"`
	CWD       string  `json:"cwd"`
	Status    struct {
		Type        string   `json:"type"`
		ActiveFlags []string `json:"activeFlags"`
	} `json:"status"`
	Turns                []struct{ ID, Status string } `json:"turns"`
	CanAcceptDirectInput *bool                         `json:"canAcceptDirectInput"`
}

func codexSocket(env *sysenv.Env) string {
	if p := env.Getenv("SHUTTLE_CODEX_SOCKET"); p != "" {
		return p
	}
	hostname, _ := env.Hostname()
	path, _ := codexendpoint.Resolve("", env.EUID(), hostname)
	return path
}

// A durable AppWorkers record pins the native conversation owner. An absent
// record leaves hook-only sessions unchanged; an unreadable or unpinned record
// cannot safely inherit whichever endpoint happens to be configured today.
var codexNativeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func checkCodexOwnerEndpoint(env *sysenv.Env, host, id string) error {
	if !codexNativeID.MatchString(id) {
		return errCode("invalid_session_id", "invalid Codex native thread ID %q", id)
	}
	root := filepath.Join(dataDir(env), "app-workers")
	path := filepath.Join(root, id+".json")
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		// A dangling root symlink is not an absent ownership store.
		if _, rootErr := os.Stat(root); os.IsNotExist(rootErr) {
			if _, linkErr := os.Lstat(root); !os.IsNotExist(linkErr) {
				return errCode("ownership_record_unreadable", "cannot verify Codex owner store %s", root)
			}
		}
		return nil
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return errCode("ownership_record_unreadable", "cannot verify Codex owner record %s: %v", path, err)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes, &record); err != nil || record == nil {
		return errCode("ownership_record_unreadable", "invalid Codex owner record %s", path)
	}
	if record["session_uuid"] != id || record["thread_id"] != id {
		return errCode("session_owner_mismatch", "Codex owner record %s does not identify thread %q", path, id)
	}
	ownerHost, _ := record["backend_host"].(string)
	if ownerHost == "" {
		return errCode("app_host_unrecorded", "Codex owner host is unrecorded in %s; explicitly repair the ownership record before messaging", path)
	}
	if ownerHost != host {
		return errCode("app_host_changed", "Codex conversation belongs to host %q, not %q; restore its recorded owner", ownerHost, host)
	}
	endpoint, _ := record["backend_endpoint"].(string)
	if endpoint == "" {
		return errCode("app_endpoint_unrecorded", "Codex owner endpoint is unrecorded in %s; explicitly repair the ownership record before messaging", path)
	}
	if endpoint != codexSocket(env) {
		return errCode("app_endpoint_changed", "Codex owner endpoint %q differs from configured socket %q; restore the recorded endpoint instead of changing conversation owner", endpoint, codexSocket(env))
	}
	return nil
}

func validatedCodexSocket(env *sysenv.Env) (string, error) {
	hostname, err := env.Hostname()
	if err != nil {
		return "", err
	}
	return codexendpoint.Resolve(env.Getenv("SHUTTLE_CODEX_SOCKET"), env.EUID(), hostname)
}

func dialCodex(ctx context.Context, env *sysenv.Env) (*rpcClient, error) {
	socket, err := validatedCodexSocket(env)
	if err != nil {
		return nil, err
	}
	d := websocket.Dialer{EnableCompression: false, HandshakeTimeout: 3 * time.Second, NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
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
	if err := publishOwnerDeadline(ctx, deadline); err != nil {
		return err
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

func (codexAdapter) discover(ctx context.Context, env *sysenv.Env, host string) ([]Session, error) {
	hookSessions := mailboxSessions(env, "codex", host)
	r, err := dialCodex(ctx, env)
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
		ss = append(ss, Session{Address: addr, Host: host, Harness: "codex", ID: id, TranscriptID: out.Thread.SessionID, Title: title, CWD: out.Thread.CWD, State: out.Thread.Status.Type, Capabilities: caps})
	}
	if failed > 0 {
		return mergeSessions(ss, hookSessions), fmt.Errorf("%d loaded Codex thread(s) could not be inspected", failed)
	}
	return mergeSessions(ss, hookSessions), nil
}

// mergeSessions lists each address once, keeping the first record seen, so a
// harness's native record wins over its hook registration.
func mergeSessions(primary, additions []Session) []Session {
	seen := make(map[string]bool, len(primary)+len(additions))
	merged := make([]Session, 0, len(primary)+len(additions))
	for _, source := range [][]Session{primary, additions} {
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

// Labeled renders the peer header shared by native adapters and hook mailboxes.
// From identifies the sending session; ReplyTo is a separate, durable target.
func Labeled(r Request) string {
	header := "[Shuttle message " + r.MessageID
	if r.From != "" {
		header += " from " + r.From
	}
	if r.ReplyTo != "" {
		header += "; reply to " + r.ReplyTo
	}
	return header + "]\n" + r.Text
}

func labeled(r Request) string { return Labeled(r) }
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

func (codexAdapter) send(ctx context.Context, env *sysenv.Env, a Address, req Request) (Receipt, error) {
	if err := checkCodexOwnerEndpoint(env, a.Host, a.ID); err != nil {
		return rejected(req, "codex-app-server", err.Error()), errCode("preflight_failed", "%v", err)
	}
	if codexHookOwnsInput(ctx, env, a) {
		if !req.Wake {
			return queueMailbox(env, a, req)
		}
		return rejected(req, "codex-app-server", codexWakeHint), errCode("session_unavailable", "%s", codexWakeHint)
	}
	r, err := dialCodex(ctx, env)
	if err != nil {
		if !req.Wake {
			return queueMailbox(env, a, req)
		}
		detail := "Codex control socket unavailable; " + codexWakeHint
		return rejected(req, "codex-app-server", detail), errCode("preflight_failed", "%s: %v", detail, err)
	}
	defer r.c.Close()
	var read struct {
		Thread codexThread `json:"thread"`
	}
	if err = r.call(ctx, "thread/read", map[string]any{"threadId": a.ID, "includeTurns": false}, &read); err != nil {
		if _, ok := err.(*rpcPeerError); ok {
			if !req.Wake {
				return queueMailbox(env, a, req)
			}
			detail := "Codex thread unavailable; " + codexWakeHint
			return rejected(req, "codex-app-server", detail), errCode("session_not_found", "%s: %v", detail, err)
		}
		if !req.Wake {
			return queueMailbox(env, a, req)
		}
		return rejected(req, "codex-app-server", "Codex thread lookup failed"), errCode("preflight_failed", "Codex thread lookup failed: %v", err)
	}
	t := read.Thread
	if t.ID != a.ID {
		if !req.Wake {
			return queueMailbox(env, a, req)
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
			return queueMailbox(env, a, req)
		}
		detail := "thread is not loaded by this Codex runtime; " + codexWakeHint
		return rejected(req, "codex-app-server", detail), errCode("session_unavailable", "%s", detail)
	default:
		return rejected(req, "codex-app-server", "thread cannot accept input in state "+t.Status.Type), errCode("session_unavailable", "thread cannot accept input")
	}
	return codexMutationFailure(req, err)
}

// A live hook receiver must explicitly use this endpoint before native input
// can bypass its hooks. A loaded copy of an embedded thread is not its owner.
func codexHookOwnsInput(ctx context.Context, env *sysenv.Env, a Address) bool {
	reg, err := mailboxRegistrationFor(env, "codex", a.ID)
	if err != nil || reg.ID != a.ID || reg.Host != a.Host || !reg.live() {
		return false
	}
	socket, err := validatedCodexSocket(env)
	if err != nil {
		return true
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// Hooks run in the backend's process tree. The actual Unix peer proves
	// ownership independently of the server's argv rendering or flag order.
	if conn, dialErr := (&net.Dialer{}).DialContext(probe, "unix", socket); dialErr == nil {
		pid, peerErr := claudePeerPID(conn)
		conn.Close()
		if peerErr == nil && pid == reg.PID {
			return false
		}
	}
	// ps flattens argv without quoting, so it cannot prove which socket a
	// receiver uses. Unknown or mismatched peers leave input with the hooks.
	return true
}

// An explicit remote endpoint keeps a TUI on the same conversation owner as
// native messaging. A hook registration alone cannot wake an embedded runtime.
const codexWakeHint = "wake requires the exact thread on this App Server (terminal launch: codex --remote unix://PATH); restore that server if unavailable, or use --context-only for a hook-only session"

func codexMutationFailure(req Request, err error) (Receipt, error) {
	if _, ok := err.(*rpcPeerError); ok {
		return rejected(req, "codex-app-server", err.Error()), errCode("peer_rejected", "Codex rejected message: %v", err)
	}
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "codex-app-server", Detail: "Codex delivery outcome is unknown"}, errCode("ambiguous_delivery", "Codex delivery outcome unknown: %v", err)
}
