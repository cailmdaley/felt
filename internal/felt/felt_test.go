package felt

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func mustExtraField(t *testing.T, f *Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

func TestNew(t *testing.T) {
	f, err := New("test-task", "Test Task")
	if err != nil {
		t.Fatalf("New() error: %v", err)
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
	if !looksLikeULID(f.UID) {
		t.Errorf("UID = %q, want 26-character ULID", f.UID)
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

func TestNewPreservesLongExplicitSlug(t *testing.T) {
	// Regression: felt add used to silently truncate basenames at 32 chars
	// via truncateAtWord, which could collide with existing siblings and
	// produce confusing "already exists" errors.
	tests := []struct {
		slug string
	}{
		{"exit-interview-2026-04-10-obsidian"},                      // 34 chars — the bug trigger
		{"exit-interview-2026-04-10-relationship-model-completion"}, // 55 chars
		{"felt/exit-interview-2026-04-10-hook-rewrite"},             // nested path with long basename
	}
	for _, tt := range tests {
		f, err := New(tt.slug, "Any name")
		if err != nil {
			t.Fatalf("New(%q, ...) error: %v", tt.slug, err)
		}
		if f.ID != tt.slug {
			t.Errorf("New(%q, ...).ID = %q, want %q", tt.slug, f.ID, tt.slug)
		}
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
name: Test Task
status: active
tags:
  - spec
inputs:
  - id: dep_a
    from: dep-a.output
  - id: dep_b
    from: dep-b
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
	if f.Name != "Test Task" {
		t.Errorf("Name = %q, want %q", f.Name, "Test Task")
	}
	if f.Status != StatusActive {
		t.Errorf("Status = %q, want %q", f.Status, StatusActive)
	}
	if !f.HasTag("spec") {
		t.Errorf("HasTag(spec) = false, want true")
	}
	inputs := f.DataFlowInputs()
	if len(inputs) != 2 {
		t.Errorf("DataFlowInputs length = %d, want 2", len(inputs))
	}
	if inputs[0].From != "dep-a.output" || inputs[1].From != "dep-b" {
		t.Errorf("Input refs = [%q %q], want [dep-a.output dep-b]", inputs[0].From, inputs[1].From)
	}
	if !strings.Contains(f.Body, "This is the body") {
		t.Errorf("Body = %q, want to contain %q", f.Body, "This is the body")
	}
}

func TestParseWithModeMetadataOnly(t *testing.T) {
	content := []byte(`---
name: Test Task
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

	if f.Name != "Test Task" {
		t.Errorf("Name = %q, want %q", f.Name, "Test Task")
	}
	if f.Outcome != "Metadata survives" {
		t.Errorf("Outcome = %q, want %q", f.Outcome, "Metadata survives")
	}
	if f.Body != "" {
		t.Errorf("Body = %q, want empty for metadata-only parse", f.Body)
	}
}

func TestParseFrontmatterBlockScalarDocumentMarkers(t *testing.T) {
	tests := []struct {
		name      string
		indicator string
	}{
		{name: "literal strip", indicator: "|-"},
		{name: "literal clip", indicator: "|"},
		{name: "folded strip", indicator: ">-"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			content := []byte(`---
name: Standing Inbox
status: active
created-at: 2026-05-08T10:00:00Z
outcome: ` + tt.indicator + `
  2026-05-07 | reviewed

  ---

  2026-05-08 | reviewed
shuttle:
  enabled: true
  kind: standing
tempered: true
---

Body with a thematic break below.

---
`)

			f, err := Parse("loom/email/standing-inbox-triage", content)
			if err != nil {
				t.Fatalf("Parse() error: %v", err)
			}
			if !strings.Contains(f.Outcome, "---") {
				t.Fatalf("Outcome = %q, want embedded document marker text", f.Outcome)
			}
			if mappingValueNode(f.ExtraFields["shuttle"], "enabled") == nil {
				t.Fatalf("shuttle extra field missing enabled: %#v", f.ExtraFields["shuttle"])
			}
			if f.ExtraFields["tempered"] == nil {
				t.Fatal("tempered extra field missing")
			}
			if !strings.Contains(f.Body, "Body with a thematic break below.") || !strings.Contains(f.Body, "---") {
				t.Fatalf("Body = %q, want body after closing frontmatter", f.Body)
			}
		})
	}
}

func TestParseWithModeMetadataOnlyPreservesFieldsAfterBlockScalarMarker(t *testing.T) {
	content := []byte(`---
name: Standing Inbox
status: active
created-at: 2026-05-08T10:00:00Z
outcome: |-
  first run
  ---
  second run
shuttle:
  enabled: true
  kind: standing
tempered: true
---

This body should not be parsed.
`)

	f, err := ParseWithMode("loom/email/standing-inbox-triage", content, ParseMetadataOnly)
	if err != nil {
		t.Fatalf("ParseWithMode() error: %v", err)
	}
	if f.Body != "" {
		t.Fatalf("Body = %q, want empty for metadata-only parse", f.Body)
	}
	if mappingValueNode(f.ExtraFields["shuttle"], "kind") == nil {
		t.Fatalf("shuttle extra field missing kind: %#v", f.ExtraFields["shuttle"])
	}
	if f.ExtraFields["tempered"] == nil {
		t.Fatal("tempered extra field missing")
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
		Name:      "Test Task",
		CreatedAt: now,
		Body:      "Body text here.",
	}
	mustExtraField(t, f, "inputs", []map[string]any{{"id": "dep_1", "from": "dep-1.output"}})

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
	if parsed.Name != f.Name {
		t.Errorf("Round-trip Name = %q, want %q", parsed.Name, f.Name)
	}
	if parsed.Status != "" {
		t.Errorf("Round-trip Status = %q, want empty", parsed.Status)
	}
}

func TestUpdatedAtRoundTrips(t *testing.T) {
	created := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	updated := time.Date(2026, 3, 4, 12, 30, 0, 0, time.UTC)
	f := &Felt{
		ID:        "touched",
		Name:      "Touched",
		CreatedAt: created,
		UpdatedAt: &updated,
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	if !strings.Contains(string(data), "updated-at:") {
		t.Fatalf("Marshal() should emit updated-at, got %q", string(data))
	}

	parsed, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("Round-trip Parse() error: %v", err)
	}
	if parsed.UpdatedAt == nil || !parsed.UpdatedAt.Equal(updated) {
		t.Fatalf("Round-trip UpdatedAt = %v, want %v", parsed.UpdatedAt, updated)
	}
}

func TestMarshalOmitsUpdatedAtWhenUnset(t *testing.T) {
	f := &Felt{
		ID:        "untouched",
		Name:      "Untouched",
		CreatedAt: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
	}
	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	// Fibers never touched since the field shipped must not gain an empty
	// updated-at line — that would mass-rewrite the store and churn git.
	if strings.Contains(string(data), "updated-at") {
		t.Fatalf("Marshal() should omit updated-at when unset, got %q", string(data))
	}
}

func TestRecencyAnchor(t *testing.T) {
	created := time.Date(2025, 11, 2, 14, 30, 0, 0, time.UTC)
	updated := time.Date(2026, 5, 20, 8, 15, 0, 0, time.UTC)

	// updated-at newer than created-at → updated-at wins.
	if got := (&Felt{CreatedAt: created, UpdatedAt: &updated}).RecencyAnchor(); !got.Equal(updated) {
		t.Fatalf("RecencyAnchor with newer updated-at = %v, want %v", got, updated)
	}
	// updated-at absent → created-at.
	if got := (&Felt{CreatedAt: created}).RecencyAnchor(); !got.Equal(created) {
		t.Fatalf("RecencyAnchor without updated-at = %v, want %v", got, created)
	}
	// updated-at older than created-at (hand-edited/corrupt) → created-at wins.
	older := created.Add(-time.Hour)
	if got := (&Felt{CreatedAt: created, UpdatedAt: &older}).RecencyAnchor(); !got.Equal(created) {
		t.Fatalf("RecencyAnchor with older updated-at = %v, want created-at %v", got, created)
	}
}

func TestMarshalLeavesEmptyBodyEmpty(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	f := &Felt{
		ID:        "quick-gotcha",
		Name:      "Quick gotcha",
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

func TestParseAndMarshalStructuredFields(t *testing.T) {
	content := []byte(`---
name: BAO Damping Prior
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
	inputs := f.DataFlowInputs()
	if len(inputs) != 1 || inputs[0].InputID != "clustering_data" || inputs[0].From != "parent.desi_dr1_vac" {
		t.Fatalf("DataFlowInputs = %#v", inputs)
	}
	if !f.HasDataFlowOutput("damped_pk") {
		t.Fatalf("HasDataFlowOutput(damped_pk) = false")
	}
	for _, key := range []string{"inputs", "outputs", "decisions", "insights", "success_criteria", "container"} {
		if _, ok := f.ExtraFields[key]; !ok {
			t.Fatalf("ExtraFields missing %q", key)
		}
	}
	raw := f.ExtraFieldsYAML()
	for _, needle := range []string{"excluded_reason: Shifts too far", "commit: abcdef1234567890", "caption: BAO damping from bulk flows", "container: python:3.11-slim"} {
		if !strings.Contains(raw, needle) {
			t.Fatalf("ExtraFieldsYAML missing %q in:\n%s", needle, raw)
		}
	}

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	roundTrip, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("round-trip Parse() error: %v", err)
	}
	if got := roundTrip.ExtraFieldsYAML(); !strings.Contains(got, "Large-scale") || !strings.Contains(got, "row 3") {
		t.Fatalf("round-trip opaque frontmatter lost detail:\n%s", got)
	}
	inputs = roundTrip.DataFlowInputs()
	if len(inputs) != 1 || inputs[0].From != "parent.desi_dr1_vac" {
		t.Fatalf("round-trip DataFlowInputs = %#v", inputs)
	}
	if !roundTrip.HasDataFlowOutput("damped_pk") {
		t.Fatalf("round-trip HasDataFlowOutput(damped_pk) = false")
	}
}

// TestMarshalPreservesExtraFieldOrder guards against the churn bug where
// Marshal ranged the ExtraFields map directly: Go randomizes map iteration, so
// every write re-emitted extra fields in a random order and produced spurious
// diffs across machines/builds. Order must round-trip exactly, deterministically
// — including a non-alphabetical input order, repeated across marshals.
func TestMarshalPreservesExtraFieldOrder(t *testing.T) {
	// tempered before shuttle is intentionally non-alphabetical: an alpha sort
	// would reorder these, so a stable result proves order is *preserved*, not
	// merely deterministic.
	content := []byte(`---
name: Order Fixture
status: active
created-at: 2026-05-31T00:00:00Z
tempered: true
shuttle:
  enabled: true
  kind: oneshot
insights:
  finding:
    claim: order is preserved
---

# Order Fixture
`)
	f, err := Parse("order-fixture", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}
	want := []string{"tempered", "shuttle", "insights"}
	if got := f.orderedExtraKeys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("orderedExtraKeys() = %v, want %v", got, want)
	}

	// Many successive marshals must be byte-identical (the bug surfaced as
	// run-to-run variation, so a single marshal would not catch it).
	first, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	for i := 0; i < 50; i++ {
		again, err := f.Marshal()
		if err != nil {
			t.Fatalf("Marshal() error on iter %d: %v", i, err)
		}
		if !bytes.Equal(first, again) {
			t.Fatalf("Marshal() not deterministic on iter %d:\nfirst:\n%s\nagain:\n%s", i, first, again)
		}
	}

	// And the order must survive a parse → marshal → parse round-trip.
	rt, err := Parse(f.ID, first)
	if err != nil {
		t.Fatalf("round-trip Parse() error: %v", err)
	}
	if got := rt.orderedExtraKeys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("round-trip orderedExtraKeys() = %v, want %v", got, want)
	}

	// A newly set extra field appends at the end; deleting one removes it
	// without disturbing the rest.
	if err := rt.SetExtraField("zebra", map[string]any{"k": "v"}); err != nil {
		t.Fatalf("SetExtraField() error: %v", err)
	}
	if got, want := rt.orderedExtraKeys(), []string{"tempered", "shuttle", "insights", "zebra"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after add orderedExtraKeys() = %v, want %v", got, want)
	}
	if err := rt.SetExtraField("shuttle", nil); err != nil {
		t.Fatalf("SetExtraField(delete) error: %v", err)
	}
	if got, want := rt.orderedExtraKeys(), []string{"tempered", "insights", "zebra"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after delete orderedExtraKeys() = %v, want %v", got, want)
	}
}

func TestSearchTextIncludesStructuredFields(t *testing.T) {
	content := []byte(`---
id: 01JZ0000000000000000000002
name: Searchable structured fields
created-at: 2026-03-15T10:00:00Z
description: Description text
outcome: Outcome text
inputs:
  - id: clustering_data
    description: DESI DR1 clustering data
outputs:
  - id: damped_pk
    description: Power spectrum figure
    recipe:
      command: python fit.py
decisions:
  damping_prior:
    label: BAO Damping Prior
    rationale: Broadband projection creates spurious minima
insights:
  damping_physical:
    claim: Pairwise displacements are about 10 Mpc
    scope: Linear BAO regime
    tags: [bao, literature]
    notes: Anchor the prior to cited literature
    evidence:
      - id: ev1
        doi: 10.48550/arXiv.astro-ph/0604361
        document:
          path: docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex
          commit: abcdef1234567890
        figure:
          type: FigureSelector
          label: Figure 1
        table:
          type: TableSelector
          region: row 3
        location:
          type: LineSelector
          start: 300
          end: 304
success_criteria:
  - claim: Shift stays below 0.5 sigma
container: python:3.11-slim
---
`)

	f, err := Parse("searchable-structured-fields", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	searchText := f.SearchText()
	for _, needle := range []string{
		"01JZ0000000000000000000002",
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

func TestJSONOmitsEmptyStructuredFields(t *testing.T) {
	f := &Felt{
		ID:        "quick-gotcha",
		Name:      "Quick gotcha",
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
name: Test with Tags
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
		Name:      "Test Tags",
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

func TestParseInputRefs(t *testing.T) {
	content := []byte(`---
name: Mixed input refs test
status: open
inputs:
  - id: data_input
    from: bare-id
  - id: labeled_input
    from: labeled-id.output
created-at: 2026-01-01T10:00:00Z
---
`)

	f, err := Parse("mixed-inputs", content)
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	inputs := f.DataFlowInputs()
	if len(inputs) != 2 {
		t.Fatalf("DataFlowInputs length = %d, want 2", len(inputs))
	}
	if inputs[0].InputID != "data_input" || inputs[0].From != "bare-id" {
		t.Errorf("Inputs[0] = %+v, want {InputID:data_input From:bare-id}", inputs[0])
	}
	if inputs[1].InputID != "labeled_input" || inputs[1].From != "labeled-id.output" {
		t.Errorf("Inputs[1] = %+v, want {InputID:labeled_input From:labeled-id.output}", inputs[1])
	}
}

func TestMarshalInputRefs(t *testing.T) {
	f := &Felt{
		ID:        "mixed-inputs",
		Name:      "Mixed input refs test",
		Status:    StatusOpen,
		CreatedAt: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
	}
	mustExtraField(t, f, "inputs", []map[string]any{
		{"id": "data_input", "from": "bare-id"},
		{"id": "labeled_input", "from": "labeled-id.output"},
	})

	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "id: data_input") {
		t.Error("Marshal() should emit first input id")
	}
	if !strings.Contains(content, "from: bare-id") {
		t.Error("Marshal() should emit first input ref")
	}
	if !strings.Contains(content, "id: labeled_input") || !strings.Contains(content, "from: labeled-id.output") {
		t.Error("Marshal() should emit second input ref")
	}

	parsed, err := Parse(f.ID, data)
	if err != nil {
		t.Fatalf("Round-trip Parse() error: %v", err)
	}
	inputs := parsed.DataFlowInputs()
	if len(inputs) != 2 {
		t.Fatalf("Round-trip Inputs length = %d, want 2", len(inputs))
	}
	if inputs[0].InputID != "data_input" || inputs[0].From != "bare-id" {
		t.Errorf("Round-trip Inputs[0] = %+v, want {InputID:data_input From:bare-id}", inputs[0])
	}
	if inputs[1].InputID != "labeled_input" || inputs[1].From != "labeled-id.output" {
		t.Errorf("Round-trip Inputs[1] = %+v, want {InputID:labeled_input From:labeled-id.output}", inputs[1])
	}
}

func TestExtractBodyRefsParsesFragments(t *testing.T) {
	body := `
See [[analysis]] and [[analysis#decision-a|decision]].
Cross-check [method](project/method#step-1) and ignore [site](https://example.com).
`

	refs := ExtractBodyRefs(body)
	if len(refs) != 3 {
		t.Fatalf("ExtractBodyRefs() len = %d, want 3", len(refs))
	}

	got := map[string]bool{}
	for _, ref := range refs {
		got[ref.String()] = true
	}
	for _, want := range []string{"analysis", "analysis#decision-a", "project/method#step-1"} {
		if !got[want] {
			t.Fatalf("missing ref %q in %#v", want, refs)
		}
	}
}

func TestExtractBodyRefsIgnoresCodeSpans(t *testing.T) {
	body := `
Real link: [[real-fiber]].
Code span: ` + "`[[illustrative]]`" + `.
Code block:
` + "```" + `
[[in-code-block]]
` + "```" + `
Back to real: [[another-real]].
`
	refs := ExtractBodyRefs(body)
	got := map[string]bool{}
	for _, ref := range refs {
		got[ref.String()] = true
	}
	if !got["real-fiber"] {
		t.Error("should include real-fiber")
	}
	if !got["another-real"] {
		t.Error("should include another-real")
	}
	if got["illustrative"] {
		t.Error("should not include illustrative (in code span)")
	}
	if got["in-code-block"] {
		t.Error("should not include in-code-block (in code block)")
	}
}

// TestExtraFieldsRoundTrip verifies that tool-owned frontmatter blocks
// (unknown top-level keys like tempered:, or arbitrary nested namespaces)
// survive a Parse → Marshal round-trip unchanged. This guards against
// felt edit silently dropping them.
func TestExtraFieldsRoundTrip(t *testing.T) {
	input := `---
name: My constitution
status: active
tags:
    - constitution
created-at: 2026-05-01T10:00:00Z
outcome: >-
    Working on it.
tempered: false
mytool:
    enabled: true
    kind: oneshot
    agent: claude-sonnet
---

Body here.
`
	f, err := Parse("ai-futures/my-constitution", []byte(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	// Felt-owned fields should parse correctly.
	if f.Name != "My constitution" {
		t.Errorf("Name = %q, want %q", f.Name, "My constitution")
	}
	if f.Status != "active" {
		t.Errorf("Status = %q, want %q", f.Status, "active")
	}

	// Tool-owned fields must land in ExtraFields, not be dropped.
	if f.ExtraFields == nil {
		t.Fatal("ExtraFields is nil; expected mytool: and tempered: to be captured")
	}
	if _, ok := f.ExtraFields["mytool"]; !ok {
		t.Error("ExtraFields missing 'mytool' key")
	}
	if _, ok := f.ExtraFields["tempered"]; !ok {
		t.Error("ExtraFields missing 'tempered' key")
	}

	// Round-trip: marshal and re-parse; tool-owned fields must still be present.
	out, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	outStr := string(out)

	f2, err := Parse("ai-futures/my-constitution", out)
	if err != nil {
		t.Fatalf("Round-trip Parse: %v", err)
	}
	if f2.Name != f.Name {
		t.Errorf("Round-trip Name = %q, want %q", f2.Name, f.Name)
	}
	if f2.ExtraFields == nil {
		t.Fatalf("Round-trip ExtraFields is nil; marshaled output was:\n%s", outStr)
	}
	if _, ok := f2.ExtraFields["mytool"]; !ok {
		t.Errorf("Round-trip ExtraFields missing 'mytool'; marshaled output was:\n%s", outStr)
	}
	if _, ok := f2.ExtraFields["tempered"]; !ok {
		t.Errorf("Round-trip ExtraFields missing 'tempered'; marshaled output was:\n%s", outStr)
	}

	// mytool block structure must be intact.
	if !strings.Contains(outStr, "enabled: true") {
		t.Errorf("Round-trip output missing 'enabled: true'; got:\n%s", outStr)
	}
	if !strings.Contains(outStr, "claude-sonnet") {
		t.Errorf("Round-trip output missing agent value 'claude-sonnet'; got:\n%s", outStr)
	}
	if !strings.Contains(outStr, "tempered: false") {
		t.Errorf("Round-trip output missing 'tempered: false'; got:\n%s", outStr)
	}
}

func TestFrontmatterIDRoundTripAsNativeUID(t *testing.T) {
	const intrinsicID = "01JZ0000000000000000000000"
	input := `---
id: 01JZ0000000000000000000000
name: Federated fiber
status: active
created-at: 2026-05-04T00:00:00Z
shuttle:
    enabled: true
---

Body.
`
	f, err := Parse("project/federated-fiber", []byte(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if f.ID != "project/federated-fiber" {
		t.Fatalf("slug ID = %q, want project/federated-fiber", f.ID)
	}
	if f.UID != intrinsicID {
		t.Fatalf("UID = %q, want %q", f.UID, intrinsicID)
	}
	if _, ok := f.ExtraFields["id"]; ok {
		t.Fatal("frontmatter id should be native, not an opaque extra field")
	}

	out, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	outStr := string(out)
	if !strings.Contains(outStr, "id: "+intrinsicID) {
		t.Fatalf("Marshal output missing intrinsic id:\n%s", outStr)
	}

	jsonBytes, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(jsonBytes, &decoded); err != nil {
		t.Fatalf("Unmarshal JSON: %v\n%s", err, string(jsonBytes))
	}
	if decoded["id"] != "project/federated-fiber" {
		t.Fatalf("JSON id = %v, want slug", decoded["id"])
	}
	if decoded["uid"] != intrinsicID {
		t.Fatalf("JSON uid = %v, want %s", decoded["uid"], intrinsicID)
	}
}

// TestMarshalJSONIncludesExtraFields verifies that `felt show --json` (and
// any other JSON consumer of Felt) sees tool-owned frontmatter as flat
// top-level keys, with values rendered as native JSON. Regression guard:
// without this, downstream tools were forced into per-key `--field` reads
// because the JSON output silently dropped namespaces it didn't model.
func TestMarshalJSONIncludesExtraFields(t *testing.T) {
	input := `---
name: Modal fiber
status: active
tags:
    - constitution
created-at: 2026-05-04T00:00:00Z
tempered: false
shuttle:
    enabled: true
    kind: oneshot
    agent: claude-opus
    session:
        id: 68b394d0-927b-4130-aba2-be4b87c33017
        agent: claude-sonnet
depends_on:
    - some-other-fiber
---

Body.
`
	f, err := Parse("tests/modal", []byte(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	out, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("Unmarshal output: %v\noutput was: %s", err, string(out))
	}

	// Known fields still surface (the alias path).
	if decoded["name"] != "Modal fiber" {
		t.Errorf("name = %v, want \"Modal fiber\"", decoded["name"])
	}
	if decoded["status"] != "active" {
		t.Errorf("status = %v, want \"active\"", decoded["status"])
	}

	// Tool-owned namespaces appear at top level as native JSON.
	shuttle, ok := decoded["shuttle"].(map[string]interface{})
	if !ok {
		t.Fatalf("decoded[\"shuttle\"] is not a map; got %T: %v\nfull JSON:\n%s",
			decoded["shuttle"], decoded["shuttle"], string(out))
	}
	if shuttle["enabled"] != true {
		t.Errorf("shuttle.enabled = %v, want true", shuttle["enabled"])
	}
	if shuttle["agent"] != "claude-opus" {
		t.Errorf("shuttle.agent = %v, want \"claude-opus\"", shuttle["agent"])
	}
	if shuttle["kind"] != "oneshot" {
		t.Errorf("shuttle.kind = %v, want \"oneshot\"", shuttle["kind"])
	}

	// Nested structure round-trips too.
	session, ok := shuttle["session"].(map[string]interface{})
	if !ok {
		t.Fatalf("shuttle.session is not a map; got %T", shuttle["session"])
	}
	if session["id"] != "68b394d0-927b-4130-aba2-be4b87c33017" {
		t.Errorf("shuttle.session.id = %v", session["id"])
	}

	// Scalar tool-owned fields surface as native JSON scalars.
	if decoded["tempered"] != false {
		t.Errorf("tempered = %v (type %T), want false", decoded["tempered"], decoded["tempered"])
	}

	// List-shaped tool-owned fields too.
	deps, ok := decoded["depends_on"].([]interface{})
	if !ok || len(deps) != 1 || deps[0] != "some-other-fiber" {
		t.Errorf("depends_on = %v, want [\"some-other-fiber\"]", decoded["depends_on"])
	}
}

// TestMarshalJSONIncludesLegacyDependsOn guards against a regression: the
// hyphenated `depends-on:` form was previously listed in
// knownFrontmatterKeys without a corresponding struct field, so it was
// silently absorbed at parse time and never appeared anywhere — including
// in JSON output, which is what bit Portolan's tapestry view (it relies on
// the dependency edges being visible via felt show/ls JSON). The fix is
// to leave depends-on out of knownFrontmatterKeys so it lands in
// ExtraFields like any other unknown key, then surfaces flat-top-level
// in MarshalJSON output.
func TestMarshalJSONIncludesLegacyDependsOn(t *testing.T) {
	input := `---
name: Legacy fiber
status: open
created-at: 2026-05-04T00:00:00Z
depends-on:
    - upstream-fiber
    - other-upstream
---

Body.
`
	f, err := Parse("tests/legacy", []byte(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	out, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("Unmarshal output: %v", err)
	}

	deps, ok := decoded["depends-on"].([]interface{})
	if !ok {
		t.Fatalf("depends-on missing or not a list; got %T: %v\nfull JSON:\n%s",
			decoded["depends-on"], decoded["depends-on"], string(out))
	}
	if len(deps) != 2 || deps[0] != "upstream-fiber" || deps[1] != "other-upstream" {
		t.Errorf("depends-on = %v, want [\"upstream-fiber\", \"other-upstream\"]", deps)
	}
}

// TestMarshalJSONNoExtraFields exercises the fast path: a fiber with no
// tool-owned frontmatter must round-trip through MarshalJSON without
// regression.
func TestMarshalJSONNoExtraFields(t *testing.T) {
	input := `---
name: Plain fiber
status: open
tags:
    - simple
created-at: 2026-05-04T00:00:00Z
---

Body.
`
	f, err := Parse("tests/plain", []byte(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	out, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded["name"] != "Plain fiber" {
		t.Errorf("name = %v", decoded["name"])
	}
	// No tool-owned keys should appear.
	if _, ok := decoded["shuttle"]; ok {
		t.Error("unexpected shuttle key in plain fiber JSON")
	}
}

func looksLikeULID(value string) bool {
	if len(value) != 26 {
		return false
	}
	for _, r := range value {
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", r) {
			return false
		}
	}
	return true
}
