package shuttle

import (
	"path"
	"strings"
)

// ChangeRole classifies a changed file by its repository-relative path.
func ChangeRole(file string) string {
	p := strings.ToLower(strings.TrimPrefix(file, "./"))
	name := path.Base(p)
	if strings.HasSuffix(name, ".change.json") || name == "package-lock.json" || name == "go.sum" || strings.HasSuffix(name, ".lock") || name == "notice" || strings.Contains(name, "notices") || strings.Contains(name, "license") || strings.Contains(name, "licence") {
		return "generated"
	}
	parts := strings.Split(p, "/")
	for _, part := range parts[:len(parts)-1] {
		switch part {
		case "dist", "generated", "__generated__", "gen":
			return "generated"
		}
	}
	if strings.Contains(name, ".generated.") || strings.HasSuffix(name, ".pb.go") || strings.HasSuffix(name, "_generated.go") || strings.HasSuffix(name, ".min.js") || strings.HasSuffix(name, ".min.css") {
		return "generated"
	}
	for _, part := range parts[:len(parts)-1] {
		switch part {
		case "test", "tests", "__tests__", "spec", "e2e", "harness", "fixtures":
			return "test"
		}
	}
	if strings.HasPrefix(name, "test_") || strings.HasSuffix(name, "_test.go") || strings.HasSuffix(name, "_test.exs") || strings.Contains(name, ".test.") || strings.Contains(name, ".spec.") {
		return "test"
	}
	for _, part := range parts[:len(parts)-1] {
		if part == "docs" || part == "doc" {
			return "docs"
		}
	}
	if strings.HasSuffix(name, ".md") || strings.HasSuffix(name, ".rst") {
		return "docs"
	}
	for _, part := range parts[:len(parts)-1] {
		if part == "config" || part == ".github" {
			return "config"
		}
	}
	if name == "makefile" || strings.HasSuffix(name, ".toml") || strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml") {
		return "config"
	}
	return "implementation"
}
