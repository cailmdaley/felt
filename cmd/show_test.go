package cmd

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func mustShowExtra(t *testing.T, f *felt.Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

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
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show -d compact should not create index.db, stat err = %v", err)
	}
}

func TestShowFieldReadsOpaqueFrontmatter(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

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
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
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
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]]."},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	syncShowIndex(t, storage)

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
	question := &felt.Felt{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, question, "outputs", []map[string]any{{"id": "posterior", "type": "data"}})
	analysis := &felt.Felt{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, analysis, "inputs", []map[string]any{{"id": "catalog", "from": "question.posterior"}})
	for _, fiber := range []*felt.Felt{question, analysis} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	syncShowIndex(t, storage)

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
	question := &felt.Felt{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, question, "outputs", []map[string]any{{"id": "posterior"}})
	analysis := &felt.Felt{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	mustShowExtra(t, analysis, "inputs", []map[string]any{{"id": "catalog", "from": "question.posterior"}})
	for _, fiber := range []*felt.Felt{question, analysis} {
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
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show --consumers should not create index.db, stat err = %v", err)
	}
}

func TestShowCitationsSelectorOutputsStructuredResults(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]]."},
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
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show --citations should not create index.db, stat err = %v", err)
	}
}

func TestShowCitationsSelectorDoesNotSyncFiberIndex(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]]."},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	writeMalformedFiber(t, dir)

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question", "--citations")
	if err != nil {
		t.Fatalf("show --citations should not sync unrelated malformed fibers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "sourceid: project/analysis") {
		t.Fatalf("show --citations missing source:\n%s", out)
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("show --citations should not create index.db, stat err = %v", err)
	}
}

func TestShowCitationsSelectorUsesExistingIndexWithoutSync(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "See [[question]]."},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	syncShowIndex(t, storage)
	writeMalformedFiber(t, dir)

	reset := saveShowGlobals()
	defer reset()

	out, err := runCommand(t, dir, "show", "project/question", "--citations")
	if err != nil {
		t.Fatalf("show --citations should not sync existing index: %v\n%s", err, out)
	}
	if !strings.Contains(out, "sourceid: project/analysis") {
		t.Fatalf("show --citations missing indexed source:\n%s", out)
	}
}

func TestShowFullIncludesOpaqueFrontmatter(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
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

func syncShowIndex(t *testing.T, storage *felt.Storage) {
	t.Helper()
	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("Close index: %v", err)
	}
}

func TestShowFieldRefusesJSON(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
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
