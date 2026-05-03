package cmd

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestShowBodyIncludesStartLine(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "first line\nsecond line",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--body")
	if err != nil {
		t.Fatalf("show --body: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Body start line: 6") {
		t.Fatalf("show --body missing start line:\n%s", out)
	}
	if !strings.Contains(out, "first line\nsecond line") {
		t.Fatalf("show --body missing body:\n%s", out)
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show --body should not create index.db, stat err = %v", err)
	}
}

func TestShowBodyJSONIncludesStartLine(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "body text",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--body", "--json")
	if err != nil {
		t.Fatalf("show --body --json: %v\n%s", err, out)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, out)
	}
	if got := payload["body_start_line"]; got != float64(6) {
		t.Fatalf("body_start_line = %#v, want 6", got)
	}
	if got := payload["body"]; got != "body text" {
		t.Fatalf("body = %#v, want %q", got, "body text")
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show --body --json should not create index.db, stat err = %v", err)
	}
}

func TestShowCompactDoesNotCreateIndexWhenNotNeeded(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Outcome:   "Compact view should stay file-backed.",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "-d", "compact")
	if err != nil {
		t.Fatalf("show -d compact: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Outcome:  Compact view should stay file-backed.") {
		t.Fatalf("show -d compact output mismatch:\n%s", out)
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show -d compact should not create index.db, stat err = %v", err)
	}
}

func TestShowDecisionsAndInputsSelectors(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Inputs: []felt.FiberInput{
			{ID: "catalog", Type: "data", From: "source.catalog"},
		},
		Decisions: map[string]felt.Decision{
			"covariance": {
				Label:   "Covariance method",
				Default: "glass",
			},
		},
		Insights: map[string]felt.Insight{
			"claim-a": {Claim: "The result is stable."},
		},
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--decisions")
	if err != nil {
		t.Fatalf("show --decisions: %v\n%s", err, out)
	}
	if !strings.Contains(out, "covariance:") || !strings.Contains(out, "default: glass") {
		t.Fatalf("show --decisions output mismatch:\n%s", out)
	}

	reset = saveShowGlobals()
	defer reset()

	out, err = runCommand(t, dir, "show", "fiber-a", "--decision", "covariance")
	if err != nil {
		t.Fatalf("show --decision: %v\n%s", err, out)
	}
	if !strings.Contains(out, "covariance:") || !strings.Contains(out, "label: Covariance method") {
		t.Fatalf("show --decision output mismatch:\n%s", out)
	}

	reset = saveShowGlobals()
	defer reset()

	out, err = runCommand(t, dir, "show", "fiber-a", "--inputs")
	if err != nil {
		t.Fatalf("show --inputs: %v\n%s", err, out)
	}
	if !strings.Contains(out, "- id: catalog") || !strings.Contains(out, "from: source.catalog") {
		t.Fatalf("show --inputs output mismatch:\n%s", out)
	}

	reset = saveShowGlobals()
	defer reset()

	out, err = runCommand(t, dir, "show", "fiber-a", "--insights")
	if err != nil {
		t.Fatalf("show --insights: %v\n%s", err, out)
	}
	if !strings.Contains(out, "claim-a:") || !strings.Contains(out, "claim: The result is stable.") {
		t.Fatalf("show --insights output mismatch:\n%s", out)
	}
}

