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
	if child.Status != felt.StatusOpen || b.Host != "other" || b.Agent != "codex-sol" || b.Role != "editor" || b.Surface != "app" {
		t.Fatalf("child/block = %+v %+v", child, b)
	}
}

func TestThreadRefusesBeforeWriting(t *testing.T) {
	t.Parallel()
	for _, flags := range [][]string{{"--host", "other"}, {"--agent", "not-an-agent"}, {"--slug", "../escape"}, {"--project-dir", "/does-not-exist"}} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			env := testEnv(t)
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
