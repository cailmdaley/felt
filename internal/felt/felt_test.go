package felt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNew(t *testing.T) {
	f, err := New("Test Task")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if f.Title != "Test Task" {
		t.Errorf("Title = %q, want %q", f.Title, "Test Task")
	}
	if f.Status != "" {
		t.Errorf("Status = %q, want empty (no default status)", f.Status)
	}
	if f.ID != "test-task" {
		t.Errorf("ID = %q, want %q", f.ID, "test-task")
	}
}

func TestNewEmptyTitle(t *testing.T) {
	_, err := New("")
	if err == nil {
		t.Error("New(\"\") should return an error")
	}

	_, err = New("   ")
	if err == nil {
		t.Error("New(\"   \") should return an error")
	}
}

func TestGenerateID(t *testing.T) {
	tests := []struct {
		title  string
		wantID string
	}{
		{"Simple", "simple"},
		{"Multiple Words Here", "multiple-words-here"},
		{"With 123 Numbers", "with-123-numbers"},
		{"Special!@#Characters", "special-characters"},
		{"  Extra   Spaces  ", "extra-spaces"},
		{"This is a very long title that should be truncated at word boundary", "this-is-a-very-long-title-that"},
	}

	for _, tt := range tests {
		id, err := GenerateID(tt.title)
		if err != nil {
			t.Errorf("GenerateID(%q) error: %v", tt.title, err)
			continue
		}
		if id != tt.wantID {
			t.Errorf("GenerateID(%q) = %q, want %q", tt.title, id, tt.wantID)
		}
	}
}

func TestGenerateIDRejectsEmptySlug(t *testing.T) {
	_, err := GenerateID("!!!")
	if err == nil {
		t.Fatal("GenerateID should reject titles with no alphanumeric characters")
	}
}

