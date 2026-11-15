package messaging

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestConsumeForceIncludesContextButNotBusyIdleOrFuture(t *testing.T) {
	env, w := consumeFixture(t)
	for _, turn := range []string{"none", "ask", "idle", "force"} {
		putWish(t, env, turn, turn, "hold")
	}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "future", Text: "future"}, Wishes: Wishes{Turn: "force", NotBefore: "2999-01-01T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		for _, id := range []string{"none", "ask", "force"} {
			if !strings.Contains(r.Text, "text of "+id) {
				t.Fatalf("missing %s", id)
			}
		}
		if strings.Contains(r.Text, "text of idle") || strings.Contains(r.Text, "future") {
			t.Fatalf("took ineligible context: %s", r.Text)
		}
		return Receipt{Status: StatusAccepted}, nil
	})
	if err != nil || len(result.Members) != 3 {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestConsumeLifecycleLimit(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	scripts := t.TempDir()
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte("#!/bin/sh\nprintf '{\"current\":true}\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	for _, id := range []string{"thread-one", "thread-two"} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: "thread child closed: " + id, ThreadSignal: &ThreadSignal{UID: id, Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}}, Wishes: Wishes{Turn: "ask"}}); err != nil {
			t.Fatal(err)
		}
	}
	putWish(t, env, "ordinary", "ask", "hold")
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		if strings.Count(r.Text, "thread child closed:") != 1 || !strings.Contains(r.Text, "ordinary") {
			t.Fatalf("wrong lifecycle window: %s", r.Text)
		}
		return Receipt{Status: StatusAccepted}, nil
	})
	if err != nil || len(result.Members) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestConsumeFreshAnswerSurvivesUnverifiableNeighbor(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle, w.Costly = true, true
	scripts := t.TempDir()
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte("#!/bin/sh\necho 'owner unavailable' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "thread-blocked", Text: "thread child closed: blocked", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}}, Wishes: Wishes{Turn: "ask"}}); err != nil {
		t.Fatal(err)
	}
	putWish(t, env, "healthy", "ask", "fresh")
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		t.Fatal("fresh request sent a wake")
		return Receipt{}, nil
	})
	if err == nil || result.Action != "fresh" || len(result.Members) != 1 || result.Members[0] != "healthy" {
		t.Fatalf("launch reservation lost behind validation error: %+v %v", result, err)
	}
}
