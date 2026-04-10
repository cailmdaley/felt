package felt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckDecisionWithoutOptions(t *testing.T) {
	issues := Check([]*Felt{{
		ID: "fiber-a",
		Decisions: map[string]ASTRADecision{
			"choice": {Label: "Choice"},
		},
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Level != CheckLevelError {
		t.Fatalf("issue level = %q, want %q", issues[0].Level, CheckLevelError)
	}
	if issues[0].Path != "decisions.choice" {
		t.Fatalf("issue path = %q, want decisions.choice", issues[0].Path)
	}
}

func TestCheckClosedFiberRequiresSelectedDecision(t *testing.T) {
	issues := Check([]*Felt{{
		ID:     "fiber-a",
		Status: StatusClosed,
		Decisions: map[string]ASTRADecision{
			"choice": {
				Label: "Choice",
				Options: map[string]ASTRADecisionOption{
					"a": {Label: "Option A"},
				},
			},
		},
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if !strings.Contains(issues[0].Message, "no selected option") {
		t.Fatalf("issue message = %q, want selected-option failure", issues[0].Message)
	}
}

func TestCheckEvidenceStub(t *testing.T) {
	issues := Check([]*Felt{{
		ID: "fiber-a",
		Insights: map[string]ASTRAInsight{
			"claim": {
				Evidence: []ASTRAEvidence{
					{ID: "stub"},
				},
			},
		},
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "insights.claim.evidence[0]" {
		t.Fatalf("issue path = %q, want insights.claim.evidence[0]", issues[0].Path)
	}
}

func TestCheckInsightWithoutEvidenceWarns(t *testing.T) {
	issues := Check([]*Felt{{
		ID: "fiber-a",
		Insights: map[string]ASTRAInsight{
			"claim": {Claim: "Something happened"},
		},
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Level != CheckLevelWarn {
		t.Fatalf("issue level = %q, want %q", issues[0].Level, CheckLevelWarn)
	}
	if issues[0].Path != "insights.claim" {
		t.Fatalf("issue path = %q, want insights.claim", issues[0].Path)
	}
}

func TestCheckBrokenBodyReference(t *testing.T) {
	issues := Check([]*Felt{{
		ID:   "fiber-a",
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

func TestCheckBrokenBodyReferenceFragment(t *testing.T) {
	issues := Check([]*Felt{
		{
			ID:   "fiber-a",
			Body: "See [[fiber-b#missing-element]].",
		},
		{
			ID: "fiber-b",
			Decisions: map[string]ASTRADecision{
				"choice": {
					Label: "Choice",
					Options: map[string]ASTRADecisionOption{
						"keep": {Label: "Keep"},
					},
				},
			},
		},
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
	issues := Check([]*Felt{{
		ID: "fiber-a",
		Inputs: []ASTRAInput{
			{ID: "catalog", From: "missing.output"},
		},
	}})

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
	issues := Check([]*Felt{
		{
			ID: "fiber-a",
			Inputs: []ASTRAInput{
				{ID: "catalog", From: "fiber-b.missing-output"},
			},
		},
		{
			ID:      "fiber-b",
			Outputs: []ASTRAOutput{{ID: "present-output"}},
		},
	})

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

func TestCheckDecisionWithAllOptionsExcludedWarns(t *testing.T) {
	issues := Check([]*Felt{{
		ID: "fiber-a",
		Decisions: map[string]ASTRADecision{
			"choice": {
				Options: map[string]ASTRADecisionOption{
					"a": {Label: "Option A", Excluded: true, ExcludedReason: "bad"},
				},
			},
		},
	}})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Level != CheckLevelWarn {
		t.Fatalf("issue level = %q, want %q", issues[0].Level, CheckLevelWarn)
	}
	if !strings.Contains(issues[0].Message, "no remaining unexcluded options") {
		t.Fatalf("issue message = %q, want dead-end decision warning", issues[0].Message)
	}
}

func TestCheckSiblingDepthConsistencyWarning(t *testing.T) {
	issues := Check([]*Felt{
		{
			ID: "parent/fully-formed",
			Decisions: map[string]ASTRADecision{
				"choice": {
					Options: map[string]ASTRADecisionOption{
						"a": {Label: "Option A"},
						"b": {Label: "Option B", Excluded: true, ExcludedReason: "too costly"},
					},
					Default: "a",
				},
			},
		},
		{
			ID: "parent/lightweight",
			Inputs: []ASTRAInput{
				{ID: "catalog"},
			},
		},
	})

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Level != CheckLevelWarn {
		t.Fatalf("issue level = %q, want %q", issues[0].Level, CheckLevelWarn)
	}
	if issues[0].FiberID != "parent" {
		t.Fatalf("issue fiber = %q, want parent", issues[0].FiberID)
	}
}

func TestCheckLegacyFormatReportsTitleAndMystAnchor(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	content := `---
title: Legacy Fiber
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
	if len(issues) != 2 {
		t.Fatalf("CheckLegacyFormat() produced %d issues, want 2", len(issues))
	}
	if issues[0].Path != "body" && issues[1].Path != "body" {
		t.Fatalf("issues = %#v, want body issue", issues)
	}
	if issues[0].Path != "frontmatter" && issues[1].Path != "frontmatter" {
		t.Fatalf("issues = %#v, want frontmatter issue", issues)
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
