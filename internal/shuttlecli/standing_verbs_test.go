package shuttlecli

import (
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// withAxis rewrites one axis of a state key (kind/life/stashed/seat/ask/worker).
func withAxis(key string, axis int, value string) string {
	parts := strings.Split(key, "/")
	parts[axis] = value
	return strings.Join(parts, "/")
}

const (
	axisLife   = 1
	axisAsk    = 4
	axisWorker = 5
)

// Random sequences of the board's standing requests (Temper run, Retire,
// Pause and Resume schedule) and a run's own events (fire, ask, exit),
// played through the real CLI against one fiber file. After every step the
// fiber is the state the lifecycle model names (status, verdict, rest, ask
// and the column the owner serves), every request the model accepts the CLI
// accepts, a Temper the model refuses the CLI refuses without a write, and a
// tempered run is concluded so its schedule waits for the next tick.
func TestStandingSequencesFollowTheLifecycleModel(t *testing.T) {
	t.Parallel()
	table := readLifecycleTable(t)
	moves := []string{"transition:tempered", "transition:composted", "lifecycle:rest", "lifecycle:resume", "fire", "ask", "exit"}
	start := "standing/active/now/none/quiet/none"

	for seed := int64(1); seed <= 40; seed++ {
		t.Run("seed", func(t *testing.T) {
			t.Parallel()
			rng := rand.New(rand.NewSource(seed))
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, st := newStore(t)
			seedShuttleRole(t, st, "f", felt.StatusActive, standingBlockFixture(dir, map[string]any{"handed_off_at": "2026-01-01T09:00:00Z"}), nil)
			state, trail := start, []string{}
			for step := 0; step < 16; step++ {
				move := moves[rng.Intn(len(moves))]
				life, live := strings.Split(state, "/")[axisLife], !strings.HasSuffix(state, "/none")
				next, before := "", time.Now().Add(-time.Second)
				switch move {
				case "fire":
					if life != "active" || live {
						continue
					}
					dispatchWorker(t, st, "f", time.Now())
					next = withAxis(state, axisWorker, "live")
				case "ask":
					if life != "active" || !live {
						continue
					}
					if out, err := runIn(t, env, dir, "ask", "f", "Cut these rows?"); err != nil {
						t.Fatalf("seed %d %v: ask: %v %s", seed, trail, err, out)
					}
					next = withAxis(state, axisAsk, "ask")
				case "exit":
					if !live {
						continue
					}
					if out, err := runIn(t, env, dir, "handoff", "f"); err != nil {
						t.Fatalf("seed %d %v: handoff: %v %s", seed, trail, err, out)
					}
					next = withAxis(state, axisWorker, "none")
				default:
					answer := decodeAnswer(t, table.Answers[state][move])
					outcome, to, cli := answer.outcome, answer.next, answer.cli
					if outcome != "ok" {
						if move == "transition:tempered" {
							was := mustRead(t, st, "f")
							if _, err := runIn(t, env, dir, "close", "f", "--tempered=true", "--local"); err == nil {
								t.Fatalf("seed %d %v: the model refuses Temper in %s; the CLI accepted it", seed, trail, state)
							}
							if now := mustRead(t, st, "f"); now.Status != was.Status || askOpen(t, now) != askOpen(t, was) {
								t.Fatalf("seed %d %v: a refused Temper wrote the fiber", seed, trail)
							}
						}
						continue
					}
					args := append([]string{cli[0], "f"}, cli[1:]...)
					if out, err := runIn(t, env, dir, append(args, "--local")...); err != nil {
						t.Fatalf("seed %d %v: the model accepts %s in %s; the CLI refused: %v %s", seed, trail, move, state, err, out)
					}
					// The board stops the worker of every verb it sends here.
					next = withAxis(to, axisWorker, "none")
				}
				trail = append(trail, move)
				state = next
				want := table.States[state]
				got := mustRead(t, st, "f")
				if got.Status != want.Fiber["status"] || !sameTempered(readTempered(got), want.Fiber["tempered"]) ||
					horizonStashed(got) != (want.Fiber["horizon"] == "stashed") || askOpen(t, got) != (strings.Split(state, "/")[axisAsk] == "ask") {
					t.Fatalf("seed %d %v: the model is in %s; the fiber is status %s tempered %v stashed %v ask %v",
						seed, trail, state, got.Status, readTempered(got), horizonStashed(got), askOpen(t, got))
				}
				block, _, err := shuttle.BlockOf(got)
				if err != nil {
					t.Fatal(err)
				}
				if column := shuttle.Column(got, block, want.Worker != "none", time.Now()); column != want.Column {
					t.Fatalf("seed %d %v: in %s the column is %s, want %s", seed, trail, state, column, want.Column)
				}
				if move == "transition:tempered" && !handedOffAt(t, got).After(before) {
					t.Fatalf("seed %d %v: a tempered run must be concluded now", seed, trail)
				}
			}
		})
	}
}

func sameTempered(got *bool, want any) bool {
	w, ok := want.(bool)
	if !ok {
		return got == nil
	}
	return got != nil && *got == w
}

func askOpen(t *testing.T, f *felt.Felt) bool {
	t.Helper()
	block, _, err := shuttle.BlockOf(f)
	if err != nil {
		t.Fatal(err)
	}
	return block.Ask != nil && strings.TrimSpace(block.Ask.Text) != ""
}
