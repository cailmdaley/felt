package feltcli

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// TestMoveFromLinkedRepositoryRewritesTheEnclosingStore reproduces a store
// whose repository holds the bytes and a larger store that links it in
// (`<loom>/.felt/pando` → `<pando>/.felt`). Run from inside the repository,
// rename and nest rewrite the larger store's links too when the checkout's
// felt.enclosing names it, and both stores check clean. A stale entry that
// mounts nothing is skipped. Without the config the repository is an ordinary top-level store and the larger store is left
// alone.
func TestMoveFromLinkedRepositoryRewritesTheEnclosingStore(t *testing.T) {
	t.Parallel()
	for _, configured := range []bool{true, false} {
		for _, verb := range []string{"rename", "nest"} {
			name := verb + map[bool]string{true: "/configured", false: "/unconfigured"}[configured]
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				// The larger store sits under HOME so the config can spell it with ~.
				loomDir, err := os.MkdirTemp(os.Getenv("HOME"), "loom-")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.RemoveAll(loomDir) })
				loom := felt.NewStorage(loomDir)
				if err := loom.Init(); err != nil {
					t.Fatal(err)
				}
				pandoDir, pando := newStore(t)
				if out, err := exec.Command("git", "-C", pandoDir, "init", "-q").CombinedOutput(); err != nil {
					t.Fatalf("git init: %v\n%s", err, out)
				}
				for _, id := range []string{"unions/clusters", "unions/clusters/child", "analysis"} {
					writeFixtureFelt(t, pando, id, id)
				}
				if err := pando.Write(&felt.Felt{ID: "unions/ref", Name: "Ref", Body: "[[unions/clusters]] [[unions/clusters/child]]"}); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(pando.Root(), filepath.Join(loom.Root(), "pando")); err != nil {
					t.Fatal(err)
				}
				if err := loom.Write(&felt.Felt{ID: "outside", Name: "Outside", Body: "[[pando/unions/clusters]] [[pando/unions/clusters/child]]"}); err != nil {
					t.Fatal(err)
				}
				if configured {
					_, stale := newStore(t)
					for _, value := range []string{filepath.Dir(stale.Root()), "~/" + filepath.Base(loomDir)} {
						if out, err := exec.Command("git", "-C", pandoDir, "config", "--add", felt.EnclosingConfigKey, value).CombinedOutput(); err != nil {
							t.Fatalf("git config: %v\n%s", err, out)
						}
					}
				}
				loomBefore := storeBytes(t, loom.Root())

				args, moved := []string{"rename", "unions/clusters", "compute-clusters"}, "unions/compute-clusters"
				if verb == "nest" {
					args, moved = []string{"nest", "unions/clusters", "analysis"}, "analysis/clusters"
				}
				stdout, stderr, err := executeCLI(t, pandoDir, args...)
				if err != nil {
					t.Fatalf("%v\n%s%s", err, stdout, stderr)
				}

				if got, want := mustRead(t, pando, "unions/ref").Body, "[["+moved+"]] [["+moved+"/child]]"; got != want {
					t.Fatalf("linked repository: %q, want %q", got, want)
				}
				mustRead(t, pando, moved+"/child")
				if out, err := runCommand(t, pandoDir, "check"); err != nil || strings.Contains(out, "WARNING") {
					t.Fatalf("check in the linked repository: %v\n%s", err, out)
				}

				outside := mustRead(t, loom, "outside").Body
				if !configured {
					if !reflect.DeepEqual(storeBytes(t, loom.Root()), loomBefore) {
						t.Fatalf("an unconfigured move reached the enclosing store: %q", outside)
					}
					if strings.Contains(stdout, "(in ") {
						t.Fatalf("unconfigured output names an enclosing store:\n%s%s", stdout, stderr)
					}
					return
				}
				if want := "[[pando/" + moved + "]] [[pando/" + moved + "/child]]"; outside != want {
					t.Fatalf("enclosing store: %q, want %q", outside, want)
				}
				if !strings.Contains(stdout, "Rewrote references in outside") {
					t.Fatalf("the enclosing store's rewrite is not reported:\n%s", stdout)
				}
				if out, err := runCommand(t, loomDir, "check"); err != nil || strings.Contains(out, "WARNING") {
					t.Fatalf("check in the enclosing store: %v\n%s", err, out)
				}
			})
		}
	}
}
