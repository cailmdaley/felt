package shuttlecli

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func runScheduledMessage(t *testing.T, a *app, args ...string) (string, string, error) {
	t.Helper()
	var out, stderr bytes.Buffer
	a.env.Stdout, a.env.Stderr = &out, &stderr
	cmd := a.messageCmd(&messageOptions{})
	cmd.SetOut(&out)
	cmd.SetErr(&stderr)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), stderr.String(), err
}

func TestResolveMessageTime(t *testing.T) {
	paris, _ := time.LoadLocation("Europe/Paris")
	now := time.Date(2026, 11, 15, 16, 0, 0, 0, time.UTC)
	for _, tc := range []struct{ in, at, want string }{
		{"90m", "", "2026-11-15T17:30:00Z"}, {"2d", "", "2026-11-17T16:00:00Z"},
		{"", "18:00", "2026-11-15T17:00:00Z"}, {"", "17:00", "2026-11-16T16:00:00Z"},
		{"", "2026-11-16 09:00", "2026-11-16T08:00:00Z"}, {"", "2026-11-16T09:00:00-08:00", "2026-11-16T17:00:00Z"},
	} {
		got, err := resolveMessageTime(tc.in, tc.at, now, paris)
		if err != nil || got.Format(time.RFC3339) != tc.want {
			t.Fatalf("%+v: %s %v", tc, got, err)
		}
	}
	for _, tc := range [][2]string{{"-1h", ""}, {"0s", ""}, {"", "2026-11-15 16:00"}, {"", "nonsense"}} {
		if _, err := resolveMessageTime(tc[0], tc[1], now, paris); err == nil {
			t.Fatal(tc)
		}
	}
}

func TestMessageTimeAcrossClockChangesAndSubsecondDuration(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	now := time.Date(2026, 11, 1, 5, 45, 0, 0, time.UTC)
	got, err := resolveMessageTime("", "01:30", now, ny)
	if err != nil || got.Format(time.RFC3339) != "2026-11-01T06:30:00Z" {
		t.Fatalf("%s %v", got, err)
	}
	now = time.Date(2026, 3, 8, 6, 45, 0, 0, time.UTC)
	got, err = resolveMessageTime("", "02:30", now, ny)
	if err != nil || got.Format(time.RFC3339) != "2026-03-09T06:30:00Z" {
		t.Fatalf("%s %v", got, err)
	}
	if _, err := resolveMessageTime("", "2026-03-08 02:30", now, ny); err == nil {
		t.Fatal("nonexistent local time accepted")
	}
	got, err = resolveMessageTime("1ms", "", now, ny)
	if err != nil || got.Sub(now) != time.Millisecond {
		t.Fatalf("%s %v", got, err)
	}
}

func TestDelayedMessageWire(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"scheduled"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})
	out, _, err := runScheduledMessage(t, newApp(env), "work/worker", "check the fit", "--in", "8h", "--message-id", "later")
	if err != nil || !strings.Contains(out, "scheduled") || !strings.Contains(out, "UTC") {
		t.Fatalf("%s %v", out, err)
	}
	got := requests()
	if len(got) != 1 || got[0]["not_before"] == "" || got[0]["turn"] != "ask" {
		t.Fatal(got)
	}
}

// delayedSendEnv is a host whose store holds work/worker and work/own, both
// owned by worker-node, with a /deliver stub that records what it is sent. own is work/own's file, for a sender that is its worker.
func delayedSendEnv(t *testing.T) (env *sysenv.Env, own string, requests func() []map[string]any) {
	t.Helper()
	env = testEnv(t)
	store, storage := newStore(t)
	for _, f := range []struct{ id, uid string }{{"work/worker", messageTargetFiberUID}, {"work/own", "01BX5ZZKBKACTAV9WEVGEMMVRZ"}} {
		fiber := &felt.Felt{ID: f.id, UID: f.uid, Name: f.id}
		if err := fiber.SetExtraField("shuttle", map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		if err := storage.Write(fiber); err != nil {
			t.Fatal(err)
		}
	}
	matches, _ := filepath.Glob(filepath.Join(store, ".felt", "work", "own", "*.md"))
	if len(matches) != 1 {
		t.Fatalf("own fiber file: %v", matches)
	}
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"scheduled"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver": deliver,
	})
	return env, matches[0], requests
}

