package messaging

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stubIdleWatcher(t *testing.T) *[]string {
	t.Helper()
	var spawned []string
	old := SpawnIdleWatcher
	SpawnIdleWatcher = func(path string) error { spawned = append(spawned, path); return nil }
	t.Cleanup(func() { SpawnIdleWatcher = old })
	return &spawned
}

// The native subscription rides Claude Code's own inbox: a notify_when_idle
// control frame out, a correlated peer_idle_notice back to the reply socket.
func TestClaudeNativeIdleSubscription(t *testing.T) { testClaudeNativeIdle(t, false) }

// Claude's native notice does not wait for background tasks; a Stop hook that
// left work running defers the notice to the next quiet stop.
func TestClaudeNativeIdleWaitsOutBackgroundTasks(t *testing.T) { testClaudeNativeIdle(t, true) }

func testClaudeNativeIdle(t *testing.T, background bool) {
	env := testEnv(t)
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	writeEvents(t, events, hookEvent{Timestamp: 1, Type: "stop", SessionID: "session", BackgroundTasks: 1})
	spawned := stubIdleWatcher(t)
	frames := make(chan map[string]any, 4)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		frames <- frame
		if frame["action"] != "notify_when_idle" {
			return
		}
		reg, _ := readClaudeNative(env, "session")
		c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_idle_notice", "orig_msg_id": "someone-else", "state": "idle", "from": "uds:" + reg.Socket})
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_idle_notice", "orig_msg_id": frame["msg_id"], "state": "idle", "finished_at": 1700000000000, "from": "uds:" + reg.Socket})
		io.Copy(io.Discard, c)
	})
	req.Text, req.Wake, req.NotifyWhenIdle, req.From = "", false, true, "shuttle://host/pi/subscriber"
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusSubscribed || r.Idle == nil || r.Idle.Signal != IdleSignalClaudeNative || len(*spawned) != 1 {
		t.Fatalf("%+v %v %v", r, err, *spawned)
	}
	again, err := Send(context.Background(), env, "host", req)
	if err != nil || again.Status != StatusSubscribed || len(*spawned) != 1 {
		t.Fatalf("retry %+v %v spawned %d", again, err, len(*spawned))
	}
	rec, err := ReadIdleRecord((*spawned)[0])
	if err != nil || rec.Subscriber != req.From {
		t.Fatalf("%+v %v", rec, err)
	}
	want := int64(1700000000000)
	// The turn-ending Stop may predate the subscription (an already-idle
	// receiver); rewrite the stream so it sits before the recorded offset.
	os.Remove(events)
	writeEvents(t, events, hookEvent{Timestamp: want, Type: "stop", SessionID: "session", BackgroundTasks: map[bool]int{true: 1}[background]})
	if info, err := os.Stat(events); err == nil {
		rec.EventsOffset = info.Size()
	}
	if background {
		want += 30000
		quiet := hookEvent{Timestamp: want, Type: "stop", SessionID: "session"}
		go func() {
			time.Sleep(500 * time.Millisecond)
			writeEvents(t, events, quiet)
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	n := WatchIdle(ctx, env, rec)
	if n.State != NoticeIdle || n.FinishedAt.UnixMilli() != want {
		t.Fatalf("%+v", n)
	}
	frame := <-frames
	if frame["type"] != "control" || frame["msg_id"] != idleUUID(rec) {
		t.Fatalf("%v", frame)
	}
	if !strings.Contains(IdleNoticeText(rec, n), "ended its turn") {
		t.Fatal(IdleNoticeText(rec, n))
	}
}

func TestIdleSubscriptionWithMessageDeliversThenSubscribes(t *testing.T) {
	env := testEnv(t)
	spawned := stubIdleWatcher(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.NotifyWhenIdle, req.From = true, "shuttle://host/pi/subscriber"
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusAccepted || r.Idle == nil || r.Idle.State != IdleWatching || sent.Load() != 1 || len(*spawned) != 1 {
		t.Fatalf("%+v %v sent %d spawned %d", r, err, sent.Load(), len(*spawned))
	}
}

func TestIdleSubscriptionValidation(t *testing.T) {
	base := Request{Address: "shuttle://host/claude/session", MessageID: "m", NotifyWhenIdle: true}
	for name, r := range map[string]Request{
		"no sender":  base,
		"self":       {Address: base.Address, MessageID: "m", NotifyWhenIdle: true, From: base.Address},
		"wake alone": {Address: base.Address, MessageID: "m", Text: "x", NotifyWake: true},
	} {
		if err := validateRequest("host", r); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	ok := base
	ok.From = "shuttle://other/codex/t"
	if err := validateRequest("host", ok); err != nil {
		t.Fatal(err)
	}
}

func TestIdleSubscriptionUnsupportedWithoutNativeInbox(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	stubIdleWatcher(t)
	r, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/claude/nobody", MessageID: "m", NotifyWhenIdle: true, From: "shuttle://host/pi/s"})
	if err == nil || r.Status != StatusRejected || r.Idle == nil || r.Idle.State != IdleUnsupported {
		t.Fatalf("%+v %v", r, err)
	}
}

func writeEvents(t *testing.T, path string, events ...hookEvent) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, e := range events {
		json.NewEncoder(f).Encode(e)
	}
}

// A stop with background work, or one followed by activity inside the grace
// window, is not idle; the next quiet stop is.
func TestHookIdleNeedsQuietStop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "stop", SessionID: "s"})
	info, _ := os.Stat(path)
	done := make(chan IdleNotice, 1)
	go func() {
		n, _ := watchHookIdle(context.Background(), path, "s", info.Size())
		done <- n
	}()
	writeEvents(t, path,
		hookEvent{Timestamp: 2, Type: "stop", SessionID: "s", BackgroundTasks: 1},
		hookEvent{Timestamp: 3, Type: "stop", SessionID: "other"},
		hookEvent{Timestamp: 4, Type: "stop", SessionID: "s"},
		hookEvent{Timestamp: 5, Type: "user_prompt_submit", SessionID: "s"})
	select {
	case n := <-done:
		t.Fatalf("premature %+v", n)
	case <-time.After(idleHookGrace + time.Second):
	}
	writeEvents(t, path, hookEvent{Timestamp: 6, Type: "stop", SessionID: "s"})
	select {
	case n := <-done:
		if n.State != NoticeIdle || n.FinishedAt.UnixMilli() != 6 {
			t.Fatalf("%+v", n)
		}
	case <-time.After(idleHookGrace + 2*time.Second):
		t.Fatal("no idle notice")
	}
}

