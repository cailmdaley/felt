package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func wsTestServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if errors.Is(err, syscall.EPERM) {
		t.Skip("sandbox disallows loopback sockets")
	}
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewUnstartedServer(h)
	s.Listener = ln
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func TestRPCCallIgnoresNotificationsAndServerRequests(t *testing.T) {
	up := websocket.Upgrader{}
	srv := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if c.ReadJSON(&req) != nil {
			return
		}
		c.WriteJSON(map[string]any{"method": "thread/status/changed", "params": map[string]any{}})
		c.WriteJSON(map[string]any{"id": 999, "method": "commandExecution/requestApproval", "params": map[string]any{}})
		c.WriteJSON(map[string]any{"id": nil, "result": map[string]any{"value": "wrong"}})
		c.WriteJSON(map[string]any{"id": req.ID + 1, "result": map[string]any{"value": "wrong"}})
		c.WriteJSON(map[string]any{"id": req.ID, "result": map[string]any{"value": "ok"}})
	}))
	u := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rpc := &rpcClient{c: c}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var got struct {
		Value string `json:"value"`
	}
	if err = rpc.call(ctx, "test", map[string]any{}, &got); err != nil {
		t.Fatal(err)
	}
	if got.Value != "ok" {
		t.Fatalf("bad result: %#v", got)
	}
}

func TestRPCRejectsPeerError(t *testing.T) {
	up := websocket.Upgrader{}
	srv := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := up.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer c.Close()
		var req map[string]any
		c.ReadJSON(&req)
		c.WriteJSON(map[string]any{"id": req["id"], "error": map[string]any{"code": -1, "message": "nope"}})
	}))
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rpc := &rpcClient{c: c}
	var out json.RawMessage
	if err = rpc.call(context.Background(), "test", map[string]any{}, &out); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("got %v", err)
	}
}

func TestRPCCapsUnrelatedFrames(t *testing.T) {
	up := websocket.Upgrader{}
	srv := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := up.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer c.Close()
		var req map[string]any
		if c.ReadJSON(&req) != nil {
			return
		}
		for i := 0; i < 256; i++ {
			if c.WriteJSON(map[string]any{"method": "noise"}) != nil {
				return
			}
		}
	}))
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rpc := &rpcClient{c: c}
	var out any
	err = rpc.call(context.Background(), "test", map[string]any{}, &out)
	if err == nil || !strings.Contains(err.Error(), "too many unrelated frames") {
		t.Fatalf("got %v", err)
	}
}

func TestCodexMutationResultShapes(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		valid bool
	}{{`{}`, true}, {`null`, false}, {`[]`, false}, {``, false}} {
		if got := validObjectResult(json.RawMessage(tc.raw)); got != tc.valid {
			t.Errorf("validObjectResult(%q)=%v", tc.raw, got)
		}
	}
	var steer steerResult
	if json.Unmarshal([]byte(`{"turnId":"turn-1"}`), &steer) != nil || steer.TurnID != "turn-1" {
		t.Fatal("valid steer ack rejected")
	}
	steer = steerResult{}
	if json.Unmarshal([]byte(`null`), &steer) != nil || steer.TurnID != "" {
		t.Fatal("null steer ack appeared valid")
	}
	var start startResult
	if json.Unmarshal([]byte(`{"turn":{"id":"turn-1","status":"inProgress"}}`), &start) != nil || start.Turn.ID == "" || start.Turn.Status == "" {
		t.Fatal("valid start ack rejected")
	}
}
