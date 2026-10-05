package sysenv

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// processReads are the package-level identifiers that read or write the live
// process: its environment, home and working directory, executable lookup and
// child-process environment, and standard streams. Production code under
// internal/ reaches them only through an *Env, so a command can run against
// an isolated environment and tests can run in parallel.
var processReads = map[string][]string{
	"os":      {"Getenv", "LookupEnv", "Environ", "UserHomeDir", "Getwd", "Stdin", "Stdout", "Stderr"},
	"os/exec": {"LookPath", "Command", "CommandContext"},
	"fmt":     {"Print", "Printf", "Println"},
}

// processReadAllowlist names each production use outside this package that
// reads the live process on purpose, keyed "file func ident" (file relative to
// internal/, func the enclosing function or method, "-" at package level).
var processReadAllowlist = map[string]string{
	"felt/storage.go Storage.BackfillIntrinsicIDs os.Stderr":                "a store walk's warning about a file it could not backfill is a diagnostic on the process stderr, never command output",
	"felt/storage.go Storage.listWithModeHavingFrontmatterFields os.Stderr": "a store walk's warnings about unparseable or unhydrated files are diagnostics on the process stderr, never command output",
}

// TestProductionReadsTheProcessOnlyThroughEnv fails when non-test code under
// internal/ reads the process surface directly instead of through an Env.
func TestProductionReadsTheProcessOnlyThroughEnv(t *testing.T) {
	t.Parallel()
	violations, used := scanProcessReads(t, "..")
	for key := range processReadAllowlist {
		if !used[key] {
			t.Errorf("allowlist entry %q matches nothing; remove it", key)
		}
	}
	for _, v := range violations {
		t.Errorf("%s reads the process directly; go through the invocation's *sysenv.Env (or allowlist %q with a reason)", v.pos, v.key)
	}
}

type processRead struct{ pos, key string }

func scanProcessReads(t *testing.T, internalDir string) ([]processRead, map[string]bool) {
	t.Helper()
	var violations []processRead
	used := map[string]bool{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(internalDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(internalDir, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel == "sysenv" || d.Name() == "testdata" {
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
		names := map[string]map[string]bool{} // local import name → guarded identifiers
		for _, spec := range file.Imports {
			importPath, _ := strconv.Unquote(spec.Path.Value)
			idents, ok := processReads[importPath]
			if !ok {
				continue
			}
			name := filepath.Base(importPath)
			if spec.Name != nil {
				name = spec.Name.Name
			}
			set := map[string]bool{}
			for _, ident := range idents {
				set[ident] = true
			}
			names[name] = set
		}
		if len(names) == 0 {
			return nil
		}
		check := func(fn string, node ast.Node) {
			ast.Inspect(node, func(n ast.Node) bool {
				sel, ok := n.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				pkg, ok := sel.X.(*ast.Ident)
				if !ok || !names[pkg.Name][sel.Sel.Name] {
					return true
				}
				key := rel + " " + fn + " " + pkg.Name + "." + sel.Sel.Name
				if _, allowed := processReadAllowlist[key]; allowed {
					used[key] = true
					return true
				}
				violations = append(violations, processRead{pos: fset.Position(sel.Pos()).String(), key: key})
				return true
			})
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				check("-", decl)
				continue
			}
			name := fn.Name.Name
			if fn.Recv != nil && len(fn.Recv.List) == 1 {
				name = receiverName(fn.Recv.List[0].Type) + "." + name
			}
			check(name, fn)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(violations, func(i, j int) bool { return violations[i].pos < violations[j].pos })
	return violations, used
}

func receiverName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.StarExpr:
		return receiverName(e.X)
	case *ast.IndexExpr:
		return receiverName(e.X)
	case *ast.Ident:
		return e.Name
	}
	return "?"
}
