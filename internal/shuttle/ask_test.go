package shuttle

import (
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestAskValidationAndConfigPreservation(t *testing.T) {
	for _, ask := range []*Ask{
		{Text: "", At: "2026-06-01T12:00:00Z"},
		{Text: "\nQuestion", At: "2026-06-01T12:00:00Z"},
		{Text: "Question", At: "bad"},
	} {
		if errs := Validate(&Block{Kind: "oneshot", Ask: ask}, nil); len(errs) == 0 {
			t.Fatalf("accepted %+v", ask)
		}
	}
	ask := &Ask{Text: "Which cut?", At: "2026-06-01T12:00:00Z"}
	f, err := felt.New("f", "Fiber")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.SetExtraField(FacetKey, &Block{Kind: "oneshot", Ask: ask}); err != nil {
		t.Fatal(err)
	}
	if err := SetConfig(f, &Block{Kind: "pinned"}); err != nil {
		t.Fatal(err)
	}
	b, _, err := BlockOf(f)
	if err != nil || b.Ask == nil || *b.Ask != *ask {
		t.Fatalf("question not preserved: %+v (%v)", b, err)
	}
	if errs := Validate(b, nil); len(errs) != 0 {
		t.Fatal(errs)
	}
}
