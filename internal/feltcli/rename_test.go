package feltcli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func storeBytes(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, p)
			result[rel] = string(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRenameRefusalsChangeNothing(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, id, slug, want string }{
		{"existing", "a/x", "taken", "already exists"},
		{"same", "a/x", "x", "already exists"},
		{"ambiguous", "x", "new", "ambiguous"},
		{"guessed", "wrong/unique", "new", "a/unique"},
		{"prefix", "a/uni", "new", "a/unique"},
		{"slash", "a/x", "other/new", "single"},
		{"empty", "a/x", "", "single"},
		{"dot", "a/x", "..", "single"},
		{"companion", "a/x", "companion", "companion"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dir, s := newStore(t)
			for _, id := range []string{"a/x", "b/x", "a/taken", "a/unique"} {
				writeFixtureFelt(t, s, id, id)
			}
			if err := os.WriteFile(filepath.Join(s.Root(), "a/x/companion.md"), []byte("artifact"), 0644); err != nil {
				t.Fatal(err)
			}
			before := storeBytes(t, s.Root())
			out, err := runCommand(t, dir, "rename", tc.id, tc.slug)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%v\n%s, want %s", err, out, tc.want)
			}
			if !reflect.DeepEqual(before, storeBytes(t, s.Root())) {
				t.Fatal("refusal changed store")
			}
		})
	}
}

func TestRenameCarriesDocumentDescendantsAndAllReferenceForms(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	for _, id := range []string{"a", "a/x", "a/x/child", "a/citer", "elsewhere"} {
		writeFixtureFelt(t, s, id, id)
	}
	f := mustRead(t, s, "a/x")
	f.UID = felt.NewULID()
	f.Body = "Self [[a/x]], child [[a/x/child]], relative [[child]].\n\n## Section\n"
	if err := f.SetExtraField("outputs", []map[string]any{{"id": "catalog"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	uid := f.UID
	f = mustRead(t, s, "a/citer")
	f.Body = "Full [[a/x#catalog|label]], relative [[x]], markdown [X](a/x#catalog), short [X](x), descendant [[x/child]]. Code `a/x` and `[[a/x]]`. Prose a/x."
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	writeConsumer(t, s, "elsewhere", "a/x.catalog")
	if err := os.WriteFile(filepath.Join(s.Root(), "a/x/plot.png"), []byte("plot"), 0644); err != nil {
		t.Fatal(err)
	}
	out, err := runCommand(t, dir, "rename", "a/x", "renamed")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, want := range []string{"Renamed a/x to a/renamed", "Rewrote references in a/citer", "Rewrote references in elsewhere", "Old path remains in a/citer"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "a/x")); !os.IsNotExist(err) {
		t.Fatalf("old directory remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "a/renamed/x.md")); !os.IsNotExist(err) {
		t.Fatalf("old document remains: %v", err)
	}
	if got := mustRead(t, s, "a/renamed"); got.UID != uid || got.Body != "Self [[a/renamed]], child [[a/renamed/child]], relative [[child]].\n\n## Section" {
		t.Fatalf("moved fiber: %+v", got)
	}
	mustRead(t, s, "a/renamed/child")
	if got := mustRead(t, s, "a/citer").Body; got != "Full [[a/renamed#catalog|label]], relative [[renamed]], markdown [X](a/renamed#catalog), short [X](renamed), descendant [[renamed/child]]. Code `a/x` and `[[a/x]]`. Prose a/x." {
		t.Fatal(got)
	}
	if got := inputFroms(t, s, "elsewhere"); !reflect.DeepEqual(got, []string{"a/renamed.catalog", "a/renamed.catalog"}) {
		t.Fatal(got)
	}
	if b, err := os.ReadFile(filepath.Join(s.Root(), "a/renamed/plot.png")); err != nil || string(b) != "plot" {
		t.Fatalf("artifact: %s %v", b, err)
	}
	if out, err := runCommand(t, dir, "check"); err != nil || strings.Contains(out, "WARNING") {
		t.Fatalf("check: %v\n%s", err, out)
	}
}

func TestRenameRetriesAndRecoversLeafChange(t *testing.T) {
	t.Parallel()
	for _, endpoint := range []string{"a/x", "a/new", "recover-move"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Parallel()
			dir, s := newStore(t)
			writeFixtureFelt(t, s, "a/x", "X")
			if err := s.Write(&felt.Felt{ID: "ref", Name: "Ref", Body: "[[a/x]] and `a/x`"}); err != nil {
				t.Fatal(err)
			}
			mend := breakFiberLock(t, s, "ref")
			if _, err := runCommand(t, dir, "rename", "a/x", "new"); err == nil {
				t.Fatal("expected interruption")
			}
			mustRead(t, s, "a/new")
			mend()
			args := []string{"rename", endpoint, "new"}
			if endpoint == "recover-move" {
				args = []string{endpoint}
			}
			out, err := runCommand(t, dir, args...)
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if got := mustRead(t, s, "ref").Body; got != "[[a/new]] and `a/x`" {
				t.Fatal(got)
			}
			if endpoint != "recover-move" && !strings.Contains(out, "Old path remains in ref") {
				t.Fatal(out)
			}
		})
	}
}

func TestRenameInsideLinkedRepositoryAndView(t *testing.T) {
	t.Parallel()
	for _, fromView := range []bool{false, true} {
		t.Run(map[bool]string{false: "store", true: "view"}[fromView], func(t *testing.T) {
			t.Parallel()
			outerDir, outer := newStore(t)
			_, linked := newStore(t)
			for _, id := range []string{"unions/clusters", "unions/clusters/child", "unions/ref"} {
				writeFixtureFelt(t, linked, id, id)
			}
			f := mustRead(t, linked, "unions/ref")
			f.Body = "[[unions/clusters]] [[clusters]] [[pando/unions/clusters/child]] `unions/clusters`"
			if err := linked.Write(f); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(linked.Root(), filepath.Join(outer.Root(), "pando")); err != nil {
				t.Fatal(err)
			}
			if err := outer.Write(&felt.Felt{ID: "outside", Name: "Outside", Body: "[[pando/unions/clusters]] `pando/unions/clusters`"}); err != nil {
				t.Fatal(err)
			}
			dir, id := outerDir, "pando/unions/clusters"
			if fromView {
				dir = t.TempDir()
				if err := os.Symlink(filepath.Join(outer.Root(), "pando/unions"), filepath.Join(dir, ".felt")); err != nil {
					t.Fatal(err)
				}
				id = "clusters"
			}
			out, err := runCommand(t, dir, "rename", id, "compute-clusters")
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if got := mustRead(t, linked, "unions/ref").Body; got != "[[unions/compute-clusters]] [[compute-clusters]] [[pando/unions/compute-clusters/child]] `unions/clusters`" {
				t.Fatal(got)
			}
			if got := mustRead(t, outer, "outside").Body; got != "[[pando/unions/compute-clusters]] `pando/unions/clusters`" {
				t.Fatal(got)
			}
			for _, name := range []string{"pando/unions/ref", "outside"} {
				if !strings.Contains(out, "Rewrote references in "+name) || !strings.Contains(out, "Old path remains in "+name) {
					t.Fatalf("missing %s: %s", name, out)
				}
			}
			mustRead(t, linked, "unions/compute-clusters/child")
			if out, err := runCommand(t, outerDir, "check"); err != nil || strings.Contains(out, "WARNING") {
				t.Fatalf("check: %v\n%s", err, out)
			}
		})
	}
}
