package messaging

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/harness"
)

func TestReplyTargetValidation(t *testing.T) {
	t.Parallel()
	for _, target := range []string{"work/fiber", "", "bad\nheader", "bad\x00header", string(make([]byte, 1025))} {
		req := Request{Address: "shuttle://host/pi/s", Text: "hello", MessageID: "validation", ReplyTo: target}
		err := validateRequest("host", req)
		valid := target == "work/fiber" || target == ""
		if (err == nil) != valid {
			t.Fatalf("reply_to %q: %v", target, err)
		}
	}
}

func TestAddressRoundTrip(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	names := map[string]string{}
	for _, f := range harness.All() {
		names[f.Name], names[f.Ledger] = f.Name, f.Name
	}
	if !reflect.DeepEqual(names, fixture.Names) {
		t.Fatalf("Go harness names = %#v, shared fixture = %#v", names, fixture.Names)
	}
	for spelling, canonical := range fixture.Names {
		if got := harness.Normalize(spelling); got != canonical {
			t.Errorf("harness.Normalize(%q) = %q, want %q", spelling, got, canonical)
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
	for canonical, want := range map[string]string{"claude": "claude-code", "codex": "codex", "pi": "pi", "antigravity": "antigravity"} {
		if got := harness.LedgerName(canonical); got != want {
			t.Errorf("harness.LedgerName(%q) = %q, want %q", canonical, got, want)
		}
	}
}
func TestParseAddressRejectsNoncanonical(t *testing.T) {
	t.Parallel()
	for _, s := range []string{"http://h/codex/id", "shuttle://H/codex/id", "shuttle://h/codex/id/extra", "shuttle://h/codex/%69d", "shuttle://h/codex/id?q=x"} {
		if _, err := ParseAddress(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestSendNormalizesLedgerHarnessAlias(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "session", "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	request := Request{
		Address:   "shuttle://host/claude-code/session",
		Text:      "context",
		MessageID: "alias",
		Wake:      false,
	}
	receipt, err := Send(context.Background(), env, "host", request)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Address != "shuttle://host/claude/session" {
		t.Fatalf("receipt address = %q, want canonical address", receipt.Address)
	}
	// Normalization precedes the dedup hash, so the canonical spelling of the
	// same request replays the stored receipt instead of conflicting.
	request.Address = "shuttle://host/claude/session"
	replay, err := Send(context.Background(), env, "host", request)
	if err != nil || !reflect.DeepEqual(replay, receipt) {
		t.Fatalf("canonical replay = %#v, %v; want stored receipt %#v", replay, err, receipt)
	}
}

// plainSend adapts a context-free send to the dedup callback.
func plainSend(send func() (Receipt, error)) func(context.Context) (Receipt, error) {
	return func(context.Context) (Receipt, error) { return send() }
}

// Mutation: omit ReplyTo from requestHash; changed reply targets must conflict.
func TestDedupReplyTargetRetryAndConflict(t *testing.T) {
	t.Parallel()
	for _, original := range []string{"", "work/fiber"} {
		t.Run(original, func(t *testing.T) {
			env := testEnv(t)
			req := Request{Address: "shuttle://h/claude/s", Text: "hello", MessageID: "reply-dedup", ReplyTo: original}
			calls := 0
			send := plainSend(func() (Receipt, error) {
				calls++
				return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusQueued, Transport: "test"}, nil
			})
			first, err := withDedup(context.Background(), env, req, send)
			if err != nil {
				t.Fatal(err)
			}
			retry, err := withDedup(context.Background(), env, req, send)
			if err != nil || !reflect.DeepEqual(first, retry) || calls != 1 {
				t.Fatalf("retry: %#v %v calls=%d", retry, err, calls)
			}
			req.ReplyTo = "work/another"
			conflict, err := withDedup(context.Background(), env, req, send)
			if ErrorCode(err) != "message_id_conflict" || conflict.Status != StatusRejected || calls != 1 {
				t.Fatalf("changed reply target: %#v %v calls=%d", conflict, err, calls)
			}
		})
	}
}

func TestDedupReplayAndConflict(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "m1"}
	var calls atomic.Int32
	send := func() (Receipt, error) {
		calls.Add(1)
		return Receipt{MessageID: "m1", Address: req.Address, Status: StatusAccepted, Transport: "test"}, nil
	}
	a, err := withDedup(context.Background(), env, req, plainSend(send))
	if err != nil || a.Status != StatusAccepted {
		t.Fatalf("first: %#v %v", a, err)
	}
	b, err := withDedup(context.Background(), env, req, plainSend(send))
	if err != nil || !reflect.DeepEqual(b, a) || calls.Load() != 1 {
		t.Fatalf("replay: %#v %v calls=%d", b, err, calls.Load())
	}
	req.Text = "different"
	c, err := withDedup(context.Background(), env, req, plainSend(send))
	if ErrorCode(err) != "message_id_conflict" || c.Status != StatusRejected || calls.Load() != 1 {
		t.Fatalf("conflict: %#v %v", c, err)
	}
}

// TestDedupConcurrentFirstSendersSendOnce races sixteen first senders of one
// message_id, fifty times over: exactly one may own the reservation and send.
// A loser answers the stored receipt, or ambiguous_delivery while the
// winner's send is still unrecorded.
func TestDedupConcurrentFirstSendersSendOnce(t *testing.T) {
	t.Parallel()
	for round := 0; round < 50; round++ {
		t.Run(fmt.Sprint(round), func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "race"}
			var calls atomic.Int32
			var wg sync.WaitGroup
			start := make(chan struct{})
			errs := make([]error, 16)
			for g := 0; g < len(errs); g++ {
				wg.Add(1)
				go func(g int) {
					defer wg.Done()
					<-start
					_, errs[g] = withDedup(context.Background(), env, req, plainSend(func() (Receipt, error) {
						calls.Add(1)
						time.Sleep(5 * time.Millisecond)
						return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: "test"}, nil
					}))
				}(g)
			}
			close(start)
			wg.Wait()
			if calls.Load() != 1 {
				t.Fatalf("send ran %d times", calls.Load())
			}
			for g, err := range errs {
				if err != nil && ErrorCode(err) != "ambiguous_delivery" {
					t.Fatalf("sender %d: %v", g, err)
				}
			}
		})
	}
}

