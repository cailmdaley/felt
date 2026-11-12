package messaging

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
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
	w := newIdlePoller(t)
	go func() { w.done <- watchIdle(w.ctx, env, rec, w.polls, w.now) }()
	// The first poll reaches a hook watcher only once the turn's Stop has
	// been read; without background work the native notice already ended
	// the watch.
	n, done := w.poll(1)
	if background {
		if done {
			t.Fatalf("idle while background work ran: %+v", n)
		}
		want += 30000
		writeEvents(t, events, hookEvent{Timestamp: want, Type: "stop", SessionID: "session"})
		n, done = w.poll(3 * quietPolls)
	}
	if !done || n.State != NoticeIdle || n.FinishedAt.UnixMilli() != want {
		t.Fatalf("%v %+v", done, n)
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

// idlePoller drives an idle watcher one poll at a time on a clock of its own
// that each poll advances by idleHookPoll, so a test counts polls instead of
// waiting out the grace window.
type idlePoller struct {
	ctx   context.Context
	polls chan time.Time
	done  chan IdleNotice
	clock atomic.Int64
}

// quietPolls is how many polls the grace window spans.
const quietPolls = int(idleHookQuiet / idleHookPoll)

func (w *idlePoller) now() time.Time { return time.Unix(0, w.clock.Load()) }

func newIdlePoller(t *testing.T) *idlePoller {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &idlePoller{ctx: ctx, polls: make(chan time.Time), done: make(chan IdleNotice, 1)}
}

// startHookIdle watches session "s" in the stream at path from offset.
func startHookIdle(t *testing.T, path string, offset int64) *idlePoller {
	t.Helper()
	w := newIdlePoller(t)
	go func() { n, _ := watchHookIdle(w.ctx, path, "s", offset, w.polls, w.now); w.done <- n }()
	return w
}

// poll delivers up to n polls, each once the watcher has finished with the
// one before, and returns the notice if the watcher ends first.
func (w *idlePoller) poll(n int) (IdleNotice, bool) {
	for range n {
		w.clock.Add(int64(idleHookPoll))
		if notice, done := w.tick(); done {
			return notice, true
		}
	}
	return IdleNotice{}, false
}

// tick delivers one poll without advancing the clock, as a ticker delivers a
// tick that waited in its channel.
func (w *idlePoller) tick() (IdleNotice, bool) {
	select {
	case w.polls <- time.Time{}:
		return IdleNotice{}, false
	case notice := <-w.done:
		return notice, true
	}
}

// A stop with background work, or one followed by activity inside the grace
// window, is not idle; the next quiet stop is, once the window has passed.
func TestHookIdleNeedsQuietStop(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "stop", SessionID: "s"})
	info, _ := os.Stat(path)
	w := startHookIdle(t, path, info.Size())
	writeEvents(t, path,
		hookEvent{Timestamp: 2, Type: "stop", SessionID: "s"},
		hookEvent{Timestamp: 3, Type: "user_prompt_submit", SessionID: "s"},
		hookEvent{Timestamp: 4, Type: "stop", SessionID: "s", BackgroundTasks: 1},
		hookEvent{Timestamp: 5, Type: "stop", SessionID: "other"})
	if n, done := w.poll(3 * quietPolls); done {
		t.Fatalf("premature %+v", n)
	}
	writeEvents(t, path, hookEvent{Timestamp: 6, Type: "stop", SessionID: "s"})
	if n, done := w.poll(quietPolls - 1); done {
		t.Fatalf("idle inside the grace window: %+v", n)
	}
	n, done := w.poll(3 * quietPolls)
	if !done || n.State != NoticeIdle || n.FinishedAt.UnixMilli() != 6 {
		t.Fatalf("%v %+v", done, n)
	}
}

