package messaging

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestAddressRoundTrip(t *testing.T) {
	raw, err := FormatAddress("host-1", "codex", "id/with spaces?yes")
	if err != nil {
		t.Fatal(err)
	}
	a, err := ParseAddress(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.Host != "host-1" || a.Harness != "codex" || a.ID != "id/with spaces?yes" {
		t.Fatalf("bad parse: %#v", a)
	}
}

func TestHarnessAliasesNormalizeAndMatchSharedFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "daemon", "test", "fixtures", "harness_names.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Names map[string]string `json:"names"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(addressHarnessNames, fixture.Names) {
		t.Fatalf("Go address harness names = %#v, shared fixture = %#v", addressHarnessNames, fixture.Names)
	}
	for spelling, canonical := range fixture.Names {
		if got := NormalizeHarness(spelling); got != canonical {
			t.Errorf("NormalizeHarness(%q) = %q, want %q", spelling, got, canonical)
		}
		address, err := FormatAddress("host", spelling, "session/id")
		if err != nil {
			t.Fatalf("FormatAddress(%q): %v", spelling, err)
		}
		want := "shuttle://host/" + canonical + "/session%2Fid"
		if address != want {
			t.Errorf("FormatAddress(%q) = %q, want %q", spelling, address, want)
		}
		parsed, err := ParseAddress("shuttle://host/" + spelling + "/session%2Fid")
		if err != nil {
			t.Fatalf("ParseAddress(%q): %v", spelling, err)
		}
		if parsed.Harness != canonical || parsed.ID != "session/id" {
			t.Errorf("ParseAddress(%q) = %#v", spelling, parsed)
		}
	}
	for canonical, want := range map[string]string{"claude": "claude-code", "codex": "codex", "pi": "pi"} {
		if got := LedgerHarnessName(canonical); got != want {
			t.Errorf("LedgerHarnessName(%q) = %q, want %q", canonical, got, want)
		}
	}
}
func TestParseAddressRejectsNoncanonical(t *testing.T) {
	for _, s := range []string{"http://h/codex/id", "shuttle://H/codex/id", "shuttle://h/codex/id/extra", "shuttle://h/codex/%69d", "shuttle://h/codex/id?q=x"} {
		if _, err := ParseAddress(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestSendNormalizesLedgerHarnessAlias(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	if err := RegisterMailbox("claude", "session", "host", "/work", true); err != nil {
		t.Fatal(err)
	}
	request := Request{
		Address:   "shuttle://host/claude-code/session",
		Text:      "context",
		MessageID: "alias",
		Wake:      false,
	}
	receipt, err := Send(context.Background(), "host", request)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Address != "shuttle://host/claude/session" {
		t.Fatalf("receipt address = %q, want canonical address", receipt.Address)
	}
}

func TestDedupReplayAndConflict(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "m1"}
	var calls atomic.Int32
	send := func() (Receipt, error) {
		calls.Add(1)
		return Receipt{MessageID: "m1", Address: req.Address, Status: StatusAccepted, Transport: "test"}, nil
	}
	a, err := withDedup(context.Background(), req, send)
	if err != nil || a.Status != StatusAccepted {
		t.Fatalf("first: %#v %v", a, err)
	}
	b, err := withDedup(context.Background(), req, send)
	if err != nil || !reflect.DeepEqual(b, a) || calls.Load() != 1 {
		t.Fatalf("replay: %#v %v calls=%d", b, err, calls.Load())
	}
	req.Text = "different"
	c, err := withDedup(context.Background(), req, send)
	if ErrorCode(err) != "message_id_conflict" || c.Status != StatusRejected || calls.Load() != 1 {
		t.Fatalf("conflict: %#v %v", c, err)
	}
}

func writeDedupRecord(t *testing.T, dir string, req Request, rec record) {
	t.Helper()
	messages := filepath.Join(dir, "messages")
	if err := os.MkdirAll(messages, 0700); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	name := sha256.Sum256([]byte(req.MessageID))
	path := filepath.Join(messages, hex.EncodeToString(name[:])+".json")
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDedupConcurrentDuplicateWaitsForCompletion(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "concurrent"}
	want := Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: "test"}
	started := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan struct {
		receipt Receipt
		err     error
	}, 1)
	duplicateDone := make(chan struct {
		receipt Receipt
		err     error
	}, 1)
	var calls atomic.Int32
	send := func() (Receipt, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return want, nil
	}
	go func() {
		r, err := withDedup(context.Background(), req, send)
		firstDone <- struct {
			receipt Receipt
			err     error
		}{r, err}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("first send did not start")
	}

	waiting := make(chan struct{})
	var waitingOnce sync.Once
	go func() {
		r, err := withDedupTiming(context.Background(), req, send, time.Second, time.Millisecond, func() {
			waitingOnce.Do(func() { close(waiting) })
		})
		duplicateDone <- struct {
			receipt Receipt
			err     error
		}{r, err}
	}()
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("duplicate did not observe the live reservation")
	}
	close(release)

	first := <-firstDone
	duplicate := <-duplicateDone
	if first.err != nil || !reflect.DeepEqual(first.receipt, want) {
		t.Fatalf("first: %#v %v", first.receipt, first.err)
	}
	if duplicate.err != nil || !reflect.DeepEqual(duplicate.receipt, want) {
		t.Fatalf("duplicate: %#v %v", duplicate.receipt, duplicate.err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("send callback ran %d times, want once", got)
	}
}

