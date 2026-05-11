package cmd

import "testing"

func TestTreeDisplayID(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want string
	}{
		{
			name: "short id unchanged",
			id:   "science/cmbx",
			want: "science/cmbx",
		},
		{
			name: "deep id with short leaf shows leaf",
			id:   "ai-futures/application/interview",
			want: ".../interview",
		},
		{
			name: "deep id with long leaf keeps full leaf",
			id:   "ai-futures/application/cnrs-ai-rising-talents-interview-prep",
			want: ".../cnrs-ai-rising-talents-interview-prep",
		},
		{
			name: "long top-level id unchanged",
			id:   "anthropic-stem-fellowship",
			want: "anthropic-stem-fellowship",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := treeDisplayID(tt.id); got != tt.want {
				t.Fatalf("treeDisplayID(%q) = %q, want %q", tt.id, got, tt.want)
			}
		})
	}
}
