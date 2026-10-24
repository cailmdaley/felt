package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestThreadInheritanceAndOverrides(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedPlainFiber(t, st, "hub", "")
	pdir := t.TempDir()
	if out, err := runIn(t, env, dir, "install", "hub", "--host", "testhost", "--project-dir", pdir, "--model", "claude-opus"); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	parent := mustRead(t, st, "hub")
	block, _, _ := shuttle.BlockOf(parent)
	block.Role = "analyst"
	if err := shuttle.SetConfig(parent, block); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(parent); err != nil {
		t.Fatal(err)
	}
	out, err := runIn(t, env, dir, "thread", "hub", "Measure the covariance", "--json")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.ID != "hub/measure-the-covariance" {
		t.Fatalf("id = %q", result.ID)
	}
	child := mustRead(t, st, result.ID)
	b, _, _ := shuttle.BlockOf(child)
	if b.Host != "testhost" || b.ProjectDir != pdir || b.Role != "analyst" || b.Agent != "claude-opus" || b.Kind != "oneshot" {
		t.Fatalf("block = %+v", b)
	}
	if child.Status != felt.StatusActive || !child.HasTag("constitution") || child.Body != "Measure the covariance\n\n## Desired State\n\n## Status" {
		t.Fatalf("child = %+v", child)
	}
	out, err = runIn(t, env, dir, "thread", "hub", "Other ask", "--slug", "explicit", "--disabled", "--host", "other", "--project-dir", pdir, "--agent", "codex-sol", "--role", "editor")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if strings.TrimSpace(out) != "hub/explicit" {
		t.Fatal(out)
	}
	child = mustRead(t, st, "hub/explicit")
	b, _, _ = shuttle.BlockOf(child)
	if child.Status != felt.StatusOpen || b.Host != "other" || b.Agent != "codex-sol" || b.Role != "editor" || b.Surface != "cli" {
		t.Fatalf("child/block = %+v %+v", child, b)
	}
}

func TestThreadSurfaceInheritanceAndOverride(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, parentAgent, parentSurface, want string
		flags                                  []string
		invalid                                bool
	}{
		{name: "codex cli", parentAgent: "codex-sol", parentSurface: "cli", want: "cli"},
		{name: "codex absent means cli", parentAgent: "codex-sol", want: "cli"},
		{name: "explicit app", parentAgent: "codex-sol", parentSurface: "cli", flags: []string{"--surface", "app"}, want: "app"},
		{name: "inherited app", parentAgent: "codex-sol", parentSurface: "app", want: "app"},
		{name: "app to claude uses cli", parentAgent: "codex-sol", parentSurface: "app", flags: []string{"--agent", "claude-opus"}, want: "cli"},
		{name: "claude to codex retains cli", parentAgent: "claude-opus", flags: []string{"--agent", "codex-sol"}, want: "cli"},
		{name: "explicit cli", parentAgent: "codex-sol", parentSurface: "app", flags: []string{"--surface", "cli"}, want: "cli"},
		{name: "incompatible override", parentAgent: "codex-sol", parentSurface: "app", flags: []string{"--agent", "claude-opus", "--surface", "app"}, invalid: true},
		{name: "invalid surface", parentAgent: "codex-sol", flags: []string{"--surface", "desktop"}, invalid: true},
		{name: "empty surface", parentAgent: "codex-sol", flags: []string{"--surface", ""}, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			seedPlainFiber(t, st, "hub", "")
			f := mustRead(t, st, "hub")
			if err := shuttle.SetConfig(f, &shuttle.Block{Kind: "oneshot", Host: "testhost", ProjectDir: t.TempDir(), Agent: tc.parentAgent, Surface: tc.parentSurface}); err != nil {
				t.Fatal(err)
			}
			if err := st.Write(f); err != nil {
				t.Fatal(err)
			}
			args := append([]string{"thread", "hub", "Ask"}, tc.flags...)
			out, err := runIn(t, env, dir, args...)
			if tc.invalid {
				if err == nil {
					t.Fatalf("accepted invalid selection: %s", out)
				}
				fs, listErr := st.ListMetadata()
				if listErr != nil || len(fs) != 1 {
					t.Fatalf("invalid flags wrote child: %v %v", fs, listErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			b, _, err := shuttle.BlockOf(mustRead(t, st, "hub/ask"))
			if err != nil {
				t.Fatal(err)
			}
			if b.Surface != tc.want {
				t.Fatalf("surface=%q, want %q", b.Surface, tc.want)
			}
		})
	}
}

func TestThreadRefusesBeforeWriting(t *testing.T) {
	t.Parallel()
	for _, flags := range [][]string{{"--host", "other"}, {"--agent", "not-an-agent"}, {"--slug", "../escape"}, {"--project-dir", "/does-not-exist"}} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			env := testEnv(t)
			ownHost(t, env, "testhost")
			dir, st := newStore(t)
			seedPlainFiber(t, st, "hub", "")
			if out, err := runIn(t, env, dir, "install", "hub", "--disabled", "--host", "testhost"); err != nil {
				t.Fatalf("%v %s", err, out)
			}
			args := append([]string{"thread", "hub", "Ask", "--disabled"}, flags...)
			if out, err := runIn(t, env, dir, args...); err == nil {
				t.Fatalf("accepted: %s", out)
			}
			fs, err := st.ListMetadata()
			if err != nil || len(fs) != 1 {
				t.Fatalf("partial creation: %v %v", fs, err)
			}
		})
	}
	env := testEnv(t)
	dir, st := newStore(t)
	seedPlainFiber(t, st, "note", "")
	if _, err := runIn(t, env, dir, "thread", "note", "Ask", "--disabled"); err == nil {
		t.Fatal("accepted non-constitution")
	}
	if _, err := runIn(t, env, dir, "install", "note", "--disabled", "--host", "testhost"); err != nil {
		t.Fatal(err)
	}
	if _, err := runIn(t, env, dir, "thread", "note", "Ask"); err == nil {
		t.Fatal("armed without cwd")
	}
	if _, err := runIn(t, env, dir, "thread", "note", "Ask", "--disabled"); err != nil {
		t.Fatal(err)
	}
	if _, err := runIn(t, env, dir, "thread", "note", "Ask", "--disabled"); err == nil {
		t.Fatal("overwrote child")
	}
}
