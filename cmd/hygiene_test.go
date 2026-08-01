package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The maintainer's own machines and account names once appeared throughout
// config/, lib/, and cmd/ — a hardcoded fleet, a hostname gate, a launchd label
// prefix, and a long tail of comments that named specific clusters. All of it is
// now operator data in ~/.config/felt/remotes.json, or generic prose.
//
// This test is what keeps it that way. A comment is the easiest place for a
// personal identifier to creep back in, and a comment is exactly where nobody
// looks. Test files are exempt: a fixture may legitimately name a host.
//
// Adding a fleet member? It goes in the fleet file, not here.
var personalIdentifiers = regexp.MustCompile(`(?i)candide|cineca|amundsen|nibi|dapmcw68|cailmdaley|cd280747|\bcail\b|/Users/`)

// allowedIdentifierContexts are the repo's own identity, which is not personal
// data to scrub — the Go module path, the plugin marketplace slug, and the
// GitHub release URLs all necessarily carry the repository owner.
var allowedIdentifierContexts = []string{
	"github.com/cailmdaley/felt",
	"api.github.com/repos/cailmdaley/felt",
	"cailmdaley/felt",
	"cailmdaley-felt",
	"cailmdaley/tap",
	"cailmdaley.github.io",
	// CONTRIBUTING.md documents the no-personal-paths rule with the pattern
	// itself; a comment may likewise explain the platform home-dir shapes.
	"`/Users/...`",
	"`/Users/<name>`",
}

// allowedFiles are tracked files whose whole point is to carry example content.
var allowedFiles = map[string]bool{
	"share/agents.example.json": true,
}

func TestNoPersonalIdentifiersInSource(t *testing.T) {
	root := repoRoot(t)

	// `--others --exclude-standard` alongside the tracked set: a brand-new file
	// is exactly where a hardcoded host is most likely to appear, and it would
	// be invisible to a tracked-only listing until after the commit that
	// introduced it. Ignored files stay out.
	out, err := exec.Command("git", "-C", root, "ls-files",
		"--cached", "--others", "--exclude-standard").Output()
	if err != nil {
		t.Skipf("git ls-files unavailable: %v", err)
	}

	var offenders []string
	for _, rel := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if rel == "" || allowedFiles[rel] || !scannedPath(rel) {
			continue
		}
		base := filepath.Base(rel)
		if strings.HasSuffix(base, "_test.go") || strings.HasSuffix(base, "_test.exs") {
			continue
		}
		// testdata/ is Go's canonical fixture directory — test material by
		// definition.
		if strings.Contains(filepath.ToSlash(rel), "/testdata/") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			continue
		}
		for i, line := range strings.Split(string(body), "\n") {
			if !personalIdentifiers.MatchString(line) {
				continue
			}
			if allowedContext(line) {
				continue
			}
			offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
		}
	}

	if len(offenders) > 0 {
		t.Fatalf("personal identifiers in tracked source (put fleet data in ~/.config/felt/remotes.json, keep prose generic):\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

// scannedPath reports whether a repo-relative path is in the hygiene-scanned
// set: the source trees, the shipped scripts and UI, every Markdown file
// anywhere (docs and skills are published content), and the two root files a
// fresh installer runs first. CONTRIBUTING.md promises "no personal paths" for
// all of these; this is the machine check behind that promise.
func scannedPath(rel string) bool {
	rel = filepath.ToSlash(rel)
	if strings.HasSuffix(rel, ".md") {
		return true
	}
	if rel == "Makefile" || rel == "bootstrap.sh" {
		return true
	}
	for _, dir := range []string{"config/", "lib/", "cmd/", "share/", "ui/", "bin/"} {
		if strings.HasPrefix(rel, dir) {
			return true
		}
	}
	return false
}

// allowedContext reports whether every match on the line sits inside one of the
// repo-identity strings. Stripping them first means a line may mention the
// module path AND still be caught for naming a host.
func allowedContext(line string) bool {
	stripped := line
	for _, allowed := range allowedIdentifierContexts {
		stripped = strings.ReplaceAll(stripped, allowed, "")
	}
	return !personalIdentifiers.MatchString(stripped)
}
