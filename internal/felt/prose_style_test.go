package felt

import (
	"os"
	"strings"
	"testing"
)

var proseCases = []struct {
	name, text, line string // line: how the outcome line starts as written
}{
	{"short plain", "Done.", "outcome: Done."},
	{"apostrophe", "Raphael's branch lacks it.", "outcome: Raphael's branch lacks it."},
	{"colon", "Fixed: the fit converges.", "outcome: |-"},
	{"hash", "Issue #12 closed", "outcome: |-"},
	{"looks like a bool", "true", "outcome: |-"},
	{"double quotes", `He said "no"`, "outcome: He said \"no\""},
	{"long with apostrophe", "Fixed Σ_nl at 5.5 Mpc/h — freeing it widens the α error ~30%. Raphael's branch lacks it: see #4.", "outcome: |-"},
	{"long plain", strings.Repeat("word ", 20) + "end", "outcome: |-"},
	{"embedded newlines", "First line.\n\nkey: value\n# not a comment", "outcome: |-"},
	{"leading spaces", "  indented: start", "outcome: |"},
	{"trailing space", "ends: in a space ", "outcome: \"ends: in a space \""},
	{"trailing newline", "a line: with newline\n", "outcome: |"},
	{"leading newline", "\nstarts on line two", "outcome: \"\\nstarts on line two\""},
	{"leading tab", "\tx: y", "outcome: \"\\tx: y\""},
	{"space before newline", "a \nb", "outcome: \"a \\nb\""},
	{"control character", "bell\a: x", "outcome: \"bell\\a: x\""},
}

func TestMarshalWritesProseSoItReadsBackExactly(t *testing.T) {
	t.Parallel()
	for _, tc := range proseCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			f := &Felt{UID: "fixture-f", Name: "F", Status: StatusClosed, Outcome: tc.text, Description: tc.text}
			data, err := f.Marshal()
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(data), "\n"+tc.line) {
				t.Fatalf("want line %q in:\n%s", tc.line, data)
			}
			if !strings.Contains(string(data), "\n"+strings.Replace(tc.line, "outcome:", "description:", 1)) {
				t.Fatalf("description not styled like outcome:\n%s", data)
			}
			got, err := Parse("f", data)
			if err != nil {
				t.Fatalf("%v\n%s", err, data)
			}
			if got.Outcome != tc.text || got.Description != tc.text {
				t.Fatalf("round trip: got outcome %q description %q, want %q\n%s", got.Outcome, got.Description, tc.text, data)
			}
		})
	}
}

func TestUpdateWritesOutcomeAsBlockAndLeavesTheRestAlone(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	const head = "---\nid: fixture-f\nname: F\nstatus: active\noutcome: 'old: quoted'\nshuttle:\n  host: h\n  note: 'kept: as written'\n---\n\nBody.\n"
	writeFiberFile(t, s, "f", head)
	// Each case edits the outcome the previous case wrote.
	for _, tc := range proseCases {
		if _, err := s.Update("f", func(f *Felt) error {
			f.Outcome = tc.text
			return nil
		}); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		raw, _ := os.ReadFile(s.Path("f"))
		if !strings.Contains(string(raw), "\n"+tc.line) {
			t.Fatalf("%s: want line %q in:\n%s", tc.name, tc.line, raw)
		}
		if !strings.Contains(string(raw), "shuttle:\n  host: h\n  note: 'kept: as written'\n---\n") {
			t.Fatalf("%s: shuttle block changed:\n%s", tc.name, raw)
		}
		got, err := s.Read("f")
		if err != nil {
			t.Fatalf("%s: %v\n%s", tc.name, err, raw)
		}
		if got.Outcome != tc.text {
			t.Fatalf("%s: round trip got %q, want %q\n%s", tc.name, got.Outcome, tc.text, raw)
		}
	}
}

func TestUpdateLeavesAnUnchangedBlockOutcomeAsWritten(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	const outcome = "outcome: |-\n  Raphael's branch: lacks it.\n\n  # second paragraph\n"
	writeFiberFile(t, s, "f", "---\nid: fixture-f\nname: F\nstatus: active\n"+outcome+"---\n\nBody.\n")
	if _, err := s.Update("f", func(f *Felt) error {
		f.Status = StatusClosed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(s.Path("f"))
	if !strings.Contains(string(raw), "\n"+outcome+"---\n") {
		t.Fatalf("unchanged block outcome was rewritten:\n%s", raw)
	}
}

func TestMarshalWritesInvalidUTF8Outcome(t *testing.T) {
	t.Parallel()
	f := &Felt{UID: "fixture-f", Name: "F", Outcome: "bad \xff byte"}
	data, err := f.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Parse("f", data)
	if err != nil {
		t.Fatalf("%v\n%s", err, data)
	}
	if got.Outcome != f.Outcome {
		t.Fatalf("got %q, want %q\n%s", got.Outcome, f.Outcome, data)
	}
}

func TestUpdateLeavesAnUnchangedQuotedOutcomeAsWritten(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeFiberFile(t, s, "f", "---\nid: fixture-f\nname: F\nstatus: active\noutcome: 'kept: quoted'\n---\n\nBody.\n")
	if _, err := s.Update("f", func(f *Felt) error {
		f.Status = StatusClosed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(s.Path("f"))
	if !strings.Contains(string(raw), "\noutcome: 'kept: quoted'\n") {
		t.Fatalf("unchanged outcome was rewritten:\n%s", raw)
	}
}
