package messaging

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// An idle subscription asks to hear, once, when a receiver next ends a turn
// with nothing queued or running, or exits. The owning host records it and a
// detached watcher observes the receiver; the notice goes back to the
// subscriber (the request's From address) as an ordinary Shuttle message.
//
// Claude receivers carry the subscription natively: Claude Code's inbox takes
// a `notify_when_idle` control frame and answers with `peer_idle_notice`
// (state `idle` or `exited`) once its turn has ended, its debounce has passed,
// and no queued or held message remains. That notice does not wait for
// background tasks, so the turn's Stop hook event is checked too. Other harnesses are watched
// through the host's hook event stream: a `stop` that leaves no background
// task, not followed within the grace window by further activity, is idle; a
// `session_end` is an exit.

const (
	StatusSubscribed = "subscribed"

	IdleWatching    = "watching"
	IdleUnsupported = "unsupported"

	IdleSignalClaudeNative = "claude-native"
	IdleSignalHookEvents   = "hook-events"

	NoticeIdle    = "idle"
	NoticeExited  = "exited"
	NoticeExpired = "expired"
)

// IdleSubscriptionLifetime matches Claude Code's own subscription lifetime,
// after which an unfired native subscription is silently dropped.
const IdleSubscriptionLifetime = 12 * time.Hour

const idleHookGrace = 2 * time.Second