// The grace runs from when the stop is read, however many ticks arrive in
// it: a tick that waited in the ticker's channel while the watch began counts
// for no time, so activity late in the window still cancels the stop.
func TestHookIdleGraceIgnoresStaleTick(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "stop", SessionID: "s"})
	w := startHookIdle(t, path, 0)
	if n, done := w.tick(); done {
		t.Fatalf("idle on a stale tick: %+v", n)
	}
	// The last tick is taken only once the watcher has judged the poll before.
	w.poll(quietPolls - 1)
	if n, done := w.tick(); done {
		t.Fatalf("idle inside the grace window: %+v", n)
	}
	writeEvents(t, path, hookEvent{Timestamp: 2, Type: "user_prompt_submit", SessionID: "s"})
	if n, done := w.poll(3 * quietPolls); done {
		t.Fatalf("idle after a continuation: %+v", n)
	}
}

func TestHookIdleSessionEndIsExit(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 9, Type: "session_end", SessionID: "s"})
	n, err := watchHookIdle(context.Background(), path, "s", 0, nil, time.Now)
	if err != nil || n.State != NoticeExited {
		t.Fatalf("%+v %v", n, err)
	}
}

func TestIdleWatchExpiresWithoutClaimingState(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_EVENTS_FILE", filepath.Join(t.TempDir(), "events.jsonl"))
	rec := IdleRecord{MessageID: "m", Address: "shuttle://host/codex/t", Signal: IdleSignalHookEvents, CreatedAt: time.Now().Add(-IdleSubscriptionLifetime).Unix() - 1}
	n := WatchIdle(context.Background(), env, rec)
	if n.State != NoticeExpired || !strings.Contains(IdleNoticeText(rec, n), "no claim") {
		t.Fatalf("%+v", n)
	}
}

// A Codex stop with a spawned agent still running is not idle until the
// child reports back.
func TestHookIdleWaitsForSpawnedAgents(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path,
		hookEvent{Timestamp: 1, Type: "post_tool_use", SessionID: "s", Tool: "spawn_agent"},
		hookEvent{Timestamp: 2, Type: "stop", SessionID: "s"})
	w := startHookIdle(t, path, 0)
	if n, done := w.poll(3 * quietPolls); done {
		t.Fatalf("premature %+v", n)
	}
	writeEvents(t, path, hookEvent{Timestamp: 3, Type: "subagent_stop", SessionID: "s"})
	if n, done := w.poll(3 * quietPolls); !done || n.State != NoticeIdle {
		t.Fatalf("%v %+v", done, n)
	}
}

// Rotation renames the stream; the watcher follows the new file.
func TestHookIdleFollowsRotation(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "pre_tool_use", SessionID: "s"})
	w := startHookIdle(t, path, 0)
	// One poll is taken only after the first read of the old file.
	if n, done := w.poll(1); done {
		t.Fatalf("premature %+v", n)
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeEvents(t, path, hookEvent{Timestamp: 5, Type: "session_end", SessionID: "s"})
	if n, done := w.poll(3); !done || n.State != NoticeExited {
		t.Fatalf("rotation not followed: %v %+v", done, n)
	}
}

// Lines written to the old file between the watcher's last read and the
// rename are read before the new file is.
func TestEventTailDrainsTheRotatedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	writeEvents(t, path, hookEvent{Timestamp: 1, Type: "pre_tool_use", SessionID: "s"})
	var seen []int64
	observe := func(e hookEvent) { seen = append(seen, e.Timestamp) }
	tail := eventTail{path: path}
	defer tail.close()
	if err := tail.read(observe); err != nil {
		t.Fatal(err)
	}
	writeEvents(t, path, hookEvent{Timestamp: 2, Type: "stop", SessionID: "s"})
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeEvents(t, path, hookEvent{Timestamp: 3, Type: "session_end", SessionID: "s"})
	if err := tail.read(observe); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 || seen[0] != 1 || seen[1] != 2 || seen[2] != 3 {
		t.Fatalf("seen %v, want [1 2 3]", seen)
	}
}