func TestDedupOwnNonceEEXISTIsTreatedAsReservationSuccess(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "nfs-replay.json")
	reservation := record{Hash: "h", State: "reserved", Nonce: "ours"}
	// NFS completes link(2) while losing its reply, so the retry reports
	// EEXIST for our just-published nonce.
	replayed := func(path string, b []byte) (bool, error) {
		if _, err := mailboxWriteReservation(path, b); err != nil {
			return false, err
		}
		return false, os.ErrExist
	}
	if owned, err := reserveDedupRecord(path, reservation, replayed); err != nil || !owned {
		t.Fatalf("own-nonce EEXIST: owned=%v %v", owned, err)
	}
	reservation.Nonce = "theirs"
	if owned, err := reserveDedupRecord(path, reservation, mailboxWriteReservation); !errors.Is(err, os.ErrExist) || owned {
		t.Fatalf("a competing sender's reservation: owned=%v %v", owned, err)
	}
}

func writeDedupRecord(t *testing.T, dir string, req Request, rec any) {
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

// A duplicate that arrives while the first send is in flight answers
// ambiguous_delivery at once, without sending; once the first has recorded
// its receipt, a repeat replays it.
func TestDedupConcurrentDuplicateIsAmbiguousAtOnce(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "concurrent"}
	want := Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: "test"}
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	var calls atomic.Int32
	send := func() (Receipt, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return want, nil
	}
	go func() {
		_, err := withDedup(context.Background(), env, req, plainSend(send))
		done <- err
	}()
	<-started
	if r, err := withDedup(context.Background(), env, req, plainSend(send)); ErrorCode(err) != "ambiguous_delivery" || r.Status != StatusUnknown {
		t.Fatalf("duplicate during the send: %#v %v", r, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if r, err := withDedup(context.Background(), env, req, plainSend(send)); err != nil || !reflect.DeepEqual(r, want) || calls.Load() != 1 {
		t.Fatalf("repeat after the send: %#v %v calls=%d", r, err, calls.Load())
	}
}

// A record without a receipt, a reservation whatever its owner, or an
// unreadable one, may stand for a send that happened: it answers
// ambiguous_delivery and is never sent again.
func TestDedupRecordWithoutAReceiptIsAmbiguous(t *testing.T) {
	t.Parallel()
	for name, rec := range map[string]func(Request) any{
		"reserved": func(r Request) any { return record{Hash: requestHash(r), State: "reserved"} },
		"reserved by a pid": func(r Request) any {
			return map[string]any{"hash": requestHash(r), "state": "reserved", "owner_pid": os.Getpid()}
		},
		"unreadable": func(Request) any { return "not a record" },
	} {
		t.Run(name, func(t *testing.T) {
			env := testEnv(t)
			req := Request{Address: "shuttle://h/codex/x", Text: "hello", MessageID: "unrecorded"}
			writeDedupRecord(t, dataDir(env), req, rec(req))
			called := false
			r, err := withDedup(context.Background(), env, req, plainSend(func() (Receipt, error) { called = true; return Receipt{}, nil }))
			if called || r.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
				t.Fatalf("got %#v %v called=%v", r, err, called)
			}
		})
	}
}