// IdleSubscription is the receipt's account of the subscription.
type IdleSubscription struct {
	State  string `json:"state"`
	Signal string `json:"signal,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// IdleRecord is the subscription as persisted on the receiver's host.
type IdleRecord struct {
	MessageID  string `json:"message_id"`
	Address    string `json:"address"`
	Subscriber string `json:"subscriber"`
	Wake       bool   `json:"wake"`
	Signal     string `json:"signal"`
	CreatedAt  int64  `json:"created_at"`
	// EventsOffset is where a hook-event watcher starts reading.
	EventsOffset int64 `json:"events_offset,omitempty"`
}

// IdleNotice is what the watcher observed.
type IdleNotice struct {
	State      string
	FinishedAt time.Time
	Detail     string
}

// SpawnIdleWatcher starts the detached watcher for a recorded subscription.
// The shuttle CLI installs it; it is nil (and subscriptions unsupported) in a
// process that cannot run one.
var SpawnIdleWatcher func(recordPath string) error

func idleDir(env *sysenv.Env) string { return filepath.Join(dataDir(env), "idle") }

func idleRecordPath(env *sysenv.Env, req Request) string {
	h := sha256.Sum256([]byte(req.Address + "\x00" + req.MessageID))
	return filepath.Join(idleDir(env), hex.EncodeToString(h[:16])+".json")
}

func eventsFile(env *sysenv.Env) string {
	if path := env.Getenv("SHUTTLE_EVENTS_FILE"); path != "" {
		return env.Resolve(path)
	}
	return filepath.Join(dataDir(env), "events.jsonl")
}

// subscribeIdle records the subscription and starts its watcher. It never
// fails the message it rides on; the receipt states what was set up.
func subscribeIdle(env *sysenv.Env, a Address, req Request) *IdleSubscription {
	unsupported := func(detail string) *IdleSubscription {
		return &IdleSubscription{State: IdleUnsupported, Detail: detail}
	}
	if SpawnIdleWatcher == nil {
		return unsupported("this process cannot start an idle watcher")
	}
	subscriber := req.NotifyAddress
	if subscriber == "" {
		subscriber = req.From
	}
	rec := IdleRecord{MessageID: req.MessageID, Address: req.Address, Subscriber: subscriber, Wake: req.NotifyWake, CreatedAt: time.Now().Unix()}
	switch a.Harness {
	case "claude":
		if !claudeNativeAvailable(env, a.ID, a.Host) {
			return unsupported("Claude session has no live native inbox to subscribe to")
		}
		rec.Signal = IdleSignalClaudeNative
	case "codex", "pi":
		rec.Signal = IdleSignalHookEvents
	default:
		return unsupported("no idle signal for harness " + a.Harness)
	}
	if info, err := os.Stat(eventsFile(env)); err == nil {
		rec.EventsOffset = info.Size()
	}
	path := idleRecordPath(env, req)
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return unsupported("cannot record subscription: " + err.Error())
	}
	b, _ := json.Marshal(rec)
	if err := mailboxWrite(path, b, true); err != nil {
		if errors.Is(err, os.ErrExist) {
			return &IdleSubscription{State: IdleWatching, Signal: rec.Signal, Detail: "already subscribed under this message id"}
		}
		return unsupported("cannot record subscription: " + err.Error())
	}
	if err := SpawnIdleWatcher(path); err != nil {
		_ = os.Remove(path)
		return unsupported("cannot start idle watcher: " + err.Error())
	}
	detail := "one notice when the receiver next ends a turn with nothing queued or running, or exits"
	if rec.Signal == IdleSignalHookEvents {
		detail += "; observed through hook events, which do not see messages queued inside the harness"
	}
	return &IdleSubscription{State: IdleWatching, Signal: rec.Signal, Detail: detail}
}

func ReadIdleRecord(path string) (IdleRecord, error) {
	var rec IdleRecord
	b, err := readBounded(path, 16384)
	if err == nil {
		err = json.Unmarshal(b, &rec)
	}
	return rec, err
}

// WatchIdle blocks until the receiver goes idle, exits, or the subscription
// expires. An expired notice claims nothing about the receiver's state.
func WatchIdle(ctx context.Context, env *sysenv.Env, rec IdleRecord) IdleNotice {
	deadline := time.Unix(rec.CreatedAt, 0).Add(IdleSubscriptionLifetime)
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	a, err := ParseAddress(rec.Address)
	if err != nil {
		return IdleNotice{State: NoticeExpired, Detail: err.Error()}
	}
	var n IdleNotice
	switch rec.Signal {
	case IdleSignalClaudeNative:
		n, err = watchClaudeIdle(ctx, env, a, rec)
		// Claude's native notice waits out queued input but not background
		// tasks. The turn's Stop hook says what it left running; work still
		// outstanding hands the watch to the hook stream, where only a quiet
		// stop or an exit ends it.
		if err == nil && n.State == NoticeIdle {
			if after, busy := claudeStopLeftWork(ctx, eventsFile(env), a.ID, rec.EventsOffset, n.FinishedAt); busy {
				n, err = watchHookIdle(ctx, eventsFile(env), a.ID, after)
			}
		}
	case IdleSignalHookEvents:
		n, err = watchHookIdle(ctx, eventsFile(env), a.ID, rec.EventsOffset)
	default:
		err = fmt.Errorf("unknown idle signal %q", rec.Signal)
	}
	if err != nil {
		detail := "no idle or exit was observed within the subscription's lifetime"
		if !errors.Is(err, context.DeadlineExceeded) {
			detail = "the watcher stopped before observing idle or exit: " + err.Error()
		}
		return IdleNotice{State: NoticeExpired, Detail: detail}
	}
	return n
}

// IdleNoticeID is the notice's own message id: bounded, and distinct per
// receiver so one subscription id reused across receivers cannot conflict.
func IdleNoticeID(rec IdleRecord) string {
	h := sha256.Sum256([]byte(rec.Address + "\x00" + rec.MessageID))
	return "idle-notice-" + hex.EncodeToString(h[:16])
}

func idleUUID(rec IdleRecord) string {
	return claudeNativeUUID(Request{Address: rec.Address, MessageID: "idle\x00" + rec.MessageID})
}

func watchClaudeIdle(ctx context.Context, env *sysenv.Env, a Address, rec IdleRecord) (IdleNotice, error) {
	r, err := readClaudeNative(env, a.ID)
	if err != nil || r.ID != a.ID || r.Host != a.Host {
		return IdleNotice{}, fmt.Errorf("Claude receiver registration is gone")
	}
	uuid := idleUUID(rec)
	listener, path, err := listenBesideSocket(r.Socket)
	if err != nil {
		return IdleNotice{}, err
	}
	defer listener.Close()
	defer os.Remove(path)
	if err := os.Chmod(path, 0600); err != nil {
		return IdleNotice{}, err
	}
	notices := make(chan IdleNotice, 1)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			if n, ok := readClaudeIdleNotice(conn, r, uuid); ok {
				select {
				case notices <- n:
				default:
				}
			}
			conn.Close()
		}
	}()
	dialCtx, cancelDial := context.WithTimeout(ctx, claudeNativePreflightTimeout)
	conn, err := connectClaudeNative(dialCtx, r)
	cancelDial()
	if err != nil {
		return IdleNotice{}, err
	}
	frame, _ := json.Marshal(map[string]string{"type": "control", "action": "notify_when_idle", "from": "uds:" + path, "msg_id": uuid})
	_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err = conn.Write(append(frame, '\n'))
	conn.Close()
	if err != nil {
		return IdleNotice{}, err
	}
	// Claude sends `exited` on a clean shutdown; a crash sends nothing, so the
	// watcher also checks that the registered endpoint still answers.
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case n := <-notices:
			return n, nil
		case <-ctx.Done():
			return IdleNotice{}, ctx.Err()
		case <-ticker.C:
			probeCtx, cancelProbe := context.WithTimeout(ctx, claudeNativePreflightTimeout)
			probe, probeErr := connectClaudeNative(probeCtx, r)
			cancelProbe()
			if probeErr == nil {
				probe.Close()
			} else {
				select {
				case n := <-notices:
					return n, nil
				case <-time.After(time.Second):
				}
				return IdleNotice{State: NoticeExited, FinishedAt: time.Now(), Detail: "the receiver's native inbox stopped answering; Shuttle observed the process gone"}, nil
			}
		}
	}
}

func readClaudeIdleNotice(conn net.Conn, r claudeNativeRegistration, uuid string) (IdleNotice, bool) {
	if pid, err := claudePeerPID(conn); err != nil || pid != r.PID {
		return IdleNotice{}, false
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		var f struct {
			Type       string `json:"type"`
			Action     string `json:"action"`
			ID         string `json:"orig_msg_id"`
			State      string `json:"state"`
			FinishedAt *int64 `json:"finished_at"`
			Detail     string `json:"detail"`
		}
		if json.Unmarshal(scanner.Bytes(), &f) != nil || f.Action != "peer_idle_notice" || f.ID != uuid {
			continue
		}
		n := IdleNotice{State: f.State, Detail: f.Detail, FinishedAt: time.Now()}
		if f.FinishedAt != nil {
			n.FinishedAt = time.UnixMilli(*f.FinishedAt)
		}
		if n.State != NoticeIdle && n.State != NoticeExited {
			n.Detail = "native notice state " + f.State
		}
		return n, true
	}
	return IdleNotice{}, false
}

type hookEvent struct {
	Timestamp       int64  `json:"timestamp"`
	Type            string `json:"type"`
	SessionID       string `json:"sessionId"`
	BackgroundTasks int    `json:"backgroundTasks"`
	Tool            string `json:"tool,omitempty"`
}

// watchHookIdle tails the event stream from offset. A `stop` with no
// background task becomes idle once the grace window passes with no further
// activity for the session; any activity in the window cancels it.
func watchHookIdle(ctx context.Context, path, sessionID string, offset int64) (IdleNotice, error) {
	var f *os.File
	defer func() {
		if f != nil {
			f.Close()
		}
	}()
	var reader *bufio.Reader
	var pending []byte
	var candidate *hookEvent
	var candidateSeen time.Time
	// Codex stops do not count spawned agents; the stream does, as
	// spawn_agent/followup_task tool calls less subagent_stop events.
	children := 0
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if f == nil {
			opened, err := os.Open(path)
			if err == nil {
				if info, statErr := opened.Stat(); statErr == nil && info.Size() < offset {
					offset = 0
				}
				if _, err := opened.Seek(offset, io.SeekStart); err != nil {
					opened.Close()
					return IdleNotice{}, err
				}
				f, reader = opened, bufio.NewReaderSize(opened, 64<<10)
			}
		}
		for reader != nil {
			chunk, err := reader.ReadSlice('\n')
			pending = append(pending, chunk...)
			if len(pending) > 1<<20 {
				pending = nil
			}
			if err != nil {
				if errors.Is(err, bufio.ErrBufferFull) {
					continue
				}
				break
			}
			var e hookEvent
			line := pending
			pending = nil
			if json.Unmarshal(line, &e) != nil || e.SessionID != sessionID {
				continue
			}
			switch e.Type {
			case "session_end":
				return IdleNotice{State: NoticeExited, FinishedAt: time.UnixMilli(e.Timestamp)}, nil
			case "stop":
				if e.BackgroundTasks == 0 {
					ev := e
					candidate, candidateSeen = &ev, time.Now()
				} else {
					candidate = nil
				}
			case "subagent_stop":
				children--
			case "notification":
			case "post_tool_use":
				if e.Tool == "spawn_agent" || e.Tool == "followup_task" {
					children++
				}
				candidate = nil
			default:
				candidate = nil
			}
		}
		if f != nil && reader != nil {
			// The stream rotates by rename; a new file at the path restarts
			// the read from its beginning.
			if cur, err := os.Stat(path); err == nil {
				if held, err := f.Stat(); err == nil && !os.SameFile(cur, held) {
					f.Close()
					f, reader, offset, pending = nil, nil, 0, nil
					continue
				}
			}
		}
		if candidate != nil && children <= 0 && time.Since(candidateSeen) >= idleHookGrace {
			return IdleNotice{State: NoticeIdle, FinishedAt: time.UnixMilli(candidate.Timestamp)}, nil
		}
		select {
		case <-ctx.Done():
			return IdleNotice{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// claudeStopLeftWork finds the Stop event that ended the turn at finishedAt
// and reports whether it left background tasks running, with the stream
// offset just past it. A Stop not yet written is waited for briefly; none at
// all means the hooks are silent, and the native notice stands.
func claudeStopLeftWork(ctx context.Context, path, sessionID string, offset int64, finishedAt time.Time) (int64, bool) {
	// An already-idle receiver answers at once with the time its last turn
	// ended, so the Stop that matters may predate the subscription.
	offset = max(0, offset-(4<<20))
	deadline := time.Now().Add(3 * time.Second)
	for {
		if after, e, ok := lastStop(path, sessionID, offset); ok && e.Timestamp >= finishedAt.UnixMilli()-2000 {
			return after, e.BackgroundTasks > 0
		}
		if time.Now().After(deadline) {
			return 0, false
		}
		select {
		case <-ctx.Done():
			return 0, false
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func lastStop(path, sessionID string, offset int64) (int64, hookEvent, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, hookEvent{}, false
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || info.Size() < offset {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, hookEvent{}, false
	}
	reader := bufio.NewReaderSize(f, 64<<10)
	var found hookEvent
	var after int64
	ok := false
	pos := offset
	for {
		line, err := reader.ReadBytes('\n')
		pos += int64(len(line))
		if err != nil {
			return after, found, ok
		}
		var e hookEvent
		if json.Unmarshal(line, &e) == nil && e.SessionID == sessionID && e.Type == "stop" {
			found, after, ok = e, pos, true
		}
	}
}

// IdleNoticeText is the message the subscriber receives.
func IdleNoticeText(rec IdleRecord, n IdleNotice) string {
	at := ""
	if !n.FinishedAt.IsZero() {
		at = " at " + n.FinishedAt.UTC().Format(time.RFC3339)
	}
	var s string
	switch n.State {
	case NoticeIdle:
		s = fmt.Sprintf("Idle notice: %s ended its turn%s with nothing queued or running. Idle is not done; read its fiber or transcript for what it finished.", rec.Address, at)
	case NoticeExited:
		s = fmt.Sprintf("Idle notice: %s exited%s.", rec.Address, at)
	default:
		s = fmt.Sprintf("Idle notice: the subscription to %s expired; Shuttle makes no claim about the receiver's state.", rec.Address)
	}
	if n.Detail != "" {
		s += " (" + n.Detail + ")"
	}
	return s + " [subscription " + rec.MessageID + "]"
}
