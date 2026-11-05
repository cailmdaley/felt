package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func dispatchWorker(t *testing.T, st *felt.Storage, id string, at time.Time) *felt.Felt {
	t.Helper()
	f := mustRead(t, st, id)
	if err := shuttle.SetRuntimeField(f, "dispatched_at", at.UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	return f
}

func writePage(t *testing.T, f *felt.Felt, at time.Time) {
	t.Helper()
	page := filepath.Join(filepath.Dir(f.Path), "tapestry.html")
	if err := os.WriteFile(page, []byte("<h1>now</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(page, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestReviewReportHoldsTheWorkerThatLeavesItStale(t *testing.T) {
	t.Parallel()
	dispatched := time.Now().Add(-time.Hour)
	for _, verb := range [][]string{{"close"}, {"ask", "work", "which one?"}} {
		for _, page := range []struct {
			name string
			at   time.Time
			held bool
		}{
			{"missing", time.Time{}, true},
			{"before dispatch", dispatched.Add(-time.Minute), true},
			{"since dispatch", dispatched.Add(time.Minute), false},
		} {
			t.Run(verb[0]+"/"+page.name, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				dir, st := newStore(t)
				seedShuttleRole(t, st, "work", felt.StatusActive, oneshot(), nil)
				f := dispatchWorker(t, st, "work", dispatched)
				if !page.at.IsZero() {
					writePage(t, f, page.at)
				}
				env.Set("SHUTTLE_FIBER_PATH", f.Path)
				stubWorkerExitTmux(t, env, shuttleTmuxSessionName(f.ID, f.UID), f.Path)
				out, err := runIn(t, env, dir, verb...)
				if page.held {
					if err == nil || !strings.Contains(out+err.Error(), "tapestry.html") {
						t.Fatalf("want refusal naming the page, got %v: %s", err, out)
					}
					if got := mustRead(t, st, "work"); got.Status != felt.StatusActive {
						t.Fatalf("status = %s after refusal", got.Status)
					}
					return
				}
				if err != nil {
					t.Fatalf("%v: %v\n%s", verb, err, out)
				}
			})
		}
	}
}

func TestReviewReportLeavesOtherReadersAlone(t *testing.T) {
	t.Parallel()
	stale := time.Now().Add(-time.Hour)
	cases := map[string]struct {
		id, worker string
		args       []string
	}{
		"thread answers to its orchestrator": {"parent/thread", "parent/thread", []string{"close"}},
		"a verdict is not a report":          {"work", "work", []string{"close", "--tempered=true"}},
		"someone else's fiber":               {"work", "other", []string{"close", "work"}},
		"the board carries no worker":        {"work", "", []string{"close", "work"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "parent", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, st, "work", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, st, "other", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, st, "parent/thread", felt.StatusActive, oneshot(), nil)
			f := dispatchWorker(t, st, c.id, stale)
			if c.worker != "" {
				w := mustRead(t, st, c.worker)
				env.Set("SHUTTLE_FIBER_PATH", w.Path)
				stubWorkerExitTmux(t, env, shuttleTmuxSessionName(w.ID, w.UID), w.Path)
			}
			if out, err := runIn(t, env, dir, c.args...); err != nil {
				t.Fatalf("%v on %s: %v\n%s", c.args, f.ID, err, out)
			}
		})
	}
}

func TestReviewReportLeavesStandingRunsAlone(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "testhost")
	dir, st := newStore(t)
	seedShuttleRole(t, st, "work", felt.StatusActive, standingRole(dir), nil)
	f := dispatchWorker(t, st, "work", time.Now().Add(-time.Hour))
	env.Set("SHUTTLE_FIBER_PATH", f.Path)
	stubWorkerExitTmux(t, env, shuttleTmuxSessionName(f.ID, f.UID), f.Path)
	if out, err := runIn(t, env, dir, "close"); err != nil {
		t.Fatalf("close: %v\n%s", err, out)
	}
}

func TestReviewReportReadsAncestryThroughASymlinkedStore(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "sci/proj", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, st, "sci/proj/thread", felt.StatusActive, oneshot(), nil)
	thread := dispatchWorker(t, st, "sci/proj/thread", time.Now().Add(-time.Hour))
	project := t.TempDir()
	if err := os.Symlink(filepath.Join(dir, ".felt", "sci", "proj"), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_FIBER_PATH", thread.Path)
	if out, err := runIn(t, env, project, "ask", "thread", "which one?"); err != nil {
		t.Fatalf("ask: %v\n%s", err, out)
	}
}

func TestReviewReportHoldsANativeSessionBeforeItsBindingLands(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "work", felt.StatusActive, oneshot(), nil)
	f := dispatchWorker(t, st, "work", time.Now().Add(-time.Hour))
	env.Set("SHUTTLE_FIBER_PATH", f.Path)
	env.Set("CODEX_THREAD_ID", "unbound-session")
	if out, err := runIn(t, env, dir, "ask", "work", "which one?"); err == nil {
		t.Fatalf("want refusal, got: %s", out)
	}
}
