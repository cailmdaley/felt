package messaging

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeCodex struct {
	t                 *testing.T
	state             string
	mutation          string
	mutationReply     any
	dropMutationReply bool
	collideRequest    bool
	mu                sync.Mutex
	methods           []string
	mutationParams    map[string]any
}

func startFakeCodex(t *testing.T, f *fakeCodex) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "felt-codex-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "app-server.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close(); ln.Close() })
	return socket
}

func (f *fakeCodex) serve(w http.ResponseWriter, r *http.Request) {
	ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	for {
		var frame struct {
			ID     int64          `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if ws.ReadJSON(&frame) != nil {
			return
		}
		if frame.Method == "initialized" {
			continue
		}
		f.mu.Lock()
		f.methods = append(f.methods, frame.Method)
		if frame.Method == f.mutation {
			f.mutationParams = frame.Params
		}
		f.mu.Unlock()
		var result any = map[string]any{}
		switch frame.Method {
		case "thread/read":
			result = map[string]any{"thread": map[string]any{"id": "thread-1", "status": map[string]any{"type": f.state}, "canAcceptDirectInput": true}}
		case "thread/turns/list":
			result = map[string]any{"data": []any{map[string]any{"id": "turn-1", "status": "inProgress"}}}
		default:
			if frame.Method == f.mutation {
				if f.dropMutationReply {
					return
				}
				if f.collideRequest {
					_ = ws.WriteJSON(map[string]any{"id": frame.ID, "method": "commandExecution/requestApproval", "params": map[string]any{}})
				}
				if reply, ok := f.mutationReply.(fakeError); ok {
					_ = ws.WriteJSON(map[string]any{"id": frame.ID, "error": map[string]any(reply)})
					continue
				}
				result = f.mutationReply
			}
		}
		if ws.WriteJSON(map[string]any{"id": frame.ID, "result": result}) != nil {
			return
		}
	}
}

type fakeError map[string]any

func (f *fakeCodex) methodCount(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.methods {
		if m == method {
			n++
		}
	}
	return n
}

func TestCodexMutationReceipts(t *testing.T) {
	tests := []struct {
		name, state, mutation string
		wake                  bool
		reply                 any
		collision             bool
		wantStatus            string
	}{
		{"null injection ack", "idle", "thread/inject_items", false, nil, false, StatusUnknown},
		{"malformed error", "idle", "thread/inject_items", false, fakeError{}, false, StatusUnknown},
		{"idle injects without waking", "idle", "thread/inject_items", false, map[string]any{}, false, StatusContextAdded},
		{"explicit wake starts", "idle", "turn/start", true, map[string]any{"turn": map[string]any{"id": "new-turn", "status": "inProgress"}}, false, StatusAccepted},
		{"active steers despite colliding server request", "active", "turn/steer", false, map[string]any{"turnId": "turn-1"}, true, StatusAccepted},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeCodex{t: t, state: tc.state, mutation: tc.mutation, mutationReply: tc.reply, collideRequest: tc.collision}
			t.Setenv("SHUTTLE_CODEX_SOCKET", startFakeCodex(t, f))
			t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			req := Request{Address: "shuttle://h/codex/thread-1", Text: "hello", MessageID: "message-1", Wake: tc.wake}
			receipt, _ := Send(ctx, "h", req)
			if receipt.Status != tc.wantStatus {
				t.Fatalf("status=%q, want %q (%#v)", receipt.Status, tc.wantStatus, receipt)
			}
			if f.methodCount(tc.mutation) != 1 {
				t.Fatalf("mutation count=%d", f.methodCount(tc.mutation))
			}
			if tc.mutation == "thread/inject_items" && f.methodCount("turn/start") != 0 {
				t.Fatal("default idle delivery started a turn")
			}
			if tc.mutation == "turn/steer" {
				f.mu.Lock()
				expected := f.mutationParams["expectedTurnId"]
				f.mu.Unlock()
				if expected != "turn-1" {
					t.Fatalf("expectedTurnId=%v", expected)
				}
			}
		})
	}
}

func TestCodexLostAcknowledgmentIsDeduplicated(t *testing.T) {
	f := &fakeCodex{t: t, state: "idle", mutation: "thread/inject_items", dropMutationReply: true}
	t.Setenv("SHUTTLE_CODEX_SOCKET", startFakeCodex(t, f))
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	req := Request{Address: "shuttle://h/codex/thread-1", Text: "hello", MessageID: "lost-ack"}
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		receipt, err := Send(ctx, "h", req)
		cancel()
		if receipt.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
			t.Fatalf("attempt %d: %#v, %v", attempt+1, receipt, err)
		}
	}
	if got := f.methodCount("thread/inject_items"); got != 1 {
		t.Fatalf("same-ID retry sent %d mutations, want 1", got)
	}
}