func TestShowSelectorsAreMutuallyExclusive(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--body", "--inputs")
	if err == nil {
		t.Fatalf("expected selector conflict error, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("missing selector conflict message: %v\n%s", err, out)
	}
}

func TestRenderFullResolvesScopedBodyRefs(t *testing.T) {
	parent := &felt.Felt{
		ID:        "project",
		Name:      "Project",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	current := &felt.Felt{
		ID:        "project/analysis",
		Name:      "Analysis",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "See [[question]] and [[method#step-a]].",
	}
	sibling := &felt.Felt{
		ID:        "project/question",
		Name:      "Question",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	child := &felt.Felt{
		ID:        "project/analysis/method",
		Name:      "Method",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}

	out := renderFelt(current, felt.BuildGraph([]*felt.Felt{parent, current, sibling, child}), DepthFull, nil, nil)
	if !strings.Contains(out, "Refs:     project/question (Question), project/analysis/method#step-a (Method)") {
		t.Fatalf("renderFelt() scoped refs mismatch:\n%s", out)
	}
}

func TestShowIncludesIndexedCitations(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Body:      "See [[question]].",
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question")
	if err != nil {
		t.Fatalf("show with citations: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Cited by: project/analysis (Analysis)") {
		t.Fatalf("show missing citations:\n%s", out)
	}
}

func TestShowIncludesIndexedConsumers(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Outputs: []felt.FiberOutput{
				{ID: "posterior", Type: "data"},
			},
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Inputs: []felt.FiberInput{
				{ID: "catalog", From: "question.posterior"},
			},
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question")
	if err != nil {
		t.Fatalf("show with consumers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Consumed by: posterior → project/analysis#catalog (Analysis)") {
		t.Fatalf("show missing consumers:\n%s", out)
	}
}

func TestShowConsumersSelectorOutputsStructuredResults(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Inputs: []felt.FiberInput{
				{ID: "catalog", From: "question.posterior"},
			},
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question", "--consumers")
	if err != nil {
		t.Fatalf("show --consumers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "sourceid: project/analysis") || !strings.Contains(out, "inputid: catalog") || !strings.Contains(out, "outputid: posterior") {
		t.Fatalf("show --consumers output mismatch:\n%s", out)
	}
}

func TestShowCitationsSelectorOutputsStructuredResults(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Body:      "See [[question]].",
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question", "--citations")
	if err != nil {
		t.Fatalf("show --citations: %v\n%s", err, out)
	}
	if !strings.Contains(out, "sourceid: project/analysis") || !strings.Contains(out, "sourcename: Analysis") {
		t.Fatalf("show --citations output mismatch:\n%s", out)
	}
}

func TestShowFullIncludesAllFrontmatterSections(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Outcome:   "Shipped.",
		Body:      "Body paragraph.",
		Inputs: []felt.FiberInput{
			{ID: "catalog", Type: "data", From: "upstream.posterior", Description: "Posterior sample"},
		},
		Outputs: []felt.FiberOutput{
			{ID: "posterior", Type: "data", Description: "MCMC posterior"},
		},
		Decisions: map[string]felt.Decision{
			"covariance": {
				Label:   "Covariance method",
				Default: "glass",
				Options: map[string]felt.DecisionOption{
					"glass": {Label: "GLASS mocks"},
					"analytic": {
						Label:          "Analytic covariance",
						Excluded:       true,
						ExcludedReason: "underestimates tails",
					},
				},
			},
		},
		Insights: map[string]felt.Insight{
			"stability": {Claim: "Posterior is stable to jackknife choice."},
		},
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "-d", "full")
	if err != nil {
		t.Fatalf("show -d full: %v\n%s", err, out)
	}

	// Metadata + outcome must still be present.
	for _, want := range []string{
		"ID:       fiber-a",
		"Outcome:  Shipped.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show -d full missing %q:\n%s", want, out)
		}
	}

	// Decisions section with option + excluded flag.
	for _, want := range []string{
		"Decisions:",
		"covariance",
		"Covariance method",
		"default: glass",
		"analytic",
		"excluded_reason: underestimates tails",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show -d full missing decision detail %q:\n%s", want, out)
		}
	}

	// Inputs / Outputs / Insights sections.
	for _, want := range []string{
		"Inputs:",
		"catalog",
		"from: upstream.posterior",
		"Outputs:",
		"posterior",
		"Insights:",
		"stability",
		"claim: Posterior is stable to jackknife choice.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show -d full missing section %q:\n%s", want, out)
		}
	}

	// Body still included.
	if !strings.Contains(out, "Body paragraph.") {
		t.Errorf("show -d full missing body:\n%s", out)
	}
}

func TestShowCompactDoesNotIncludeDecisionDetails(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Decisions: map[string]felt.Decision{
			"covariance": {
				Label: "Covariance method",
				Options: map[string]felt.DecisionOption{
					"glass": {Label: "GLASS mocks"},
				},
			},
		},
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "-d", "compact")
	if err != nil {
		t.Fatalf("show -d compact: %v\n%s", err, out)
	}
	if strings.Contains(out, "Decisions:\n") {
		t.Fatalf("show -d compact should not render full Decisions: section:\n%s", out)
	}
	if !strings.Contains(out, "Fields:") {
		t.Fatalf("show -d compact should render frontmatter count line:\n%s", out)
	}
}

