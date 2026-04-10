package felt

import (
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
