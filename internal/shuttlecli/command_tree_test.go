//go:build !integration

package shuttlecli

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestEveryCommandConstructorIsWired fails when a method that builds a
// command is never called from production code, so a verb cannot drop out
// of the tree while its constructor still compiles.
func TestEveryCommandConstructorIsWired(t *testing.T) {
	t.Parallel()
	if unwired := unwiredCommandConstructors(t, "."); len(unwired) > 0 {
		t.Fatalf("command constructors nothing calls: %s", strings.Join(unwired, ", "))
	}
}

func unwiredCommandConstructors(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	constructors := map[string]bool{}
	called := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.FuncDecl:
				if n.Recv != nil && n.Type.Params.NumFields() == 0 && n.Type.Results.NumFields() == 1 {
					if star, ok := n.Type.Results.List[0].Type.(*ast.StarExpr); ok {
						if sel, ok := star.X.(*ast.SelectorExpr); ok && sel.Sel.Name == "Command" {
							constructors[n.Name.Name] = true
						}
					}
				}
			case *ast.SelectorExpr:
				called[n.Sel.Name] = true
			}
			return true
		})
	}
	var unwired []string
	for name := range constructors {
		if !called[name] {
			unwired = append(unwired, name)
		}
	}
	sort.Strings(unwired)
	return unwired
}
