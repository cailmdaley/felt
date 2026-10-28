package shuttlecli

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestAskWriteResolveAndClear(t *testing.T) {
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, oneshot(), nil)
	for _, text := range []string{"", "   ", "first\nsecond", "first\rsecond"} {
		if _, err := runCommand(t, dir, "ask", "f", text); err == nil {
			t.Fatalf("accepted %q", text)
		}
	}
	if _, err := runCommand(t, dir, "ask", "f", "Which cut?"); err != nil {
		t.Fatal(err)
	}
	f := mustRead(t, st, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || b.Ask == nil || b.Ask.Text != "Which cut?" {
		t.Fatalf("block=%+v error=%v", b, err)
	}
	if _, err := time.Parse(time.RFC3339Nano, b.Ask.At); err != nil {
		t.Fatal(err)
	}
	if f.Status != felt.StatusActive {
		t.Fatal("ask changed status")
	}
	for _, verb := range []string{"show", "ls"} {
		args := []string{verb, "--json"}
		if verb == "show" {
			args = append(args, "f")
		}
		out, err := runCommand(t, dir, args...)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		if err := json.Unmarshal([]byte(out), &value); err != nil {
			t.Fatal(err)
		}
		if verb == "ls" {
			value = value.([]any)[0]
		}
		ask := value.(map[string]any)["shuttle"].(map[string]any)["ask"].(map[string]any)
		if ask["text"] != "Which cut?" || ask["at"] != b.Ask.At {
			t.Fatalf("ask=%v", ask)
		}
	}
	for _, action := range []string{"clear", "resume", "reopen", "message"} {
		if _, err := runCommand(t, dir, "ask", "f", "Which cut?"); err != nil {
			t.Fatal(err)
		}
		switch action {
		case "clear":
			_, err = runCommand(t, dir, "ask", "f", "--clear")
		case "resume":
			_, err = runCommand(t, dir, "resume", "f", "--local")
		case "reopen":
			_, err = runCommand(t, dir, "reopen", "f", "--local")
		case "message":
			a := testApp(t)
			a.dir = dir
			err = a.clearMessagedFiberAsk("f")
		}
		if err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		b, _, err = shuttle.BlockOf(mustRead(t, st, "f"))
		if err != nil || b.Ask != nil {
			t.Fatalf("%s left ask: %+v (%v)", action, b, err)
		}
	}
}

func TestClearMessagedFiberAskSkipsRemoteOwner(t *testing.T) {
	env := testEnv(t)
	ownHost(t, env, "sender-host")
	store, st := newStore(t)
	seedShuttleRole(t, st, "work/worker", felt.StatusActive, map[string]any{
		"kind": "oneshot", "host": "owner-host", "project_dir": t.TempDir(),
		"ask": map[string]any{"text": "Already answered?", "at": "2026-10-28T10:00:00Z"},
	}, nil)
	env.Set("SHUTTLE_STORES", store)

	if err := newApp(env).clearMessagedFiberAsk("work/worker"); err != nil {
		t.Fatalf("clearing a remote fiber's ask should be handled by its owner: %v", err)
	}
	f := mustRead(t, st, "work/worker")
	block, _, err := shuttle.BlockOf(f)
	if err != nil || block.Ask == nil {
		t.Fatalf("remote ask changed locally: %+v (%v)", block, err)
	}
}