func TestSlugify(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"Hello World", "hello-world"},
		{"Test123", "test123"},
		{"Multiple   Spaces", "multiple-spaces"},
		{"Special!@#$%", "special"},
		{"  Trim Me  ", "trim-me"},
		{"CamelCase", "camelcase"},
		{"", ""},
	}

	for _, tt := range tests {
		got := slugify(tt.input)
		if got != tt.want {
			t.Errorf("slugify(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestParse(t *testing.T) {
	content := []byte(`---
title: Test Task
status: active
tags:
  - spec
depends-on:
  - dep-a-12345678
  - dep-b-87654321
created-at: 2026-01-01T10:00:00Z
---

This is the body.

## Comments
Some comment here.
`)

	f, err := Parse("test-task-abcd1234", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	if f.ID != "test-task-abcd1234" {
		t.Errorf("ID = %q, want %q", f.ID, "test-task-abcd1234")
	}
	if f.Title != "Test Task" {
		t.Errorf("Title = %q, want %q", f.Title, "Test Task")
	}
	if f.Status != StatusActive {
		t.Errorf("Status = %q, want %q", f.Status, StatusActive)
	}
	if !f.HasTag("spec") {
		t.Errorf("HasTag(spec) = false, want true")
	}
	if len(f.DependsOn) != 2 {
		t.Errorf("DependsOn length = %d, want 2", len(f.DependsOn))
	}
	if f.DependsOn[0].ID != "dep-a-12345678" || f.DependsOn[1].ID != "dep-b-87654321" {
		t.Errorf("DependsOn IDs = %v, want [dep-a-12345678, dep-b-87654321]", f.DependsOn.IDs())
	}
	if !strings.Contains(f.Body, "This is the body") {
		t.Errorf("Body = %q, want to contain %q", f.Body, "This is the body")
	}
}

func TestParseWithModeMetadataOnly(t *testing.T) {
	content := []byte(`---
title: Test Task
status: active
created-at: 2026-01-01T10:00:00Z
outcome: Metadata survives
---

This body should not be parsed.
`)

	f, err := ParseWithMode("test-task-abcd1234", content, ParseMetadataOnly)
	if err != nil {
		t.Fatalf("ParseWithMode() error: %v", err)
	}

	if f.Title != "Test Task" {
		t.Errorf("Title = %q, want %q", f.Title, "Test Task")
	}
	if f.Outcome != "Metadata survives" {
		t.Errorf("Outcome = %q, want %q", f.Outcome, "Metadata survives")
	}
	if f.Body != "" {
		t.Errorf("Body = %q, want empty for metadata-only parse", f.Body)
	}
}

func TestParseInvalid(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{"empty", []byte("")},
		{"no frontmatter", []byte("Just text")},
		{"unclosed frontmatter", []byte("---\ntitle: Test\n")},
	}

	for _, tt := range tests {
		_, err := Parse("test-id", tt.content)
		if err == nil {
			t.Errorf("Parse(%s) expected error, got nil", tt.name)
		}
	}
}

func TestMarshal(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	f := &Felt{
		ID:        "test-task-12345678",
		Title:     "Test Task",
		DependsOn: Dependencies{{ID: "dep-1-aaaaaaaa"}},
		CreatedAt: now,
		Body:      "Body text here.",
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)
	if !strings.HasPrefix(content, "---\n") {
		t.Error("Marshal() should start with ---")
	}
	if !strings.Contains(content, "title: Test Task") {
		t.Error("Marshal() should contain title")
	}
	if !strings.Contains(content, "Body text here") {
		t.Error("Marshal() should contain body")
	}

	// Round-trip test
	parsed, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("Round-trip Parse() error: %v", err)
	}
	if parsed.Title != f.Title {
		t.Errorf("Round-trip Title = %q, want %q", parsed.Title, f.Title)
	}
	if parsed.Status != "" {
		t.Errorf("Round-trip Status = %q, want empty", parsed.Status)
	}
}

func TestParseAndMarshalASTRAFields(t *testing.T) {
	created := time.Date(2026, 3, 16, 9, 0, 0, 0, time.UTC)
	content := []byte(`---
title: BAO Damping Prior
created-at: 2026-03-15T10:00:00Z
description: Prior on BAO damping parameters
inputs:
  - id: clustering_data
    type: data
    from: parent.desi_dr1_vac
    description: DESI clustering measurements
outputs:
  - id: damped_pk
    type: data
    description: Fit output
    recipe:
      command: python fit_damping.py
      resources:
        cpus: 4
decisions:
  damping_prior:
    label: BAO Damping Prior
    rationale: Without informative priors, broadband projection creates minima
    default: gaussian
    options:
      gaussian:
        label: Informative Gaussian
      flat:
        label: Flat uniform
        excluded: true
        excluded_reason: Shifts too far
insights:
  damping_physical:
    claim: BAO damping caused by pairwise displacements of ~10 Mpc
    created_at: 2026-03-16T09:00:00Z
    evidence:
      - id: ev1
        doi: 10.48550/arXiv.astro-ph/0604361
        quote:
          type: TextQuoteSelector
          exact: velocity flows move matter ~10 Mpc
success_criteria:
  - claim: BAO parameters shift <0.5 sigma from DESI 2024 III
container: python:3.11-slim
---

(bao-damping-prior)=
# BAO Damping Prior
`)

	f, err := Parse("bao-analysis/bao-damping-prior", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}
	if f.Description != "Prior on BAO damping parameters" {
		t.Fatalf("Description = %q", f.Description)
	}
	if len(f.Inputs) != 1 || f.Inputs[0].Description != "DESI clustering measurements" {
		t.Fatalf("Inputs = %#v", f.Inputs)
	}
	if len(f.Outputs) != 1 || f.Outputs[0].Recipe == nil || f.Outputs[0].Recipe.Command != "python fit_damping.py" {
		t.Fatalf("Outputs = %#v", f.Outputs)
	}
	if got := f.Decisions["damping_prior"].Options["flat"].ExcludedReason; got != "Shifts too far" {
		t.Fatalf("ExcludedReason = %q", got)
	}
	if got := f.Insights["damping_physical"].CreatedAt; got == nil || !got.Equal(created) {
		t.Fatalf("Insight CreatedAt = %#v, want %v", got, created)
	}
	if len(f.SuccessCriteria) != 1 || f.Container != "python:3.11-slim" {
		t.Fatalf("SuccessCriteria/Container = %#v %q", f.SuccessCriteria, f.Container)
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	roundTrip, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("round-trip Parse() error: %v", err)
	}
	if roundTrip.Decisions["damping_prior"].Label != "BAO Damping Prior" {
		t.Fatalf("round-trip decisions = %#v", roundTrip.Decisions)
	}
	if roundTrip.Insights["damping_physical"].Evidence[0].Quote == nil {
		t.Fatalf("round-trip insights = %#v", roundTrip.Insights)
	}
}

func TestSearchTextIncludesASTRAFields(t *testing.T) {
	f := &Felt{
		Outcome:     "Outcome text",
		Description: "Description text",
		Inputs: []ASTRAInput{
			{ID: "clustering_data", Description: "DESI DR1 clustering data"},
		},
		Outputs: []ASTRAOutput{
			{ID: "damped_pk", Description: "Power spectrum figure", Recipe: &ASTRARecipe{Command: "python fit.py"}},
		},
		Decisions: map[string]ASTRADecision{
			"damping_prior": {
				Label:     "BAO Damping Prior",
				Rationale: "Broadband projection creates spurious minima",
			},
		},
		Insights: map[string]ASTRAInsight{
			"damping_physical": {Claim: "Pairwise displacements are about 10 Mpc"},
		},
		SuccessCriteria: []ASTRASuccessCriterion{
			{Claim: "Shift stays below 0.5 sigma"},
		},
		Container: "python:3.11-slim",
	}

	searchText := f.SearchText()
	for _, needle := range []string{
		"Outcome text",
		"Description text",
		"DESI DR1 clustering data",
		"Power spectrum figure",
		"python fit.py",
		"BAO Damping Prior",
		"Pairwise displacements are about 10 Mpc",
		"Shift stays below 0.5 sigma",
		"python:3.11-slim",
	} {
		if !strings.Contains(searchText, needle) {
			t.Fatalf("SearchText() missing %q in %q", needle, searchText)
		}
	}
}

func TestJSONOmitsEmptyASTRAFields(t *testing.T) {
	f := &Felt{
		ID:        "quick-gotcha",
		Title:     "Quick gotcha",
		CreatedAt: time.Date(2026, 3, 15, 10, 0, 0, 0, time.UTC),
		Outcome:   "Always single-quote remote commands.",
	}

	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("json.Marshal() error: %v", err)
	}
	text := string(data)
	for _, forbidden := range []string{
		`"description"`,
		`"inputs"`,
		`"outputs"`,
		`"decisions"`,
		`"insights"`,
		`"success_criteria"`,
		`"container"`,
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("json should omit %s: %s", forbidden, text)
		}
	}
}

