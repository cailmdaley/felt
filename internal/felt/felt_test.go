package felt

import (
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
	if f.Status != StatusOpen {
		t.Errorf("Status = %q, want %q", f.Status, StatusOpen)
	}
	if f.Kind != DefaultKind {
		t.Errorf("Kind = %q, want %q", f.Kind, DefaultKind)
	}
	if f.Priority != 2 {
		t.Errorf("Priority = %d, want 2", f.Priority)
	}
	if !strings.HasPrefix(f.ID, "test-task-") {
		t.Errorf("ID = %q, want prefix %q", f.ID, "test-task-")
	}
	if len(f.ID) != len("test-task-")+8 {
		t.Errorf("ID length = %d, want %d", len(f.ID), len("test-task-")+8)
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
		title    string
		wantSlug string
	}{
		{"Simple", "simple-"},
		{"Multiple Words Here", "multiple-words-here-"},
		{"With 123 Numbers", "with-123-numbers-"},
		{"Special!@#Characters", "special-characters-"},
		{"  Extra   Spaces  ", "extra-spaces-"},
		{"", ""}, // empty title
		{"This is a very long title that should be truncated at word boundary", "this-is-a-very-long-title-that-"},
	}

	for _, tt := range tests {
		id, err := GenerateID(tt.title)
		if err != nil {
			t.Errorf("GenerateID(%q) error: %v", tt.title, err)
			continue
		}
		if !strings.HasPrefix(id, tt.wantSlug) {
			t.Errorf("GenerateID(%q) = %q, want prefix %q", tt.title, id, tt.wantSlug)
		}
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
kind: spec
priority: 1
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
	if f.Kind != "spec" {
		t.Errorf("Kind = %q, want %q", f.Kind, "spec")
	}
	if f.Priority != 1 {
		t.Errorf("Priority = %d, want 1", f.Priority)
	}
	if len(f.DependsOn) != 2 {
		t.Errorf("DependsOn length = %d, want 2", len(f.DependsOn))
	}
	if !strings.Contains(f.Body, "This is the body") {
		t.Errorf("Body = %q, want to contain %q", f.Body, "This is the body")
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
		Status:    StatusOpen,
		Kind:      "task",
		Priority:  2,
		DependsOn: []string{"dep-1-aaaaaaaa"},
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
	if parsed.Status != f.Status {
		t.Errorf("Round-trip Status = %q, want %q", parsed.Status, f.Status)
	}
}

func TestMatchesID(t *testing.T) {
	f := &Felt{ID: "test-task-12345678"}

	tests := []struct {
		query string
		want  bool
	}{
		{"test-task-12345678", true},  // exact match
		{"test-task-1234", true},       // prefix match
		{"test-task", true},            // prefix match
		{"test", true},                 // prefix match
		{"12345678", true},             // hex suffix match
		{"1234", true},                 // hex suffix prefix match
		{"other", false},               // no match
		{"test-task-123456789", false}, // too long
		{"5678", false},                // hex suffix, not prefix
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
		{"test-task-12345678", true},
		{"a-12345678", true},
		{"test-12345678", true},
		{"12345678", true},        // hex-only (from title with no alphanumeric chars)
		{"test-1234567", false},   // hex too short
		{"test-123456789", false}, // hex too long
		{"TEST-12345678", false},  // uppercase
		{"1234567", false},        // hex too short (no slug)
		{"123456789", false},      // hex too long (no slug)
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
	f := &Felt{Tags: []string{"alpha", "beta"}}

	if !f.HasTag("alpha") {
		t.Error("HasTag(alpha) should be true")
	}
	if !f.HasTag("beta") {
		t.Error("HasTag(beta) should be true")
	}
	if f.HasTag("gamma") {
		t.Error("HasTag(gamma) should be false")
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
		Kind:      "task",
		Tags:      []string{"alpha", "beta"},
		Priority:  2,
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
