package cmd

import (
	"testing"
)

func TestExtractLede(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "title heading then section",
			body: "# My Fiber\n\n## Motivation\n\nThis is the first paragraph.\n\nMore content here.",
			want: "## Motivation\nThis is the first paragraph.",
		},
		{
			name: "section heading directly",
			body: "## Context\n\nWe need to decide about X.\n\n## Options\n\nOption A...",
			want: "## Context\nWe need to decide about X.",
		},
		{
			name: "plain text body",
			body: "This fiber tracks the decision.\n\nMore details follow.",
			want: "This fiber tracks the decision.",
		},
		{
			name: "empty body",
			body: "",
			want: "",
		},
		{
			name: "only heading",
			body: "# Just a heading",
			want: "",
		},
		{
			name: "heading with content no blank line",
			body: "## Section\nContent directly after heading.\n\nMore stuff.",
			want: "## Section\nContent directly after heading.",
		},
		{
			name: "leading blank lines",
			body: "\n\n## Section\n\nContent.\n\nMore.",
			want: "## Section\nContent.",
		},
		{
			name: "multi-line paragraph",
			body: "## Overview\n\nLine one of the paragraph.\nLine two continues.\nLine three.\n\nNext section.",
			want: "## Overview\nLine one of the paragraph.\nLine two continues.\nLine three.",
		},
		{
			name: "whitespace only body",
			body: "   \n  \n   ",
			want: "",
		},
		{
			name: "title heading then plain text (no section heading)",
			body: "# My Fiber\n\nJust a plain paragraph.",
			want: "Just a plain paragraph.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractLede(tt.body)
			if got != tt.want {
				t.Errorf("extractLede() =\n%q\nwant:\n%q", got, tt.want)
			}
		})
	}
}

func TestValidateDepth(t *testing.T) {
	for _, d := range ValidDepths {
		if err := validateDepth(d); err != nil {
			t.Errorf("validateDepth(%q) returned error: %v", d, err)
		}
	}
	if err := validateDepth("bogus"); err == nil {
		t.Error("validateDepth(\"bogus\") should return error")
	}
}
