package felt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNew(t *testing.T) {
	f, err := New("test-task", "Test Task")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if f.Title != "Test Task" {
		t.Errorf("Title = %q, want %q", f.Title, "Test Task")
	}
	if f.Name != "Test Task" {
		t.Errorf("Name = %q, want %q", f.Name, "Test Task")
	}
	if f.Status != "" {
		t.Errorf("Status = %q, want empty (no default status)", f.Status)
	}
	if f.ID != "test-task" {
		t.Errorf("ID = %q, want %q", f.ID, "test-task")
	}
	if f.Body != "" {
		t.Errorf("Body = %q, want empty before first save", f.Body)
	}
}

func TestNewRequiresName(t *testing.T) {
	_, err := New("mocks-unbiased", "")
	if err == nil {
		t.Fatal("New() should require a name")
	}
}

func TestNewSlugifiesInput(t *testing.T) {
	f, err := New("Mocks Unbiased", "Mocks unbiased")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if f.ID != "mocks-unbiased" {
		t.Errorf("ID = %q, want %q", f.ID, "mocks-unbiased")
	}
	if f.Name != "Mocks unbiased" {
		t.Errorf("Name = %q, want %q", f.Name, "Mocks unbiased")
	}
}

func TestNewEmptySlug(t *testing.T) {
	_, err := New("", "Some title")
	if err == nil {
		t.Error("New(\"\", ...) should return an error")
	}

	_, err = New("   ", "Some title")
	if err == nil {
		t.Error("New(\"   \", ...) should return an error")
	}
}

