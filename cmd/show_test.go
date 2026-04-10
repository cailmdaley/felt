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
		Inputs: []felt.ASTRAInput{
			{ID: "catalog", Type: "data", From: "source.catalog"},
		},
		Decisions: map[string]felt.ASTRADecision{
			"covariance": {
				Label:   "Covariance method",
				Default: "glass",
			},
		},
		Insights: map[string]felt.ASTRAInsight{
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
			Outputs: []felt.ASTRAOutput{
				{ID: "posterior", Type: "data"},
			},
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
			Inputs: []felt.ASTRAInput{
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
			Inputs: []felt.ASTRAInput{
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
	prevJSON := jsonOutput

	showBodyOnly = false
	showDetail = ""
	showInputs = false
	showInsights = false
	showCitations = false
	showConsumers = false
	showDecision = ""
	showDecisions = false
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