func TestDedupReleasesPreflightFailure(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req := Request{Address: "shuttle://h/codex/x", Text: "x", MessageID: "m"}
	calls := 0
	for range 2 {
		_, err := withDedup(context.Background(), env, req, plainSend(func() (Receipt, error) {
			calls++
			return rejected(req, "test", "offline"), errCode("preflight_failed", "offline")
		}))
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

func piFixture(t *testing.T, reply string, observe ...func([]byte)) (string, string) {
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
		frame, _ := bufio.NewReader(c).ReadBytes('\n')
		for _, fn := range observe {
			fn(frame)
		}
		c.Write([]byte(reply))
	}()
	jobs := filepath.Join(root, "project", "jobs")
	os.MkdirAll(jobs, 0700)
	job := map[string]any{"id": "job-1", "name": "worker", "status": "running", "phase": "idle", "cwd": "/work", "socketPath": sock, "piSessionId": "pi-session-1"}
	b, _ := json.Marshal(job)
	os.WriteFile(filepath.Join(jobs, "job-1.json"), b, 0600)
	return root, sock
}
func TestPiRequiresWake(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	r := Request{Address: "shuttle://h/pi/job-1", Text: "x", MessageID: "m"}
	got, err := (piAdapter{}).send(context.Background(), env, Address{Host: "h", Harness: "pi", ID: "job-1"}, r)
	if got.Status != StatusRejected || ErrorCode(err) != "wake_required" {
		t.Fatalf("%#v %v", got, err)
	}
}
func TestPiMalformedReplyIsUnknown(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root, _ := piFixture(t, "not-json\n")
	env.Set("SHUTTLE_CONFER_STATE_DIR", root)
	r := Request{Address: "shuttle://h/pi/job-1", Text: "x", MessageID: "m", Wake: true}
	got, err := (piAdapter{}).send(context.Background(), env, Address{Host: "h", Harness: "pi", ID: "job-1"}, r)
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
	t.Parallel()
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

// Confer keeps one record per job at <workspace>/jobs/<job>.json beside the
// job's own state directory. Discovery reads only that level: a JSON file
// deeper in a job's state, even one shaped like a job record, is not a job.
func TestPiDiscoveryReadsOnlyWorkspaceJobRecords(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root, sock := piFixture(t, "")
	env.Set("SHUTTLE_CONFER_STATE_DIR", root)
	nested := filepath.Join(root, "project", "jobs", "job-1", "session", "jobs")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"id": "job-nested", "socketPath": sock})
	if err := os.WriteFile(filepath.Join(nested, "job-nested.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "stray.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	ss, err := (piAdapter{}).discover(context.Background(), env, "h")
	if err != nil {
		t.Fatal(err)
	}
	if len(ss) != 1 || ss[0].ID != "job-1" || ss[0].State != "idle" || ss[0].Title != "worker" || ss[0].TranscriptID != "pi-session-1" {
		t.Fatalf("sessions = %#v", ss)
	}
	if _, err := findPi(context.Background(), env, "job-nested"); err == nil {
		t.Fatal("findPi resolved a record nested inside a job's state")
	}
	if j, err := findPi(context.Background(), env, "job-1"); err != nil || j.SocketPath != sock {
		t.Fatalf("findPi(job-1) = %#v, %v", j, err)
	}
}