func TestMatchesID(t *testing.T) {
	f := &Felt{ID: "bao-analysis/damping-prior"}

	tests := []struct {
		query string
		want  bool
	}{
		{"bao-analysis/damping-prior", true},
		{"bao-analysis/damp", true},
		{"bao-analysis", true},
		{"damping-prior", true},
		{"damping", true},
		{"prior", false},
		{"other", false},
	}

	for _, tt := range tests {
		got := f.MatchesID(tt.query)
		if got != tt.want {
			t.Errorf("MatchesID(%q) = %v, want %v", tt.query, got, tt.want)
		}
	}
}

func TestStatusMethods(t *testing.T) {
	f := &Felt{Status: StatusOpen}
	if !f.IsOpen() {
		t.Error("IsOpen() should be true for open status")
	}

	f.Status = StatusActive
	if !f.IsActive() {
		t.Error("IsActive() should be true for active status")
	}

	f.Status = StatusClosed
	if !f.IsClosed() {
		t.Error("IsClosed() should be true for closed status")
	}
}

func TestAppendComment(t *testing.T) {
	f := &Felt{Body: "Initial body."}
	f.AppendComment("First comment")

	if !strings.Contains(f.Body, "## Comments") {
		t.Error("AppendComment should add Comments section")
	}
	if !strings.Contains(f.Body, "First comment") {
		t.Error("AppendComment should add comment text")
	}

	// Add another comment
	f.AppendComment("Second comment")
	if !strings.Contains(f.Body, "Second comment") {
		t.Error("AppendComment should add second comment")
	}
	// Should only have one Comments header
	if strings.Count(f.Body, "## Comments") != 1 {
		t.Error("AppendComment should not duplicate Comments section")
	}
}

func TestValidateID(t *testing.T) {
	tests := []struct {
		id   string
		want bool
	}{
		{"test-task", true},
		{"a-2", true},
		{"bao-analysis/damping-prior", true},
		{"test-task/", false},
		{"TEST-task", false},
		{"test_task", false},
		{"", false},
	}

	for _, tt := range tests {
		got := ValidateID(tt.id)
		if got != tt.want {
			t.Errorf("ValidateID(%q) = %v, want %v", tt.id, got, tt.want)
		}
	}
}

