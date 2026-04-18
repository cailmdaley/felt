package cmd

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestParseDecisionOptionBackwardsCompat(t *testing.T) {
	cases := []struct {
		raw           string
		wantID        string
		wantLabel     string
		wantExcluded  bool
		wantReason    string
	}{
		{"glass:GLASS mocks", "glass", "GLASS mocks", false, ""},
		{"analytic:Analytic covariance:excluded:underestimates tails", "analytic", "Analytic covariance", true, "underestimates tails"},
		{"opt:label:true", "opt", "label", true, ""},
		{"opt:label:false", "opt", "label", false, ""},
		{"opt:label:yes", "opt", "label", true, ""},
		{"opt:label:no", "opt", "label", false, ""},
		{"opt:label:included", "opt", "label", false, ""},
		// Reason alone flips excluded to true.
		{"opt:label::reason-only", "opt", "label", true, "reason-only"},
	}
	for _, c := range cases {
		id, opt, err := parseDecisionOption(c.raw)
		if err != nil {
			t.Fatalf("parseDecisionOption(%q) error: %v", c.raw, err)
		}
		if id != c.wantID || opt.Label != c.wantLabel || opt.Excluded != c.wantExcluded || opt.ExcludedReason != c.wantReason {
			t.Fatalf("parseDecisionOption(%q) = (%q, %+v), want (%q, label=%q excluded=%v reason=%q)",
				c.raw, id, opt, c.wantID, c.wantLabel, c.wantExcluded, c.wantReason)
		}
	}
}

func TestParseDecisionOptionBackslashEscape(t *testing.T) {
	cases := []struct {
		name          string
		raw           string
		wantID        string
		wantLabel     string
		wantExcluded  bool
		wantReason    string
	}{
		{
			name:      "escaped colon inside label",
			raw:       `settings-default:settings.json defaultMode\: auto:false`,
			wantID:    "settings-default",
			wantLabel: "settings.json defaultMode: auto",
		},
		{
			name:       "escaped colon in reason",
			raw:        `opt:label:true:because x\: y`,
			wantID:     "opt",
			wantLabel:  "label",
			wantExcluded: true,
			wantReason: "because x: y",
		},
		{
			name:      "literal backslash via \\\\",
			raw:       `opt:path\\\\foo:false`,
			wantID:    "opt",
			wantLabel: `path\\foo`,
		},
		{
			name:      "backslash-colon pair inside id",
			raw:       `ns\:sub:label:false`,
			wantID:    "ns:sub",
			wantLabel: "label",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, opt, err := parseDecisionOption(c.raw)
			if err != nil {
				t.Fatalf("parseDecisionOption(%q) error: %v", c.raw, err)
			}
			if id != c.wantID {
				t.Errorf("id = %q, want %q", id, c.wantID)
			}
			if opt.Label != c.wantLabel {
				t.Errorf("label = %q, want %q", opt.Label, c.wantLabel)
			}
			if opt.Excluded != c.wantExcluded {
				t.Errorf("excluded = %v, want %v", opt.Excluded, c.wantExcluded)
			}
			if opt.ExcludedReason != c.wantReason {
				t.Errorf("reason = %q, want %q", opt.ExcludedReason, c.wantReason)
			}
		})
	}
}

func TestParseDecisionOptionRejectsBadExcluded(t *testing.T) {
	// The fiber's original repro: `auto` (from label `defaultMode: auto`)
	// leaking into the excluded field must still error under backwards
	// compatibility — users without escapes should see a clear failure.
	_, _, err := parseDecisionOption("settings-default:settings.json defaultMode: auto:false")
	if err == nil {
		t.Fatal("expected error parsing label with unescaped colon that lands in excluded field")
	}
	if !strings.Contains(err.Error(), "excluded") {
		t.Fatalf("expected excluded-field error, got: %v", err)
	}
}

