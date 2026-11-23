package felt

import (
	"os"
	"path/filepath"
	"testing"
)

// A repository's own store, which a larger store links in, is a view of that
// store when felt.enclosing names it: every configured value is tried, one
// that mounts nothing is skipped, and the mount's position is the prefix.
func TestConfiguredEnclosingStore(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	newStore := func(name string) *Storage {
		s := NewStorage(filepath.Join(tmp, name))
		if err := s.Init(); err != nil {
			t.Fatal(err)
		}
		if err := s.Write(&Felt{ID: "seed", Name: "Seed"}); err != nil {
			t.Fatal(err)
		}
		return s
	}
	outer, stale, linked := newStore("outer"), newStore("stale"), newStore("linked")
	gitIn(t, filepath.Dir(linked.Root()), "init", "-q")

	if _, _, ok := NewStorage(filepath.Dir(linked.Root())).EnclosingStore(); ok {
		t.Fatal("an unconfigured repository has no enclosing store")
	}

	if err := os.MkdirAll(filepath.Join(outer.Root(), "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linked.Root(), filepath.Join(outer.Root(), "projects", "linked")); err != nil {
		t.Fatal(err)
	}
	gitIn(t, filepath.Dir(linked.Root()), "config", "--add", EnclosingConfigKey, filepath.Dir(stale.Root()))
	gitIn(t, filepath.Dir(linked.Root()), "config", "--add", EnclosingConfigKey, outer.Root())

	root, prefix, ok := NewStorage(filepath.Dir(linked.Root())).EnclosingStore()
	want, _ := filepath.EvalSymlinks(outer.Root())
	if !ok || root != want || prefix != "projects/linked" {
		t.Fatalf("EnclosingStore = %q %q %v, want %q projects/linked", root, prefix, ok, want)
	}
	// The enclosing store does not count itself as mounted by its own config.
	gitIn(t, filepath.Dir(linked.Root()), "config", "--unset-all", EnclosingConfigKey)
	gitIn(t, filepath.Dir(linked.Root()), "config", EnclosingConfigKey, filepath.Dir(linked.Root()))
	if _, _, ok := NewStorage(filepath.Dir(linked.Root())).EnclosingStore(); ok {
		t.Fatal("a store is not its own enclosing store")
	}
}