func TestExtractTags(t *testing.T) {
	tests := []struct {
		title     string
		wantTags  []string
		wantTitle string
	}{
		// Simple single tag
		{"[pure-eb] Fix bug", []string{"pure-eb"}, "Fix bug"},
		// Multiple tags
		{"[life] [urgent] Do thing", []string{"life", "urgent"}, "Do thing"},
		// No tags
		{"Just a title", nil, "Just a title"},
		// Tags with underscores
		{"[pure_eb] Fix thing", []string{"pure_eb"}, "Fix thing"},
		// Complex tag content
		{"[thread:pure-eb] B-modes paper", []string{"thread:pure-eb"}, "B-modes paper"},
		// Nested brackets - only extracts leading ones
		{"[tag] Title with [brackets] inside", []string{"tag"}, "Title with [brackets] inside"},
		// Multiple spaces between tags
		{"[a]   [b]  Title", []string{"a", "b"}, "Title"},
		// Empty result title
		{"[tag]", []string{"tag"}, ""},
	}

	for _, tt := range tests {
		tags, title := ExtractTags(tt.title)
		if len(tags) != len(tt.wantTags) {
			t.Errorf("ExtractTags(%q) tags = %v, want %v", tt.title, tags, tt.wantTags)
			continue
		}
		for i, tag := range tags {
			if tag != tt.wantTags[i] {
				t.Errorf("ExtractTags(%q) tag[%d] = %q, want %q", tt.title, i, tag, tt.wantTags[i])
			}
		}
		if title != tt.wantTitle {
			t.Errorf("ExtractTags(%q) title = %q, want %q", tt.title, title, tt.wantTitle)
		}
	}
}

func TestHasTag(t *testing.T) {
	f := &Felt{Tags: []string{"alpha", "beta", "rule:cosebis_data_vector"}}

	if !f.HasTag("alpha") {
		t.Error("HasTag(alpha) should be true")
	}
	if !f.HasTag("beta") {
		t.Error("HasTag(beta) should be true")
	}
	if f.HasTag("gamma") {
		t.Error("HasTag(gamma) should be false")
	}

	// Prefix matching: trailing colon
	if !f.HasTag("rule:") {
		t.Error("HasTag(rule:) should match rule:cosebis_data_vector")
	}
	if !f.HasTag("rule:cosebis_data_vector") {
		t.Error("HasTag(rule:cosebis_data_vector) should be exact match")
	}
	if f.HasTag("rule:other") {
		t.Error("HasTag(rule:other) should not match")
	}
	if f.HasTag("alpha:") {
		t.Error("HasTag(alpha:) should not match — alpha has no colon")
	}
}

func TestAddTag(t *testing.T) {
	f := &Felt{Tags: []string{"existing"}}

	f.AddTag("new")
	if len(f.Tags) != 2 {
		t.Errorf("AddTag should add tag, got %d tags", len(f.Tags))
	}
	if !f.HasTag("new") {
		t.Error("AddTag should have added 'new' tag")
	}

	// Adding duplicate should not increase count
	f.AddTag("new")
	if len(f.Tags) != 2 {
		t.Errorf("AddTag should not add duplicate, got %d tags", len(f.Tags))
	}
}

func TestRemoveTag(t *testing.T) {
	f := &Felt{Tags: []string{"a", "b", "c"}}

	f.RemoveTag("b")
	if len(f.Tags) != 2 {
		t.Errorf("RemoveTag should remove tag, got %d tags", len(f.Tags))
	}
	if f.HasTag("b") {
		t.Error("RemoveTag should have removed 'b' tag")
	}
	if !f.HasTag("a") || !f.HasTag("c") {
		t.Error("RemoveTag should preserve other tags")
	}

	// Removing non-existent tag should be safe
	f.RemoveTag("nonexistent")
	if len(f.Tags) != 2 {
		t.Errorf("RemoveTag of non-existent should be no-op, got %d tags", len(f.Tags))
	}
}

func TestParseTags(t *testing.T) {
	content := []byte(`---
title: Test with Tags
status: open
tags:
  - pure-eb
  - covariance
---

Body here.
`)

	f, err := Parse("test-with-tags-12345678", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	if len(f.Tags) != 2 {
		t.Errorf("Parse tags length = %d, want 2", len(f.Tags))
	}
	if !f.HasTag("pure-eb") {
		t.Error("Parse should have 'pure-eb' tag")
	}
	if !f.HasTag("covariance") {
		t.Error("Parse should have 'covariance' tag")
	}
}

func TestMarshalTags(t *testing.T) {
	f := &Felt{
		ID:        "test-tags-12345678",
		Title:     "Test Tags",
		Status:    StatusOpen,
		Tags:      []string{"alpha", "beta"},
		CreatedAt: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "tags:") {
		t.Error("Marshal() should contain tags field")
	}
	if !strings.Contains(content, "- alpha") {
		t.Error("Marshal() should contain alpha tag")
	}
	if !strings.Contains(content, "- beta") {
		t.Error("Marshal() should contain beta tag")
	}

	// Round-trip test
	parsed, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("Round-trip Parse() error: %v", err)
	}
	if len(parsed.Tags) != 2 {
		t.Errorf("Round-trip Tags length = %d, want 2", len(parsed.Tags))
	}
}

