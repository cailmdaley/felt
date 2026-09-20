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
	"sync/atomic"
	"syscall"
	"testing"
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
func TestParseAddressRejectsNoncanonical(t *testing.T) {
	for _, s := range []string{"http://h/codex/id", "shuttle://H/codex/id", "shuttle://h/codex/id/extra", "shuttle://h/codex/%69d", "shuttle://h/codex/id?q=x"} {
		if _, err := ParseAddress(s); err == nil {
			t.Errorf("accepted %q", s)
		}
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

func TestDedupReservedIsNeverRetried(t *testing.T) {
	d := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", d)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "m1"}
	dir := filepath.Join(d, "messages")
	os.MkdirAll(dir, 0700)
	b, _ := json.Marshal(record{Hash: requestHash(req), State: "reserved"})
	name := sha256.Sum256([]byte(req.MessageID))
	os.WriteFile(filepath.Join(dir, hex.EncodeToString(name[:])+".json"), b, 0600)
	called := false
	r, err := withDedup(context.Background(), req, func() (Receipt, error) { called = true; return Receipt{}, nil })
	if called || r.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
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

func piFixture(t *testing.T, reply string) (string, string) {
	t.Helper()
	root := t.TempDir()
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