func TestBodyStartLine(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    int
	}{
		{
			name: "body after blank separator",
			content: `---
name: Test
created-at: 2026-04-10T09:00:00Z
---

first line
second line
`,
			want: 6,
		},
		{
			name: "body starts immediately after frontmatter",
			content: `---
name: Test
created-at: 2026-04-10T09:00:00Z
---
first line
`,
			want: 5,
		},
		{
			name: "empty body insertion point",
			content: `---
name: Test
created-at: 2026-04-10T09:00:00Z
---
`,
			want: 5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := BodyStartLine([]byte(tt.content))
			if err != nil {
				t.Fatalf("BodyStartLine() error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("BodyStartLine() = %d, want %d", got, tt.want)
			}
		})
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
		got := Slugify(tt.input)
		if got != tt.want {
			t.Errorf("Slugify(%q) = %q, want %q", tt.input, got, tt.want)
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
  - dep-a
  - dep-b
created-at: 2026-01-01T10:00:00Z
---

This is the body.

## Comments
Some comment here.
`)

	f, err := Parse("test-task", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	if f.ID != "test-task" {
		t.Errorf("ID = %q, want %q", f.ID, "test-task")
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
	if f.DependsOn[0].ID != "dep-a" || f.DependsOn[1].ID != "dep-b" {
		t.Errorf("DependsOn IDs = %v, want [dep-a, dep-b]", f.DependsOn.IDs())
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

	f, err := ParseWithMode("test-task", content, ParseMetadataOnly)
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
		ID:        "test-task",
		Title:     "Test Task",
		DependsOn: Dependencies{{ID: "dep-1"}},
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
	if !strings.Contains(content, "name: Test Task") {
		t.Error("Marshal() should contain name")
	}
	if !strings.Contains(content, "\n\nBody text here.\n") {
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

func TestMarshalLeavesEmptyBodyEmpty(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	f := &Felt{
		ID:        "quick-gotcha",
		Title:     "Quick gotcha",
		CreatedAt: now,
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)
	if strings.Contains(content, "# Quick gotcha") || strings.Contains(content, "(quick-gotcha)=") {
		t.Fatalf("Marshal() should not add scaffold body, got %q", content)
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
    scope: Linear BAO regime
    tags: [bao, literature]
    notes: Literature-backed prior, not a measurement from this analysis
    evidence:
      - id: ev1
        doi: 10.48550/arXiv.astro-ph/0604361
        version: 1
        document:
          path: docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex
          commit: abcdef1234567890
        quote:
          type: TextQuoteSelector
          exact: velocity flows move matter ~10 Mpc
          prefix: Large-scale
          suffix: across the BAO peak
        figure:
          type: FigureSelector
          label: Figure 1
          caption: BAO damping from bulk flows
        table:
          type: TableSelector
          label: Table 2
          region: row 3
        location:
          type: LineSelector
          start: 300
          end: 304
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
	if got := f.Insights["damping_physical"].Scope; got != "Linear BAO regime" {
		t.Fatalf("Insight Scope = %q", got)
	}
	if got := f.Insights["damping_physical"].Notes; got != "Literature-backed prior, not a measurement from this analysis" {
		t.Fatalf("Insight Notes = %q", got)
	}
	evidence := f.Insights["damping_physical"].Evidence[0]
	if evidence.Version == nil || *evidence.Version != 1 {
		t.Fatalf("Evidence Version = %#v", evidence.Version)
	}
	if evidence.Document == nil || evidence.Document.Commit != "abcdef1234567890" {
		t.Fatalf("Evidence Document = %#v", evidence.Document)
	}
	if evidence.Figure == nil || evidence.Figure.Label != "Figure 1" {
		t.Fatalf("Evidence Figure = %#v", evidence.Figure)
	}
	if evidence.Table == nil || evidence.Table.Region != "row 3" {
		t.Fatalf("Evidence Table = %#v", evidence.Table)
	}
	if evidence.Location == nil || evidence.Location.Start == nil || *evidence.Location.Start != 300 || evidence.Location.End == nil || *evidence.Location.End != 304 {
		t.Fatalf("Evidence Location = %#v", evidence.Location)
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
	roundTripEvidence := roundTrip.Insights["damping_physical"].Evidence[0]
	if roundTripEvidence.Quote == nil || roundTripEvidence.Quote.Prefix != "Large-scale" {
		t.Fatalf("round-trip insights = %#v", roundTrip.Insights)
	}
	if roundTripEvidence.Figure == nil || roundTripEvidence.Table == nil || roundTripEvidence.Location == nil {
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
			"damping_physical": {
				Claim: "Pairwise displacements are about 10 Mpc",
				Scope: "Linear BAO regime",
				Tags:  []string{"bao", "literature"},
				Notes: "Anchor the prior to cited literature",
				Evidence: []ASTRAEvidence{
					{
						ID:  "ev1",
						DOI: "10.48550/arXiv.astro-ph/0604361",
						Document: &ASTRADocument{
							Path:   "docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex",
							Commit: "abcdef1234567890",
						},
						Quote:  &ASTRAQuote{Type: "TextQuoteSelector", Exact: "velocity flows move matter ~10 Mpc", Prefix: "Large-scale", Suffix: "across the BAO peak"},
						Figure: &ASTRAFigure{Type: "FigureSelector", Label: "Figure 1", Caption: "BAO damping from bulk flows"},
						Table:  &ASTRATable{Type: "TableSelector", Label: "Table 2", Region: "row 3"},
						Location: &ASTRAFragment{
							Type:  "LineSelector",
							Start: intPtr(300),
							End:   intPtr(304),
						},
					},
				},
			},
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
		"Linear BAO regime",
		"Anchor the prior to cited literature",
		"Figure 1",
		"row 3",
		"docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex",
		"abcdef1234567890",
		"300",
		"304",
		"Shift stays below 0.5 sigma",
		"python:3.11-slim",
	} {
		if !strings.Contains(searchText, needle) {
			t.Fatalf("SearchText() missing %q in %q", needle, searchText)
		}
	}
}

func intPtr(v int) *int {
	return &v
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
	f := &Felt{ID: "test-task", Title: "Test Task", Body: "Initial body."}
	f.AppendComment("First comment")

	if !strings.HasPrefix(f.Body, "Initial body.") {
		t.Error("AppendComment should preserve existing body prefix")
	}
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

	f, err := Parse("test-with-tags", content)
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
		ID:        "test-tags",
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
  - bare-id
  - id: labeled-id
    label: needs data from
created-at: 2026-01-01T10:00:00Z
---
`)

	f, err := Parse("mixed-deps", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	if len(f.DependsOn) != 2 {
		t.Fatalf("DependsOn length = %d, want 2", len(f.DependsOn))
	}

	// First dep: bare string gets default label
	if f.DependsOn[0].ID != "bare-id" {
		t.Errorf("DependsOn[0].ID = %q, want %q", f.DependsOn[0].ID, "bare-id")
	}
	if f.DependsOn[0].Label != DefaultDepLabel {
		t.Errorf("DependsOn[0].Label = %q, want %q", f.DependsOn[0].Label, DefaultDepLabel)
	}

	// Second dep: object with label
	if f.DependsOn[1].ID != "labeled-id" {
		t.Errorf("DependsOn[1].ID = %q, want %q", f.DependsOn[1].ID, "labeled-id")
	}
	if f.DependsOn[1].Label != "needs data from" {
		t.Errorf("DependsOn[1].Label = %q, want %q", f.DependsOn[1].Label, "needs data from")
	}
}

func TestMarshalMixedDependencies(t *testing.T) {
	f := &Felt{
		ID:     "mixed-deps",
		Title:  "Mixed deps test",
		Status: StatusOpen,
		DependsOn: Dependencies{
			{ID: "bare-id"},
			{ID: "labeled-id", Label: "needs data from"},
		},
		CreatedAt: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)

	// All deps emitted as objects (always object form now)
	if !strings.Contains(content, "id: bare-id") {
		t.Error("Marshal() should emit bare dep as object with id field")
	}
	if !strings.Contains(content, "label: depends on") {
		t.Error("Marshal() should emit default label for bare dep")
	}

	// Labeled dep should be emitted as object
	if !strings.Contains(content, "id: labeled-id") {
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
	if parsed.DependsOn[0].ID != "bare-id" || parsed.DependsOn[0].Label != DefaultDepLabel {
		t.Errorf("Round-trip DependsOn[0] = %+v, want {bare-id, %q}", parsed.DependsOn[0], DefaultDepLabel)
	}
	if parsed.DependsOn[1].ID != "labeled-id" || parsed.DependsOn[1].Label != "needs data from" {
		t.Errorf("Round-trip DependsOn[1] = %+v, want {labeled-id, needs data from}", parsed.DependsOn[1])
	}
}

func TestDependenciesHelpers(t *testing.T) {
	deps := Dependencies{
		{ID: "task-a"},
		{ID: "task-b", Label: "reason"},
	}

	// IDs
	ids := deps.IDs()
	if len(ids) != 2 || ids[0] != "task-a" || ids[1] != "task-b" {
		t.Errorf("IDs() = %v, want [task-a, task-b]", ids)
	}

	// HasID
	if !deps.HasID("task-a") {
		t.Error("HasID(task-a) should be true")
	}
	if deps.HasID("task-c") {
		t.Error("HasID(task-c) should be false")
	}

	// LabelFor
	if l := deps.LabelFor("task-b"); l != "reason" {
		t.Errorf("LabelFor(task-b) = %q, want %q", l, "reason")
	}
	if l := deps.LabelFor("task-a"); l != "" {
		t.Errorf("LabelFor(task-a) = %q, want empty", l)
	}
}
