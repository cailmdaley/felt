package felt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustExtra(t *testing.T, f *Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

func TestCheckBrokenBodyReference(t *testing.T) {
	issues := Check([]*Felt{{
		ID:   "fiber-a",
		Name: "Fiber A",
		Body: "See [[missing]].",
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "body" {
		t.Fatalf("issue path = %q, want body", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "broken body reference") {
		t.Fatalf("issue message = %q, want broken body reference", issues[0].Message)
	}
}

func TestCheckEmptyName(t *testing.T) {
	issues := Check([]*Felt{{ID: "blank-name", Name: "  "}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "frontmatter.name" {
		t.Fatalf("issue path = %q, want frontmatter.name", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "name cannot be empty") {
		t.Fatalf("issue message = %q, want empty-name failure", issues[0].Message)
	}
}

func TestCheckBrokenBodyReferenceFragmentAgainstOpaqueFrontmatter(t *testing.T) {
	target := &Felt{ID: "fiber-b", Name: "Fiber B"}
	mustExtra(t, target, "decisions", map[string]any{
		"choice": map[string]any{"label": "Choice"},
	})

	issues := Check([]*Felt{
		{ID: "fiber-a", Name: "Fiber A", Body: "See [[fiber-b#missing-element]]."},
		target,
	})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "body" {
		t.Fatalf("issue path = %q, want body", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, `has no element "missing-element"`) {
		t.Fatalf("issue message = %q, want missing element failure", issues[0].Message)
	}
}

func TestCheckBrokenDataFlowReference(t *testing.T) {
	fiber := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, fiber, "inputs", []map[string]any{{
		"id":   "catalog",
		"from": "missing.output",
	}})

	issues := Check([]*Felt{fiber})
	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "inputs.catalog.from" {
		t.Fatalf("issue path = %q, want inputs.catalog.from", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "broken data-flow reference") {
		t.Fatalf("issue message = %q, want broken data-flow reference", issues[0].Message)
	}
}

func TestCheckBrokenDataFlowOutputReference(t *testing.T) {
	consumer := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, consumer, "inputs", []map[string]any{{
		"id":   "catalog",
		"from": "fiber-b.missing-output",
	}})
	producer := &Felt{ID: "fiber-b", Name: "Fiber B"}
	mustExtra(t, producer, "outputs", []map[string]any{{"id": "present-output"}})

	issues := Check([]*Felt{consumer, producer})
	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "inputs.catalog.from" {
		t.Fatalf("issue path = %q, want inputs.catalog.from", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, `has no output "missing-output"`) {
		t.Fatalf("issue message = %q, want missing output failure", issues[0].Message)
	}
}

func TestCheckLegacyFormatReportsTitleDependsOnAndMystAnchor(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	content := `---
title: Legacy Fiber
depends-on:
  - upstream
created-at: 2026-04-10T10:00:00Z
---

(legacy-fiber)=

Body.
`
	path := filepath.Join(dir, DirName, "legacy-fiber", "legacy-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir legacy fiber: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write legacy fiber: %v", err)
	}

	issues, err := CheckLegacyFormat(s)
	if err != nil {
		t.Fatalf("CheckLegacyFormat() error: %v", err)
	}
	if len(issues) != 3 {
		t.Fatalf("CheckLegacyFormat() produced %d issues, want 3", len(issues))
	}
	bodyIssue := false
	titleIssue := false
	dependsOnIssue := false
	for _, issue := range issues {
		if issue.Path == "body" && strings.Contains(issue.Message, "legacy MyST anchor") {
			bodyIssue = true
		}
		if issue.Path == "frontmatter" && strings.Contains(issue.Message, `"title"`) {
			titleIssue = true
		}
		if issue.Path == "frontmatter" && strings.Contains(issue.Message, `"depends-on"`) {
			dependsOnIssue = true
		}
	}
	if !bodyIssue {
		t.Fatalf("issues = %#v, want body issue", issues)
	}
	if !titleIssue || !dependsOnIssue {
		t.Fatalf("issues = %#v, want title and depends-on frontmatter issues", issues)
	}
}

func TestCheckLegacyFormatSkipsMalformedFrontmatter(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	path := filepath.Join(dir, DirName, "broken-fiber", "broken-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir broken fiber: %v", err)
	}
	content := "---\nname: Broken Fiber\ncreated-at: 2026-04-10T10:00:00Z\noutcome: Backticks: `value`\n---\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write broken fiber: %v", err)
	}

	issues, err := CheckLegacyFormat(s)
	if err != nil {
		t.Fatalf("CheckLegacyFormat() error: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("CheckLegacyFormat() issues = %#v, want none", issues)
	}
}

func TestCheckStructureMultipleBareFibers(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "alpha.md"), []byte("---\nname: alpha\n---\n"), 0644)
	os.WriteFile(filepath.Join(s.root, "beta.md"), []byte("---\nname: beta\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 1 || issues[0].Level != CheckLevelError {
		t.Fatalf("issues = %+v, want 1 error", issues)
	}
	if !strings.Contains(issues[0].Message, "multiple bare fiber files") {
		t.Fatalf("message = %q, want multiple-bare error", issues[0].Message)
	}
}

func TestCheckStructureSlugCollision(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "cmbx.md"), []byte("---\nname: bare\n---\n"), 0644)
	nestedDir := filepath.Join(s.root, "cmbx")
	os.MkdirAll(nestedDir, 0755)
	os.WriteFile(filepath.Join(nestedDir, "cmbx.md"), []byte("---\nname: nested\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	found := false
	for _, i := range issues {
		if strings.Contains(i.Message, "slug collision") {
			found = true
			if i.Level != CheckLevelError {
				t.Errorf("collision level = %q, want error", i.Level)
			}
		}
	}
	if !found {
		t.Fatalf("no slug-collision issue reported, got: %+v", issues)
	}
}

func TestCheckStructureCleanRepo(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "cmbx.md"), []byte("---\nname: root\n---\n"), 0644)
	childDir := filepath.Join(s.root, "background")
	os.MkdirAll(childDir, 0755)
	os.WriteFile(filepath.Join(childDir, "background.md"), []byte("---\nname: bg\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("issues = %+v, want none", issues)
	}
}