func TestDedupDeadOwnerIsAmbiguousAndNotRetried(t *testing.T) {
	d := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", d)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "dead-owner"}
	writeDedupRecord(t, d, req, record{Hash: requestHash(req), State: "reserved", OwnerPID: 1 << 30})
	called := false
	r, err := withDedup(context.Background(), req, func() (Receipt, error) { called = true; return Receipt{}, nil })
	const detail = "a previous attempt stopped mid-delivery; it may or may not have been delivered"
	if called || r.Status != StatusUnknown || r.Detail != detail || ErrorCode(err) != "ambiguous_delivery" || err.Error() != detail {
		t.Fatalf("got %#v %v called=%v", r, err, called)
	}
}

func TestDedupLiveReservationWaitExpires(t *testing.T) {
	d := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", d)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "live-owner"}
	writeDedupRecord(t, d, req, record{Hash: requestHash(req), State: "reserved", OwnerPID: os.Getpid(), OwnerStart: currentProcessStartTime()})
	called := false
	r, err := withDedupTimeout(context.Background(), req, func() (Receipt, error) { called = true; return Receipt{}, nil }, 20*time.Millisecond)
	const detail = "an identical delivery is still in progress; retry with the same message_id"
	if called || r.Status != StatusUnknown || r.Detail != detail || ErrorCode(err) != "ambiguous_delivery" || err.Error() != detail {
		t.Fatalf("got %#v %v called=%v", r, err, called)
	}
}

func TestDedupLegacyReservedRecordKeepsAmbiguousBehavior(t *testing.T) {
	d := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", d)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "legacy"}
	writeDedupRecord(t, d, req, record{Hash: requestHash(req), State: "reserved"})
	called := false
	r, err := withDedup(context.Background(), req, func() (Receipt, error) { called = true; return Receipt{}, nil })
	if called || r.Status != StatusUnknown || r.Detail != "delivery may have been attempted" || ErrorCode(err) != "ambiguous_delivery" || err.Error() != "delivery may have been attempted; refusing to resend" {
		t.Fatalf("got %#v %v called=%v", r, err, called)
	}
}

func TestDedupReleasesPreflightFailure(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	req := Request{Address: "shuttle://h/codex/x", Text: "x", MessageID: "m"}
	calls := 0
	for range 2 {
		_, err := withDedup(context.Background(), req, func() (Receipt, error) {
			calls++
			return rejected(req, "test", "offline"), errCode("preflight_failed", "offline")
		})
		if ErrorCode(err) != "preflight_failed" {
			t.Fatalf("got %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("safe retry suppressed: calls=%d", calls)
	}
}

// socketTempDir is a private temp dir short enough for Unix socket paths:
// t.TempDir() under macOS's $TMPDIR, plus a test name, overruns sun_path.
func socketTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "felt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func piFixture(t *testing.T, reply string) (string, string) {
	t.Helper()
	root := socketTempDir(t)
	sock := filepath.Join(root, "worker.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		if errors.Is(err, syscall.EPERM) {
			t.Skip("sandbox disallows Unix sockets")
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		bufio.NewReader(c).ReadBytes('\n')
		c.Write([]byte(reply))
	}()
	jobs := filepath.Join(root, "project", "jobs")
	os.MkdirAll(jobs, 0700)
	job := map[string]any{"id": "job-1", "name": "worker", "status": "running", "phase": "idle", "cwd": "/work", "socketPath": sock}
	b, _ := json.Marshal(job)
	os.WriteFile(filepath.Join(jobs, "job-1.json"), b, 0600)
	return root, sock
}
func TestPiRequiresWake(t *testing.T) {
	r := Request{Address: "shuttle://h/pi/job-1", Text: "x", MessageID: "m"}
	got, err := (piAdapter{}).send(context.Background(), Address{Host: "h", Harness: "pi", ID: "job-1"}, r)
	if got.Status != StatusRejected || ErrorCode(err) != "wake_required" {
		t.Fatalf("%#v %v", got, err)
	}
}
func TestPiMalformedReplyIsUnknown(t *testing.T) {
	root, _ := piFixture(t, "not-json\n")
	t.Setenv("SHUTTLE_CONFER_STATE_DIR", root)
	r := Request{Address: "shuttle://h/pi/job-1", Text: "x", MessageID: "m", Wake: true}
	got, err := (piAdapter{}).send(context.Background(), Address{Host: "h", Harness: "pi", ID: "job-1"}, r)
	if got.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("%#v %v", got, err)
	}
}

func FuzzParseAddress(f *testing.F) {
	for _, s := range []string{"shuttle://h/codex/id", "", "shuttle://h/pi/a%2Fb", "shuttle://x/tmux/%00"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		a, err := ParseAddress(s)
		if err == nil {
			round, e := FormatAddress(a.Host, a.Harness, a.ID)
			if e != nil || round != s {
				t.Fatalf("non-round-trip: %q %#v %v", s, a, e)
			}
		}
	})
}

func FuzzPiReply(f *testing.F) {
	f.Add([]byte(`{"ok":true,"delivery":"steer"}`))
	f.Add([]byte(`null`))
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"ok":false,"error":"busy"}`))
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = decodePiReply(b)
	})
}

func TestDecodePiReplyShape(t *testing.T) {
	for _, tc := range []struct {
		in        string
		valid, ok bool
	}{{`{"ok":true,"delivery":"steer"}`, true, true}, {`{"ok":false}`, true, false}, {`{}`, false, false}, {`null`, false, false}, {`{"ok":true}`, false, false}, {`{"ok":"yes","delivery":"x"}`, false, false}, {`{"ok":true,"delivery":"x"} {}`, false, false}} {
		got, err := decodePiReply([]byte(tc.in))
		if (err == nil) != tc.valid || err == nil && got.OK != tc.ok {
			t.Errorf("%s => %#v, %v", tc.in, got, err)
		}
	}
}
