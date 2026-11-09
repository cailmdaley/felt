package shuttlecli

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// The lifecycle model's request table (ui/harness/lifecycleModel.ts), shared
// with the daemon and the board: for every state and request, whether the
// owner accepts it, the Shuttle write it runs, and the state that follows.
type lifecycleTable struct {
	States  map[string]lifecycleTableState          `json:"states"`
	Answers map[string]map[string][]json.RawMessage `json:"answers"`
}

type lifecycleTableState struct {
	Fiber  map[string]any `json:"fiber"`
	Worker string         `json:"worker"`
	Column string         `json:"column"`
}

type lifecycleAnswer struct {
	outcome, next string
	cli           []string
}

func readLifecycleTable(t *testing.T) lifecycleTable {
	t.Helper()
	raw, err := os.ReadFile("../../daemon/test/fixtures/lifecycle/model.json")
	if err != nil {
		t.Fatal(err)
	}
	var table lifecycleTable
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func decodeAnswer(t *testing.T, raw []json.RawMessage) lifecycleAnswer {
	t.Helper()
	var a lifecycleAnswer
	if err := json.Unmarshal(raw[0], &a.outcome); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw[1], &a.next); err != nil {
		t.Fatal(err)
	}
	if len(raw) > 2 {
		if err := json.Unmarshal(raw[2], &a.cli); err != nil {
			t.Fatal(err)
		}
	}
	return a
}

// seedModelFiber writes the table's document for a state as fiber "f".
func seedModelFiber(t *testing.T, storage *felt.Storage, doc map[string]any) {
	t.Helper()
	f := &felt.Felt{ID: "f", Name: "f", Status: doc["status"].(string), CreatedAt: mustParseTime(t, "2026-11-01T09:00:00Z")}
	for _, key := range []string{"shuttle", "tempered", "horizon"} {
		if value, ok := doc[key]; ok {
			if err := f.SetExtraField(key, value); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}
}

// lifecycleFacts are the document fields the model distinguishes.
func lifecycleFacts(f *felt.Felt) string {
	verdict := "none"
	if v := shuttle.Tempered(f); v != nil {
		verdict = map[bool]string{true: "tempered", false: "discarded"}[*v]
	}
	stashed := horizonStashed(f)
	ask := false
	if block, ok, _ := shuttle.BlockOf(f); ok && block.Ask != nil && strings.TrimSpace(block.Ask.Text) != "" {
		ask = true
	}
	return strings.Join([]string{"status=" + f.Status, "verdict=" + verdict, "stashed=" + map[bool]string{true: "yes", false: "no"}[stashed], "ask=" + map[bool]string{true: "yes", false: "no"}[ask]}, " ")
}

func docFacts(t *testing.T, doc map[string]any) string {
	t.Helper()
	dir, storage := newStore(t)
	_ = dir
	seedModelFiber(t, storage, doc)
	return lifecycleFacts(mustRead(t, storage, "f"))
}

// Every Shuttle write the model says the owner runs, on every document the
// model distinguishes, leaves the document the model says follows, and a
// write the model says is refused fails and changes nothing.
func TestLifecycleModelWrites(t *testing.T) {
	t.Parallel()
	table := readLifecycleTable(t)
	type job struct {
		state string
		cli   []string
		want  lifecycleAnswer
	}
	seen := map[string]bool{}
	var jobs []job
	for state, answers := range table.Answers {
		for _, raw := range answers {
			a := decodeAnswer(t, raw)
			if a.cli == nil {
				continue
			}
			// The worker is the daemon's, not the document's: one run per document and write.
			doc, _ := json.Marshal(table.States[state].Fiber)
			key := string(doc) + strings.Join(a.cli, " ")
			if seen[key] {
				continue
			}
			seen[key] = true
			jobs = append(jobs, job{state, a.cli, a})
		}
	}
	for _, j := range jobs {
		t.Run(j.state+"/"+strings.Join(j.cli, "_"), func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "model-host")
			dir, storage := newStore(t)
			seedModelFiber(t, storage, table.States[j.state].Fiber)
			before := lifecycleFacts(mustRead(t, storage, "f"))
			args := append([]string{j.cli[0], "f"}, append(j.cli[1:], "--local")...)
			out, err := runIn(t, env, dir, args...)
			after := lifecycleFacts(mustRead(t, storage, "f"))
			switch j.want.outcome {
			case "ok":
				if err != nil {
					t.Fatalf("shuttle %s refused what the owner accepts: %v\n%s", strings.Join(args, " "), err, out)
				}
				if want := docFacts(t, table.States[j.want.next].Fiber); after != want {
					t.Fatalf("shuttle %s on %s\n got: %s\nwant: %s (%s)", strings.Join(args, " "), before, after, want, j.want.next)
				}
			default:
				if err == nil {
					t.Fatalf("shuttle %s accepted what the owner refuses; left %s", strings.Join(args, " "), after)
				}
				if after != before {
					t.Fatalf("refused shuttle %s still wrote: %s → %s", strings.Join(args, " "), before, after)
				}
			}
		})
	}
}