func TestHookIdleSessionEndIsExit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 9, Type: "session_end", SessionID: "s"})
	n, err := watchHookIdle(context.Background(), path, "s", 0)
	if err != nil || n.State != NoticeExited {
		t.Fatalf("%+v %v", n, err)
	}
}

func TestIdleWatchExpiresWithoutClaimingState(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_EVENTS_FILE", filepath.Join(t.TempDir(), "events.jsonl"))
	rec := IdleRecord{MessageID: "m", Address: "shuttle://host/codex/t", Signal: IdleSignalHookEvents, CreatedAt: time.Now().Add(-IdleSubscriptionLifetime).Unix() + 1}
	n := WatchIdle(context.Background(), env, rec)
	if n.State != NoticeExpired || !strings.Contains(IdleNoticeText(rec, n), "no claim") {
		t.Fatalf("%+v", n)
	}
}

// A Codex stop with a spawned agent still running is not idle until the
// child reports back.
func TestHookIdleWaitsForSpawnedAgents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path,
		hookEvent{Timestamp: 1, Type: "post_tool_use", SessionID: "s", Tool: "spawn_agent"},
		hookEvent{Timestamp: 2, Type: "stop", SessionID: "s"})
	done := make(chan IdleNotice, 1)
	go func() { n, _ := watchHookIdle(context.Background(), path, "s", 0); done <- n }()
	select {
	case n := <-done:
		t.Fatalf("premature %+v", n)
	case <-time.After(idleHookGrace + time.Second):
	}
	writeEvents(t, path, hookEvent{Timestamp: 3, Type: "subagent_stop", SessionID: "s"})
	select {
	case n := <-done:
		if n.State != NoticeIdle {
			t.Fatalf("%+v", n)
		}
	case <-time.After(idleHookGrace + 2*time.Second):
		t.Fatal("no idle notice")
	}
}

// Rotation renames the stream; the watcher follows the new file.
func TestHookIdleFollowsRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "pre_tool_use", SessionID: "s"})
	done := make(chan IdleNotice, 1)
	go func() { n, _ := watchHookIdle(context.Background(), path, "s", 0); done <- n }()
	time.Sleep(500 * time.Millisecond)
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeEvents(t, path, hookEvent{Timestamp: 5, Type: "session_end", SessionID: "s"})
	select {
	case n := <-done:
		if n.State != NoticeExited {
			t.Fatalf("%+v", n)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("rotation not followed")
	}
}
