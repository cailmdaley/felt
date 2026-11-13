package shuttlecli

import (
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// threadBlock is a oneshot created as a thread of the constitution at slug.
func threadBlock(slug string) map[string]any {
	block := oneshot()
	block["thread_parent"] = map[string]any{"uid": "01PARENT0000000000000000000", "host": "elsewhere", "slug": slug, "name": slug}
	return block
}

func reviewMark(t *testing.T, st *felt.Storage, id string) *shuttle.Review {
	t.Helper()
	block, ok, err := shuttle.BlockOf(mustRead(t, st, id))
	if err != nil || !ok {
		t.Fatalf("%s: block %v %v", id, ok, err)
	}
	return block.Review
}

// The mark closes a thread, records why, and sends it to the human's column;
// reopening clears it.
func TestCloseReviewMarksAThreadForTheHuman(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "hub", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, st, "hub/fit", felt.StatusActive, threadBlock("hub"), nil)

	out, err := runIn(t, env, dir, "close", "hub/fit", "--review", "  the fit moved by 2 sigma  ", "--local")
	if err != nil {
		t.Fatalf("close --review: %v\n%s", err, out)
	}
	if !strings.Contains(out, "marked for the human's review: the fit moved by 2 sigma") {
		t.Errorf("output does not name the mark:\n%s", out)
	}
	f := mustRead(t, st, "hub/fit")
	mark := reviewMark(t, st, "hub/fit")
	if f.Status != felt.StatusClosed || shuttle.Tempered(f) != nil || mark == nil || mark.Note != "the fit moved by 2 sigma" {
		t.Fatalf("status %s tempered %v mark %+v", f.Status, shuttle.Tempered(f), mark)
	}
	if _, err := time.Parse(time.RFC3339Nano, mark.At); err != nil {
		t.Errorf("mark at %q: %v", mark.At, err)
	}
	block, _, _ := shuttle.BlockOf(f)
	if column := shuttle.Column(f, block, false, time.Now()); column != "awaiting_review" {
		t.Errorf("column %s, want awaiting_review", column)
	}

	if out, err := runIn(t, env, dir, "reopen", "hub/fit", "--as-draft", "--local"); err != nil {
		t.Fatalf("reopen: %v\n%s", err, out)
	}
	if mark := reviewMark(t, st, "hub/fit"); mark != nil {
		t.Fatalf("reopen kept the mark %+v", mark)
	}
}

func TestCloseReviewRefusals(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		args []string
		want string
	}{
		"empty note":      {[]string{"close", "hub/fit", "--review", "  "}, "needs a note"},
		"with a verdict":  {[]string{"close", "hub/fit", "--review", "why", "--tempered=true"}, "mutually exclusive"},
		"on its own work": {[]string{"close", "hub/fit", "--review", "look"}, "its orchestrator's decision"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "hub", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, st, "hub/fit", felt.StatusActive, threadBlock("hub"), nil)
			if name == "on its own work" {
				f := mustRead(t, st, "hub/fit")
				env.Set("SHUTTLE_FIBER_PATH", f.Path)
				stubWorkerExitTmux(t, env, shuttleTmuxSessionName(f.ID, f.UID), f.Path)
			}
			out, err := runIn(t, env, dir, append(c.args, "--local")...)
			if err == nil || !strings.Contains(out+err.Error(), c.want) {
				t.Fatalf("want refusal naming %q, got %v\n%s", c.want, err, out)
			}
			if got := mustRead(t, st, "hub/fit"); got.Status != felt.StatusActive {
				t.Fatalf("refusal still closed it: %s", got.Status)
			}
		})
	}
}

// A worker closing its own constitution for review settles its threads first:
// a closed, unmarked thread without a verdict holds it; a verdict, a mark, an
// open thread or a non-thread does not.
func TestCloseForReviewHoldsAnOrchestratorWithThreadsToReview(t *testing.T) {
	t.Parallel()
	dispatched := time.Now().Add(-time.Hour)
	yes := true
	setup := func(t *testing.T) (string, *felt.Storage, *felt.Felt) {
		t.Helper()
		dir, st := newStore(t)
		seedShuttleRole(t, st, "hub", felt.StatusActive, oneshot(), nil)
		seedShuttleRole(t, st, "hub/open", felt.StatusActive, threadBlock("hub"), nil)
		seedShuttleRole(t, st, "hub/kept", felt.StatusClosed, threadBlock("hub"), &yes)
		seedShuttleRole(t, st, "hub/note", felt.StatusClosed, oneshot(), nil)
		seedShuttleRole(t, st, "hub/fit", felt.StatusClosed, threadBlock("hub"), nil)
		seedShuttleRole(t, st, "hub/fit/deep", felt.StatusClosed, threadBlock("hub/fit"), nil)
		seedShuttleRole(t, st, "hub/marked", felt.StatusActive, threadBlock("hub"), nil)
		seedShuttleRole(t, st, "other", felt.StatusClosed, threadBlock("hub"), nil)
		f := dispatchWorker(t, st, "hub", dispatched)
		writePage(t, f, dispatched.Add(time.Minute))
		return dir, st, f
	}

	t.Run("held", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		dir, st, f := setup(t)
		if out, err := runIn(t, env, dir, "close", "hub/marked", "--review", "worth a look", "--local"); err != nil {
			t.Fatalf("mark: %v\n%s", err, out)
		}
		env.Set("SHUTTLE_FIBER_PATH", f.Path)
		stubWorkerExitTmux(t, env, shuttleTmuxSessionName(f.ID, f.UID), f.Path)
		out, err := runIn(t, env, dir, "close")
		if err == nil {
			t.Fatalf("closed with threads to review:\n%s", out)
		}
		msg := err.Error()
		for _, want := range []string{"hub/fit\n", "hub/fit/deep", "--tempered=true", "--tempered=false", `--review "<why>"`} {
			if !strings.Contains(msg, want) {
				t.Errorf("refusal lacks %q:\n%s", want, msg)
			}
		}
		for _, settled := range []string{"hub/open", "hub/kept", "hub/note", "hub/marked", "other"} {
			if strings.Contains(msg, settled+"\n") || strings.HasSuffix(msg, settled) {
				t.Errorf("refusal names settled %s:\n%s", settled, msg)
			}
		}
		if got := mustRead(t, st, "hub"); got.Status != felt.StatusActive {
			t.Fatalf("refusal still closed it: %s", got.Status)
		}
	})

	for name, args := range map[string][]string{
		"a verdict":          {"close", "--tempered=true"},
		"someone else's act": {"close", "hub", "--local"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, _, f := setup(t)
			if name != "someone else's act" {
				env.Set("SHUTTLE_FIBER_PATH", f.Path)
				stubWorkerExitTmux(t, env, shuttleTmuxSessionName(f.ID, f.UID), f.Path)
			}
			if out, err := runIn(t, env, dir, args...); err != nil {
				t.Fatalf("%v: %v\n%s", args, err, out)
			}
		})
	}
}