func TestParseDecisionOptionTrailingBackslash(t *testing.T) {
	_, _, err := parseDecisionOption(`opt:label\`)
	if err == nil {
		t.Fatal("expected error on trailing backslash")
	}
}

func TestParseStructuredDecisionOptions(t *testing.T) {
	ids, opts, err := parseStructuredDecisionOptions(
		[]string{"settings-default", "glass"},
		[]string{"settings.json defaultMode: auto", "GLASS mocks"},
		[]string{"false", ""},
		[]string{"", ""},
	)
	if err != nil {
		t.Fatalf("parseStructuredDecisionOptions: %v", err)
	}
	if len(ids) != 2 || ids[0] != "settings-default" || ids[1] != "glass" {
		t.Fatalf("ids mismatch: %v", ids)
	}
	if opts[0].Label != "settings.json defaultMode: auto" {
		t.Fatalf("label[0] mismatch: %q", opts[0].Label)
	}
	if opts[0].Excluded {
		t.Fatalf("excluded[0] should be false")
	}

	// Length mismatch errors.
	if _, _, err := parseStructuredDecisionOptions([]string{"a"}, []string{"A", "B"}, nil, nil); err == nil {
		t.Fatal("expected error on --option-label count mismatch")
	}
	if _, _, err := parseStructuredDecisionOptions([]string{"a"}, []string{"A"}, []string{"true", "false"}, nil); err == nil {
		t.Fatal("expected error on --option-excluded count exceeding --option-id")
	}

	// Reason-only still flips excluded.
	_, opts, err = parseStructuredDecisionOptions(
		[]string{"a"}, []string{"A"}, nil, []string{"because"},
	)
	if err != nil {
		t.Fatalf("reason-only: %v", err)
	}
	if !opts[0].Excluded || opts[0].ExcludedReason != "because" {
		t.Fatalf("reason-only option wrong: %+v", opts[0])
	}
}

func TestEditOptionCompactWithEscapedColon(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	out, err := runCommand(t, dir, "edit", "fiber-a",
		"--decision", "mechanism",
		"--option", `settings-default:settings.json defaultMode\: auto:false`,
	)
	if err != nil {
		t.Fatalf("edit --option with escaped colon: %v\n%s", err, out)
	}

	f, err := storage.Read("fiber-a")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	decision, ok := f.Decisions["mechanism"]
	if !ok {
		t.Fatalf("decision `mechanism` missing: %+v", f.Decisions)
	}
	opt, ok := decision.Options["settings-default"]
	if !ok {
		t.Fatalf("option `settings-default` missing: %+v", decision.Options)
	}
	if opt.Label != "settings.json defaultMode: auto" {
		t.Fatalf("label: %q, want %q", opt.Label, "settings.json defaultMode: auto")
	}
	if opt.Excluded {
		t.Fatalf("excluded should be false, got %v", opt.Excluded)
	}
}

func TestEditOptionStructuredFlags(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	out, err := runCommand(t, dir, "edit", "fiber-a",
		"--decision", "mechanism",
		"--option-id", "settings-default",
		"--option-label", "settings.json defaultMode: auto",
		"--option-excluded", "false",
	)
	if err != nil {
		t.Fatalf("edit --option-*: %v\n%s", err, out)
	}

	f, err := storage.Read("fiber-a")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	opt := f.Decisions["mechanism"].Options["settings-default"]
	if opt.Label != "settings.json defaultMode: auto" {
		t.Fatalf("label: %q", opt.Label)
	}
	if opt.Excluded {
		t.Fatalf("excluded should be false")
	}
}

func TestEditOptionMixingCompactAndStructuredIsError(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	out, err := runCommand(t, dir, "edit", "fiber-a",
		"--decision", "mechanism",
		"--option", "a:A",
		"--option-id", "b",
		"--option-label", "B",
	)
	if err == nil {
		t.Fatalf("expected mixing error, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "pick one form") {
		t.Fatalf("expected pick-one-form error, got: %v", err)
	}
}

func saveEditGlobals() func() {
	prev := struct {
		name               string
		status             string
		due                string
		tags               []string
		untag              []string
		body               string
		outcome            string
		decision           string
		label              string
		rationale          string
		defaultOpt         string
		options            []string
		optionIDs          []string
		optionLabels       []string
		optionExcluded     []string
		optionReasons      []string
		inputs             []string
		insights           []string
	}{
		editName, editStatus, editDue, editTags, editUntag, editBody, editOutcome,
		editDecision, editLabel, editRationale, editDefault,
		editOptions, editOptionIDs, editOptionLabels, editOptionExcluded, editOptionReasons,
		editInputs, editInsights,
	}

	editName = ""
	editStatus = ""
	editDue = ""
	editTags = nil
	editUntag = nil
	editBody = ""
	editOutcome = ""
	editDecision = ""
	editLabel = ""
	editRationale = ""
	editDefault = ""
	editOptions = nil
	editOptionIDs = nil
	editOptionLabels = nil
	editOptionExcluded = nil
	editOptionReasons = nil
	editInputs = nil
	editInsights = nil

	// Cobra retains the per-flag Changed bit and accumulated StringArray
	// values across invocations of the same singleton command. Force-reset
	// them so repeated runCommand calls start clean.
	editCmd.ResetFlags()
	initEditFlags()

	return func() {
		editName = prev.name
		editStatus = prev.status
		editDue = prev.due
		editTags = prev.tags
		editUntag = prev.untag
		editBody = prev.body
		editOutcome = prev.outcome
		editDecision = prev.decision
		editLabel = prev.label
		editRationale = prev.rationale
		editDefault = prev.defaultOpt
		editOptions = prev.options
		editOptionIDs = prev.optionIDs
		editOptionLabels = prev.optionLabels
		editOptionExcluded = prev.optionExcluded
		editOptionReasons = prev.optionReasons
		editInputs = prev.inputs
		editInsights = prev.insights
	}
}
