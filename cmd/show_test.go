package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// writeBrokenFiber plants a fiber dir whose `<slug>.md` holds the given raw
// bytes, bypassing storage so unparseable frontmatter can reach disk.
func writeBrokenFiber(t *testing.T, dir, slug string, content []byte) {
	t.Helper()
	badDir := filepath.Join(dir, ".felt", slug, slug)
	if err := os.MkdirAll(badDir, 0755); err != nil {
		t.Fatalf("MkdirAll %s fiber dir: %v", slug, err)
	}
	if err := os.WriteFile(filepath.Join(badDir, slug+".md"), content, 0644); err != nil {
		t.Fatalf("WriteFile %s fiber: %v", slug, err)
	}
}

func mustShowExtra(t *testing.T, f *felt.Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

func TestShowBodyIncludesStartLine(t *testing.T) {
	dir, storage := newStore(t)
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
}

func TestShowBodyJSONIncludesStartLine(t *testing.T) {
	dir, storage := newStore(t)
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
}

func TestShowCompactRendersOutcomeAndFieldKeys(t *testing.T) {
	dir, storage := newStore(t)
	fiber := &felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Outcome:   "Compact view should stay file-backed.",
	}
	mustShowExtra(t, fiber, "decisions", map[string]any{"covariance": map[string]any{"default": "glass"}})
	if err := storage.Write(fiber); err != nil {
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
	if !strings.Contains(out, "Frontmatter: decisions") {
		t.Fatalf("show -d compact should list additional YAML field keys:\n%s", out)
	}
}

// Compact and summary report the body's size so a reader can decide whether a
// full read is worth paying for before paying for it.
func TestShowReportsBodySize(t *testing.T) {
	dir, storage := newStore(t)
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	if err := storage.Write(&felt.Felt{
		ID:        "with-body",
		Name:      "With body",
		CreatedAt: created,
		Body:      "# With body\n\nFirst paragraph.\n\nSecond paragraph.\n",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "no-body", Name: "No body", CreatedAt: created}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	for _, detail := range []string{"compact", "summary"} {
		saveShowGlobals()
		out, err := runCommand(t, dir, "show", "with-body", "-d", detail)
		if err != nil {
			t.Fatalf("show -d %s: %v\n%s", detail, err, out)
		}
		if !strings.Contains(out, "Body:     5 lines") {
			t.Fatalf("show -d %s missing body size:\n%s", detail, out)
		}

		saveShowGlobals()
		out, err = runCommand(t, dir, "show", "no-body", "-d", detail)
		if err != nil {
			t.Fatalf("show -d %s: %v\n%s", detail, err, out)
		}
		if strings.Contains(out, "Body:") {
			t.Fatalf("show -d %s should omit body size when there is no body:\n%s", detail, out)
		}
	}
}

func TestShowDefaultRendersBody(t *testing.T) {
	dir, storage := newStore(t)
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "Default show remains file-backed.",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Default show remains file-backed.") {
		t.Fatalf("show output mismatch:\n%s", out)
	}
}

func TestShowFieldReadsOpaqueFrontmatter(t *testing.T) {
	dir, _ := newStore(t)

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
decisions:
  covariance:
    default: glass
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
		{"block scalar with multiple paragraphs", "outcome", "First paragraph spanning\ntwo soft-wrapped lines.\n\nSecond paragraph.\n"},
		{"structured mapping as yaml", "decisions", "covariance:\n    default: glass\n"},
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

func TestShowSelectorsAreMutuallyExclusive(t *testing.T) {
	dir, storage := newStore(t)
	if err := storage.Write(&felt.Felt{ID: "fiber-a", Name: "Fiber A", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "--body", "--field", "status")
	if err == nil {
		t.Fatalf("expected selector conflict error, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("missing selector conflict message: %v\n%s", err, out)
	}
}

func TestRenderFullResolvesScopedBodyRefs(t *testing.T) {
	parent := &felt.Felt{ID: "project", Name: "Project", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	current := &felt.Felt{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]] and [[method#step-a]]."}
	sibling := &felt.Felt{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	child := &felt.Felt{ID: "project/analysis/method", Name: "Method", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}

	graph := &Graph{Nodes: map[string]*felt.Felt{
		parent.ID:  parent,
		current.ID: current,
		sibling.ID: sibling,
		child.ID:   child,
	}}
	out := renderFelt(current, graph, DepthFull, nil, nil, nil)
	if !strings.Contains(out, "Refs:     project/question, project/analysis/method#step-a") {
		t.Fatalf("renderFelt() scoped refs mismatch:\n%s", out)
	}
}

func TestRenderFullDedupesRepeatedBodyRefs(t *testing.T) {
	// A fiber mentioned three times in a body is one address, printed once —
	// the line is a list of things to hand back to `felt show`, not a count of
	// mentions.
	parent := &felt.Felt{ID: "project", Name: "Project", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	current := &felt.Felt{
		ID:        "project/analysis",
		Name:      "Analysis",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "[[question]] leads to [[question]], and again [[project/question]].",
	}
	sibling := &felt.Felt{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}

	graph := &Graph{Nodes: map[string]*felt.Felt{
		parent.ID:  parent,
		current.ID: current,
		sibling.ID: sibling,
	}}
	out := renderFelt(current, graph, DepthFull, nil, nil, nil)
	if !strings.Contains(out, "Refs:     project/question\n") {
		t.Fatalf("renderFelt() should print a repeated ref once:\n%s", out)
	}
}

// citationStore seeds a question plus an analysis whose body cites it.
func citationStore(t *testing.T) string {
	t.Helper()
	dir, storage := newStore(t)
	for _, fiber := range []*felt.Felt{
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]]."},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	return dir
}

// consumerStore seeds a question with an output plus an analysis consuming it.
func consumerStore(t *testing.T, outputType string) string {
	t.Helper()
	dir, storage := newStore(t)
	output := map[string]any{"id": "posterior"}
	if outputType != "" {
		output["type"] = outputType
	}
	question := &felt.Felt{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, question, "outputs", []map[string]any{output})
	analysis := &felt.Felt{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, analysis, "inputs", []map[string]any{{"id": "catalog", "from": "question.posterior"}})
	for _, fiber := range []*felt.Felt{question, analysis} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	return dir
}

func TestShowIncludesCitations(t *testing.T) {
	dir := citationStore(t)

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question")
	if err != nil {
		t.Fatalf("show with citations: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Cited by: project/analysis") {
		t.Fatalf("show missing citations:\n%s", out)
	}
}

func TestShowIncludesConsumers(t *testing.T) {
	dir := consumerStore(t, "data")

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question")
	if err != nil {
		t.Fatalf("show with consumers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Consumed by: posterior → project/analysis#catalog") {
		t.Fatalf("show missing consumers:\n%s", out)
	}
}

func TestShowConsumersSelectorOutputsStructuredResults(t *testing.T) {
	dir := consumerStore(t, "")

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
	dir := citationStore(t)

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

func TestShowCitationsSelectorDoesNotSyncFiberIndex(t *testing.T) {
	dir := citationStore(t)
	// A fiber with truncated frontmatter: commands must tolerate a single
	// broken fiber without failing the whole walk.
	writeBrokenFiber(t, dir, "broken", []byte("---\nname: Broken\n"))

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question", "--citations")
	if err != nil {
		t.Fatalf("show --citations should not sync unrelated malformed fibers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "sourceid: project/analysis") {
		t.Fatalf("show --citations missing source:\n%s", out)
	}
}

func TestShowFullIncludesOpaqueFrontmatter(t *testing.T) {
	dir, storage := newStore(t)
	fiber := &felt.Felt{ID: "fiber-a", Name: "Fiber A", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Outcome: "Shipped.", Body: "Body paragraph."}
	mustShowExtra(t, fiber, "inputs", []map[string]any{{"id": "catalog", "from": "upstream.posterior", "description": "Posterior sample"}})
	mustShowExtra(t, fiber, "outputs", []map[string]any{{"id": "posterior", "description": "MCMC posterior"}})
	mustShowExtra(t, fiber, "decisions", map[string]any{"covariance": map[string]any{"default": "glass", "options": map[string]any{"analytic": map[string]any{"excluded_reason": "underestimates tails"}}}})
	mustShowExtra(t, fiber, "insights", map[string]any{"stability": map[string]any{"claim": "Posterior is stable to jackknife choice."}})
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "fiber-a", "-d", "full")
	if err != nil {
		t.Fatalf("show -d full: %v\n%s", err, out)
	}
	for _, want := range []string{
		"ID:       fiber-a",
		"Outcome:  Shipped.",
		"Frontmatter:",
		"inputs:",
		"from: upstream.posterior",
		"outputs:",
		"decisions:",
		"excluded_reason: underestimates tails",
		"insights:",
		"claim: Posterior is stable to jackknife choice.",
		"Body paragraph.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show -d full missing %q:\n%s", want, out)
		}
	}
}

func TestShowFullAnnotatesBodyRefsWithoutStoreWalk(t *testing.T) {
	dir, storage := newStore(t)
	for _, fiber := range []*felt.Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		},
		{
			ID:        "project/analysis/sub/method",
			Name:      "Method",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Body:      "See [[question]], [[sub/method]], and [[missing]].",
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	// Syntactically invalid YAML frontmatter — only a command that walks
	// every fiber should trip on it.
	writeBrokenFiber(t, dir, "broken-yaml", []byte("---\nname: [\n---\nThis should only fail if the command walks every fiber.\n"))

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/analysis")
	if err != nil {
		t.Fatalf("show should not walk unrelated malformed fibers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Refs:     project/question, project/analysis/sub/method, missing") {
		t.Fatalf("show refs mismatch:\n%s", out)
	}
}

func saveShowGlobals() func() {
	prevBodyOnly := showBodyOnly
	prevDetail := showDetail
	prevCitations := showCitations
	prevConsumers := showConsumers
	prevField := showField
	prevJSON := jsonOutput

	showBodyOnly = false
	showDetail = ""
	showCitations = false
	showConsumers = false
	showField = ""
	jsonOutput = false

	return func() {
		showBodyOnly = prevBodyOnly
		showDetail = prevDetail
		showCitations = prevCitations
		showConsumers = prevConsumers
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

func TestShowFieldRefusesJSON(t *testing.T) {
	dir, storage := newStore(t)
	if err := storage.Write(&felt.Felt{ID: "fiber-a", Name: "Fiber A", Status: "active", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}); err != nil {
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
