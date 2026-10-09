package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/felt"
	"testing"
)

func TestRestUntil(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	f := &felt.Felt{ID: "f", Name: "f", Status: felt.StatusActive}
	if err := f.SetExtraField("shuttle", oneshot()); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}
	for _, until := range []string{"2099-06-12", ""} {
		if out, err := runIn(t, env, dir, "rest", "f", "--until", until, "--local"); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		got, err := storage.Read("f")
		if err != nil {
			t.Fatal(err)
		}
		if until == "" {
			if got.Due != nil {
				t.Fatal("undated rest kept a due date")
			}
		} else if got.Due == nil || got.Due.Format("2006-01-02") != until {
			t.Fatal("dated rest lost its return day")
		}
	}
	if _, err := runIn(t, env, dir, "rest", "f", "--until", "2026-02-30", "--local"); err == nil {
		t.Fatal("accepted an invalid date")
	}
}
