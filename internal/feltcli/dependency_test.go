package feltcli

import (
	"go/build"
	"path/filepath"
	"strings"
	"testing"
)

// The felt binary's in-module import graph, read from source with go/build
// for this platform's build constraints. Reading source keeps the go command,
// and with it a build and module cache, out of the test.
func TestFeltBinaryHasNoShuttleOrMessagingDependencies(t *testing.T) {
	t.Parallel()
	const module = "github.com/cailmdaley/felt"
	root := repoRoot(t)
	seen := map[string]bool{}
	var visit func(path string)
	visit = func(path string) {
		if seen[path] {
			return
		}
		seen[path] = true
		pkg, err := build.Default.ImportDir(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path, module))), 0)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		for _, imported := range pkg.Imports {
			if imported == module || strings.HasPrefix(imported, module+"/") {
				visit(imported)
			}
		}
	}
	visit(module + "/cmd/felt")
	if !seen[module+"/internal/felt"] {
		t.Fatalf("import walk missed internal/felt: %v", seen)
	}
	for _, forbidden := range []string{"/internal/shuttle", "/internal/messaging", "/internal/shuttlecli"} {
		if seen[module+forbidden] {
			t.Errorf("Felt binary depends on %q", module+forbidden)
		}
	}
}