func TestParseMixedDependencies(t *testing.T) {
	content := []byte(`---
title: Mixed deps test
status: open
depends-on:
  - bare-id-12345678
  - id: labeled-id-87654321
    label: needs data from
created-at: 2026-01-01T10:00:00Z
---
`)

	f, err := Parse("mixed-deps-aabbccdd", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	if len(f.DependsOn) != 2 {
		t.Fatalf("DependsOn length = %d, want 2", len(f.DependsOn))
	}

	// First dep: bare string
	if f.DependsOn[0].ID != "bare-id-12345678" {
		t.Errorf("DependsOn[0].ID = %q, want %q", f.DependsOn[0].ID, "bare-id-12345678")
	}
	if f.DependsOn[0].Label != "" {
		t.Errorf("DependsOn[0].Label = %q, want empty", f.DependsOn[0].Label)
	}

	// Second dep: object with label
	if f.DependsOn[1].ID != "labeled-id-87654321" {
		t.Errorf("DependsOn[1].ID = %q, want %q", f.DependsOn[1].ID, "labeled-id-87654321")
	}
	if f.DependsOn[1].Label != "needs data from" {
		t.Errorf("DependsOn[1].Label = %q, want %q", f.DependsOn[1].Label, "needs data from")
	}
}

func TestMarshalMixedDependencies(t *testing.T) {
	f := &Felt{
		ID:     "mixed-deps-aabbccdd",
		Title:  "Mixed deps test",
		Status: StatusOpen,
		DependsOn: Dependencies{
			{ID: "bare-id-12345678"},
			{ID: "labeled-id-87654321", Label: "needs data from"},
		},
		CreatedAt: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)

	// Bare dep should be emitted as plain string
	if !strings.Contains(content, "- bare-id-12345678") {
		t.Error("Marshal() should emit bare dep as string")
	}

	// Labeled dep should be emitted as object
	if !strings.Contains(content, "id: labeled-id-87654321") {
		t.Error("Marshal() should emit labeled dep with id field")
	}
	if !strings.Contains(content, "label: needs data from") {
		t.Error("Marshal() should emit labeled dep with label field")
	}

	// Round-trip
	parsed, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("Round-trip Parse() error: %v", err)
	}
	if len(parsed.DependsOn) != 2 {
		t.Fatalf("Round-trip DependsOn length = %d, want 2", len(parsed.DependsOn))
	}
	if parsed.DependsOn[0].ID != "bare-id-12345678" || parsed.DependsOn[0].Label != "" {
		t.Errorf("Round-trip DependsOn[0] = %+v, want {bare-id-12345678, \"\"}", parsed.DependsOn[0])
	}
	if parsed.DependsOn[1].ID != "labeled-id-87654321" || parsed.DependsOn[1].Label != "needs data from" {
		t.Errorf("Round-trip DependsOn[1] = %+v, want {labeled-id-87654321, needs data from}", parsed.DependsOn[1])
	}
}

func TestDependenciesHelpers(t *testing.T) {
	deps := Dependencies{
		{ID: "a-11111111"},
		{ID: "b-22222222", Label: "reason"},
	}

	// IDs
	ids := deps.IDs()
	if len(ids) != 2 || ids[0] != "a-11111111" || ids[1] != "b-22222222" {
		t.Errorf("IDs() = %v, want [a-11111111, b-22222222]", ids)
	}

	// HasID
	if !deps.HasID("a-11111111") {
		t.Error("HasID(a-11111111) should be true")
	}
	if deps.HasID("c-33333333") {
		t.Error("HasID(c-33333333) should be false")
	}

	// LabelFor
	if l := deps.LabelFor("b-22222222"); l != "reason" {
		t.Errorf("LabelFor(b-22222222) = %q, want %q", l, "reason")
	}
	if l := deps.LabelFor("a-11111111"); l != "" {
		t.Errorf("LabelFor(a-11111111) = %q, want empty", l)
	}
}
