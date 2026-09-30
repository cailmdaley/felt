package felt

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProjectRootAndRequireStore(t *testing.T) {
	dir, storage := newStore(t)

	root, err := ProjectRoot(dir)
	if err != nil || root != dir {
		t.Fatalf("ProjectRoot(%q) = %q, %v; want %q", dir, root, err, dir)
	}
	gotStorage, gotRoot, err := RequireStore(dir)
	if err != nil {
		t.Fatalf("RequireStore(%q): %v", dir, err)
	}
	if gotRoot != dir || gotStorage.Root() != storage.Root() {
		t.Fatalf("RequireStore(%q) = (%q, %q), want project %q and store %q", dir, gotRoot, gotStorage.Root(), dir, storage.Root())
	}

	missing := filepath.Join(t.TempDir(), "missing")
	if _, err := ProjectRoot(missing); err == nil {
		t.Fatalf("ProjectRoot(%q) succeeded without a .felt directory", missing)
	}
	if _, _, err := RequireStore(missing); err == nil || err.Error() != "not in a felt repository" {
		t.Fatalf("RequireStore(%q) error = %v, want not-in-repository error", missing, err)
	}
}

func TestCommandScopeFindsNearestFiberFromExplicitDirectory(t *testing.T) {
	dir, storage := newStore(t)
	for _, id := range []string{"analysis", "analysis/jackknife"} {
		if err := storage.Write(&Felt{ID: id, Name: id, CreatedAt: time.Now()}); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
	}
	start := filepath.Join(storage.Root(), "analysis", "jackknife", "scripts")
	if err := os.MkdirAll(start, 0755); err != nil {
		t.Fatalf("mkdir start directory: %v", err)
	}

	if got := CommandScope(dir, start); got != "analysis/jackknife" {
		t.Fatalf("CommandScope(%q, %q) = %q, want nearest fiber", dir, start, got)
	}
	if got := CommandScope(dir, t.TempDir()); got != "" {
		t.Fatalf("CommandScope outside the store = %q, want empty scope", got)
	}
}

func TestResolveRefAcrossView(t *testing.T) {
	_, outer := newStore(t)
	outerRoot, err := filepath.EvalSymlinks(outer.Root())
	if err != nil {
		t.Fatalf("resolve outer root: %v", err)
	}
	uid := "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	for _, f := range []*Felt{
		{ID: "ai-futures/portolan/debug", UID: uid, Name: "Portolan debug", CreatedAt: time.Now()},
		{ID: "ai-futures/portolan/charted", Name: "Charted", CreatedAt: time.Now()},
		{ID: "commons", Name: "Commons", CreatedAt: time.Now()},
	} {
		if err := outer.Write(f); err != nil {
			t.Fatalf("write outer fiber %s: %v", f.ID, err)
		}
	}

	content := filepath.Join(outer.Root(), "ai-futures", "felt")
	if err := os.MkdirAll(content, 0755); err != nil {
		t.Fatalf("mkdir view content: %v", err)
	}
	project := t.TempDir()
	if err := os.Symlink(content, filepath.Join(project, DirName)); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	view := NewStorage(project)
	if err := view.Write(&Felt{ID: "debug", Name: "Local debug", CreatedAt: time.Now()}); err != nil {
		t.Fatalf("write local fiber: %v", err)
	}

	for _, query := range []string{"ai-futures/portolan/debug", uid} {
		ref, err := ResolveRef(view, "", query)
		if err != nil {
			t.Fatalf("ResolveRef(%q): %v", query, err)
		}
		if ref.Storage.Root() != outerRoot || ref.ID != "ai-futures/portolan/debug" || !ref.Elsewhere {
			t.Fatalf("ResolveRef(%q) = {root:%q id:%q elsewhere:%v}, want {root:%q id:%q elsewhere:true}", query, ref.Storage.Root(), ref.ID, ref.Elsewhere, outerRoot, "ai-futures/portolan/debug")
		}
		if got, want := ref.Location(), " (in "+outerRoot+")"; got != want {
			t.Fatalf("Location() = %q, want %q", got, want)
		}
	}

	local, err := ResolveRef(view, "", "debug")
	if err != nil {
		t.Fatalf("ResolveRef(local): %v", err)
	}
	if local.Storage.Root() != view.Root() || local.ID != "debug" || local.Elsewhere {
		t.Fatalf("local ref = %+v, want local debug fiber", local)
	}

	_, err = ResolveExactRef(view, "", "charted")
	var guess *GuessError
	if !errors.As(err, &guess) {
		t.Fatalf("ResolveExactRef(inferred external id) error = %v, want a guess refusal", err)
	}
}
