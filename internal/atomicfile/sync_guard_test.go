package atomicfile

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// TestEveryFsyncGoesThroughSync fails on a .Sync() call in production code
// outside this package, which FELT_TEST_FSYNC=0 could not turn off.
func TestEveryFsyncGoesThroughSync(t *testing.T) {
	t.Parallel()
	fset := token.NewFileSet()
	for _, root := range []string{"..", "../../cmd"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "testdata" || d.Name() == "atomicfile" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			ast.Inspect(file, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok && len(call.Args) == 0 {
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Sync" {
						t.Errorf("%s: fsync with atomicfile.Sync or atomicfile.SyncDir", fset.Position(call.Pos()))
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