func TestResolveCommandScopeFindsNearestFiberDirectory(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project", Name: "Project", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	artifactDir := dir + "/.felt/project/analysis/results"
	if err := os.MkdirAll(artifactDir, 0755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}

	oldWd, _ := os.Getwd()
	oldChangeDir := changeDir
	defer func() {
		_ = os.Chdir(oldWd)
		changeDir = oldChangeDir
	}()
	changeDir = ""
	if err := os.Chdir(artifactDir); err != nil {
		t.Fatalf("Chdir() error: %v", err)
	}

	if got := resolveCommandScope(dir); got != "project/analysis" {
		t.Fatalf("resolveCommandScope() = %q, want %q", got, "project/analysis")
	}
}

func saveShowGlobals() func() {
	prevBodyOnly := showBodyOnly
	prevDetail := showDetail
	prevInputs := showInputs
	prevInsights := showInsights
	prevCitations := showCitations
	prevConsumers := showConsumers
	prevDecision := showDecision
	prevDecisions := showDecisions
	prevField := showField
	prevJSON := jsonOutput

	showBodyOnly = false
	showDetail = ""
	showInputs = false
	showInsights = false
	showCitations = false
	showConsumers = false
	showDecision = ""
	showDecisions = false
	showField = ""
	jsonOutput = false

	return func() {
		showBodyOnly = prevBodyOnly
		showDetail = prevDetail
		showInputs = prevInputs
		showInsights = prevInsights
		showCitations = prevCitations
		showConsumers = prevConsumers
		showDecision = prevDecision
		showDecisions = prevDecisions
		showField = prevField
		jsonOutput = prevJSON
	}
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return ts
}

// TestShowField covers the shell-friendly --field accessor:
//   - scalars (string, bool) emit a single trailing-newline'd line
//   - sequences of scalars emit one per line
//   - block-scalar `outcome:` emits its multi-line content unwrapped
//   - missing keys produce empty stdout, exit 0 (defensive shell gates rely
//     on this — `[[ "$(felt show id --field tempered)" == true ]]`)
//
// Frontmatter keys felt itself doesn't model (e.g. `tempered`, `depends-on`)
// are addressable too — the flag reads raw frontmatter, not parsed Felt
// fields.
func TestShowField(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// Constitution-shaped fiber: status, tags, multi-line outcome, plus a
	// portolan-side `tempered:` field hand-written into the file (felt
	// doesn't model it; the flag should still surface it).
	manualPath := dir + "/.felt/fiber-a/fiber-a.md"
	if err := os.MkdirAll(dir+"/.felt/fiber-a", 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	body := `---
name: Fiber A
status: active
tags:
  - constitution
  - vellum
created-at: 2026-04-10T09:00:00Z
tempered: false
outcome: |-
  First paragraph spanning
  two soft-wrapped lines.

  Second paragraph.
---
Body here.
`
	if err := os.WriteFile(manualPath, []byte(body), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cases := []struct {
		name  string
		field string
		want  string
	}{
		{"scalar string", "status", "active\n"},
		{"scalar bool", "tempered", "false\n"},
		{"sequence of scalars", "tags", "constitution\nvellum\n"},
		{"block scalar with multiple paragraphs", "outcome",
			"First paragraph spanning\ntwo soft-wrapped lines.\n\nSecond paragraph.\n"},
		{"missing key emits empty stdout", "bogus-key", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reset := saveShowGlobals()
			defer reset()
			out, err := runCommand(t, dir, "show", "fiber-a", "--field", tc.field)
			if err != nil {
				t.Fatalf("show --field %s: %v\n%s", tc.field, err, out)
			}
			if out != tc.want {
				t.Fatalf("show --field %s output mismatch:\n got: %q\nwant: %q", tc.field, out, tc.want)
			}
		})
	}
}

func TestShowFieldRefusesJSON(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		Status:    "active",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--field", "status", "--json")
	if err == nil {
		t.Fatalf("expected error combining --field and --json, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "--field cannot combine with --json") {
		t.Fatalf("unexpected error message: %v\n%s", err, out)
	}
}

func TestShowFieldMutuallyExclusiveWithOtherSelectors(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--field", "status", "--body")
	if err == nil {
		t.Fatalf("expected selector-conflict error, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("missing selector-conflict message: %v\n%s", err, out)
	}
}