func TestDelayedMessageRefusals(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"shuttle://hub/pi/session", "later", "--in", "8h"}, "goes to a fiber"},
		{[]string{"work/wroker", "later", "--in", "8h"}, `no fiber "work/wroker"`},
		{[]string{"work/worker", "later", "--in", "8h", "--fresh"}, "--fresh"},
		{[]string{"later", "--in", "8h"}, "no fiber belongs to this session"},
		{[]string{"work/worker", "later", "--in", "8h", "--at", "18:00"}, "mutually exclusive"},
		{[]string{"work/worker", "later", "--in", ""}, "need a time"},
		{[]string{"work/worker", "--notify-when-idle", "--in", "8h"}, "needs text"},
	} {
		env, _, requests := delayedSendEnv(t)
		_, _, err := runScheduledMessage(t, newApp(env), tc.args...)
		if err == nil || !strings.Contains(err.Error(), tc.want) || len(requests()) != 0 {
			t.Errorf("%v: err=%v sent=%v, want a refusal naming %q", tc.args, err, requests(), tc.want)
		}
	}
}

// A delayed send whose body comes from --file or --attach names its target in
// its one argument, even from a worker session with a fiber of its own.
func TestDelayedFileOrAttachmentKeepsItsTarget(t *testing.T) {
	for _, flag := range []string{"--file", "--attach"} {
		t.Run(flag, func(t *testing.T) {
			env, own, requests := delayedSendEnv(t)
			env.Set("SHUTTLE_FIBER_PATH", own)
			note := filepath.Join(t.TempDir(), "note.md")
			if err := os.WriteFile(note, []byte("check the fit converged"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := runScheduledMessage(t, newApp(env), "work/worker", flag, note, "--in", "8h"); err != nil {
				t.Fatal(err)
			}
			got := requests()
			if len(got) != 1 || got[0]["fiber_id"] != messageTargetFiberUID || got[0]["text"] == "work/worker" {
				t.Fatalf("sent %v, want one message to work/worker (%s)", got, messageTargetFiberUID)
			}
		})
	}
}

// With only text, a delayed send goes to the sender's own fiber.
func TestDelayedTextAloneGoesToOwnFiber(t *testing.T) {
	env, own, requests := delayedSendEnv(t)
	env.Set("SHUTTLE_FIBER_PATH", own)
	if _, _, err := runScheduledMessage(t, newApp(env), "check the fit", "--in", "8h"); err != nil {
		t.Fatal(err)
	}
	if got := requests(); len(got) != 1 || got[0]["fiber_id"] != "01BX5ZZKBKACTAV9WEVGEMMVRZ" || got[0]["text"] != "check the fit" {
		t.Fatalf("sent %v, want the text on work/own", got)
	}
}

// A retry that replaces --in with --at and the printed instant names the same
// publication, and a fiber's uid is a delayed target like its id.
func TestDelayedRetryWithPrintedInstant(t *testing.T) {
	env, _, requests := delayedSendEnv(t)
	if _, _, err := runScheduledMessage(t, newApp(env), "work/worker", "check", "--in", "8h", "--message-id", "X"); err != nil {
		t.Fatal(err)
	}
	instant, _ := requests()[0]["not_before"].(string)
	if _, _, err := runScheduledMessage(t, newApp(env), messageTargetFiberUID, "check", "--at", instant, "--message-id", "X"); err != nil {
		t.Fatal(err)
	}
	got := requests()
	if len(got) != 2 || got[1]["not_before"] != instant || got[1]["fiber_id"] != messageTargetFiberUID {
		t.Fatalf("sent %v, want the retry to carry %s to %s", got, instant, messageTargetFiberUID)
	}
}

// A scheduled message a stale daemon would not deliver prints only the
// refusal; one that is sent first prints the command that retries it.
func TestScheduledMessageRefusalIsAllItPrints(t *testing.T) {
	for _, tc := range []struct {
		name  string
		level int
	}{{"stale", ShuttleContractLevel - 1}, {"level", ShuttleContractLevel}} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "hub", "agent": "claude-opus", "project_dir": t.TempDir()})
			isolateMessageFiberStore(env, store)
			deliver, _ := dormantDeliverStub(202, `{"queued":true,"status":"scheduled"}`)
			daemonStub(t, env, map[string]http.HandlerFunc{
				"/api/v1/version": versionBody("hub", "2.1.0", tc.level),
				"/api/v1/deliver": deliver,
			})
			_, stderr, err := runScheduledMessage(t, newApp(env), "work/worker", "later", "--in", "8h", "--message-id", "later")
			if tc.level != ShuttleContractLevel {
				if err == nil || !strings.Contains(err.Error(), "without delivering") || stderr != "Error: "+err.Error()+"\n" {
					t.Fatalf("err=%v stderr=%q, want the refusal alone", err, stderr)
				}
				return
			}
			if err != nil || !strings.Contains(stderr, "to retry, send it again with --message-id later") {
				t.Fatalf("err=%v stderr=%q", err, stderr)
			}
		})
	}
}
