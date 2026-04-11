//go:build integration

package cmd_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

var binaryPath string

func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "felt-integration-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tmp)

	binaryPath = filepath.Join(tmp, "felt")
	buildCmd := exec.Command("go", "build", "-o", binaryPath, ".")
	buildCmd.Dir = filepath.Join(filepath.Dir(tmp), "..", "..")
	// Walk up to find go.mod
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			buildCmd.Dir = dir
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	out, err := buildCmd.CombinedOutput()
	if err != nil {
		panic("build failed: " + string(out))
	}
	if err := os.Chmod(binaryPath, 0755); err != nil {
		panic("chmod failed: " + err.Error())
	}

	os.Exit(m.Run())
}

// felt runs the binary in dir with args, returns stdout+stderr.
func felt(dir string, args ...string) (string, error) {
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// mustFelt runs felt and fails the test on error.
func mustFelt(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := felt(dir, args...)
	if err != nil {
		t.Fatalf("felt %v failed: %v\n%s", args, err, out)
	}
	return out
}

func TestIntegration(t *testing.T) {
	dir := t.TempDir()

	// init
	mustFelt(t, dir, "init")
	if _, err := os.Stat(filepath.Join(dir, ".felt")); err != nil {
		t.Fatal("init: .felt directory not created")
	}
	if _, err := os.Stat(filepath.Join(dir, ".felt", "myst.yml")); err != nil {
		t.Fatal("init: myst.yml not created")
	}
	if err := os.Remove(filepath.Join(dir, ".felt", "myst.yml")); err != nil {
		t.Fatalf("init: remove myst.yml: %v", err)
	}
	out := mustFelt(t, dir, "init")
	if !strings.Contains(out, "Ensured .felt/ support files") {
		t.Fatalf("init: expected repair confirmation, got: %s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, ".felt", "myst.yml")); err != nil {
		t.Fatal("init: myst.yml not recreated")
	}

	// add — returns the fiber ID (positional arg is now the slug)
	fiberID := strings.TrimSpace(mustFelt(t, dir, "add", "test-fiber", "test fiber", "-s", "open"))
	if fiberID != "test-fiber" {
		t.Fatal("add: expected fiber ID in output")
	}

	// ls
	out = mustFelt(t, dir, "ls")
	if !strings.Contains(out, "test fiber") {
		t.Fatalf("ls: expected fiber in output, got: %s", out)
	}

	// show
	out = mustFelt(t, dir, "show", fiberID)
	if !strings.Contains(out, "test fiber") {
		t.Fatalf("show: expected fiber title, got: %s", out)
	}
	out = mustFelt(t, dir, "show", fiberID, "--body")
	if !strings.Contains(out, "Body start line: 6") {
		t.Fatalf("new fiber body should report the editable insertion point, got: %s", out)
	}

	// edit — mark active
	mustFelt(t, dir, "edit", fiberID, "-s", "active")
	out = mustFelt(t, dir, "show", fiberID, "-d", "compact")
	if !strings.Contains(out, "active") {
		t.Fatalf("edit: expected active status, got: %s", out)
	}

	// edit with no flags should fail (agent-first, non-interactive)
	out, err := felt(dir, "edit", fiberID)
	if err == nil {
		t.Fatal("edit without flags: expected error")
	}
	if !strings.Contains(out, "no changes requested") {
		t.Fatalf("edit without flags: expected helpful error, got: %s", out)
	}

	// initial body set on empty body should be a normal update (not overwrite warning)
	out = mustFelt(t, dir, "edit", fiberID, "--body", "initial body")
	if strings.Contains(out, "body overwritten") {
		t.Fatalf("edit --body first set: should not warn overwrite, got: %s", out)
	}

	// replacing non-empty body should be called out as overwrite
	out = mustFelt(t, dir, "edit", fiberID, "--body", "replacement body")
	if !strings.Contains(out, "body overwritten") {
		t.Fatalf("edit --body replace: expected overwrite message, got: %s", out)
	}
	out = mustFelt(t, dir, "show", fiberID, "--body")
	if !strings.Contains(out, "replacement body") {
		t.Fatalf("edit --body: expected replacement content, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "-e", "test fiber") // exact title match
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls --exact should match exact title from metadata, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "completed successfully")
	if strings.Contains(out, fiberID) {
		t.Fatalf("ls query should not match outcome before it exists, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "replacement")
	if strings.Contains(out, fiberID) {
		t.Fatalf("ls query without --body should not match body text, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "--body", "replacement")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls query with --body should match body text, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "--json", "--body")
	var listed []map[string]any
	if err := json.Unmarshal([]byte(out), &listed); err != nil {
		t.Fatalf("ls --json --body: invalid json: %v\n%s", err, out)
	}
	if len(listed) != 1 {
		t.Fatalf("ls --json --body: expected one fiber, got: %#v", listed)
	}
	body, _ := listed[0]["body"].(string)
	if body != "replacement body" {
		t.Fatalf("ls --json --body: expected hydrated body, got: %#v", listed)
	}

	// close with outcome
	mustFelt(t, dir, "edit", fiberID, "-s", "closed", "-o", "completed successfully")
	out = mustFelt(t, dir, "show", fiberID, "-d", "compact")
	if !strings.Contains(out, "completed successfully") {
		t.Fatalf("edit close: expected outcome, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "completed successfully")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls query should match outcome text from metadata, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "-r", "completed\\s+successfully")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls regex query should match outcome text from metadata, got: %s", out)
	}

	// add a second fiber
	fiber2ID := strings.TrimSpace(mustFelt(t, dir, "add", "second-fiber", "second fiber", "-s", "open"))
	if fiber2ID == "" {
		t.Fatal("add: expected fiber2 ID")
	}

	// tag and untag
	mustFelt(t, dir, "edit", fiber2ID, "--tag", "testlabel")
	out = mustFelt(t, dir, "show", fiber2ID, "-d", "compact")
	if !strings.Contains(out, "testlabel") {
		t.Fatalf("tag: expected tag in output, got: %s", out)
	}
	mustFelt(t, dir, "edit", fiber2ID, "--untag", "testlabel")

	// structured ASTRA edit shorthand
	mustFelt(
		t, dir, "edit", fiber2ID,
		"--decision", "covariance",
		"--label", "Covariance method",
		"--rationale", "Tail behavior matters for downstream robustness",
		"--default", "glass",
		"--option", "glass:GLASS mocks",
		"--option", "analytic:Analytic covariance:excluded:underestimates tails",
		"--input", "catalog:data:upstream.posterior:Posterior sample",
		"--insight", "stability:Posterior is stable to jackknife choice",
	)
	out = mustFelt(t, dir, "show", fiber2ID, "--decision", "covariance")
	if !strings.Contains(out, "label: Covariance method") || !strings.Contains(out, "default: glass") {
		t.Fatalf("structured decision edit: unexpected decision output:\n%s", out)
	}
	if !strings.Contains(out, "analytic:") || !strings.Contains(out, "excluded_reason: underestimates tails") {
		t.Fatalf("structured decision edit: missing option details:\n%s", out)
	}
	out = mustFelt(t, dir, "show", fiber2ID, "--inputs")
	if !strings.Contains(out, "id: catalog") || !strings.Contains(out, "from: upstream.posterior") {
		t.Fatalf("structured input edit: unexpected inputs output:\n%s", out)
	}
	out = mustFelt(t, dir, "show", fiber2ID, "--insights")
	if !strings.Contains(out, "stability:") || !strings.Contains(out, "claim: Posterior is stable to jackknife choice") {
		t.Fatalf("structured insight edit: unexpected insights output:\n%s", out)
	}
	out, err = felt(dir, "edit", fiber2ID, "--label", "Decision without target")
	if err == nil {
		t.Fatal("structured edit without --decision: expected error")
	}
	if !strings.Contains(out, "require --decision") {
		t.Fatalf("structured edit without --decision: expected helpful error, got: %s", out)
	}

	// duplicate slug should fail instead of auto-disambiguating
	out, err = felt(dir, "add", "second-fiber", "duplicate fiber")
	if err == nil {
		t.Fatal("add duplicate: expected error")
	}
	if !strings.Contains(out, `fiber "second-fiber" already exists`) {
		t.Fatalf("add duplicate: expected duplicate error, got: %s", out)
	}

	astraParentDir := filepath.Join(dir, ".felt", "bao-analysis")
	if err := os.MkdirAll(astraParentDir, 0755); err != nil {
		t.Fatalf("mkdir astra parent fixture: %v", err)
	}
	astraParent := `---
name: BAO Analysis
status: open
created-at: 2026-03-14T10:00:00Z
---
`
	if err := os.WriteFile(filepath.Join(astraParentDir, "bao-analysis.md"), []byte(astraParent), 0644); err != nil {
		t.Fatalf("write astra parent fixture: %v", err)
	}

	astraDir := filepath.Join(astraParentDir, "damping-prior")
	if err := os.MkdirAll(astraDir, 0755); err != nil {
		t.Fatalf("mkdir astra fixture: %v", err)
	}
	astraFiber := `---
name: BAO Damping Prior
status: closed
created-at: 2026-03-15T10:00:00Z
outcome: Informative Gaussian priors confirmed.
description: Prior on BAO damping parameters
inputs:
  - id: clustering_data
    type: data
    from: parent.desi_dr1_vac
    description: DESI DR1 clustering sample
outputs:
  - id: damped_pk
    type: figure
    description: BAO comparison figure
decisions:
  damping_prior:
    label: BAO Damping Prior
    rationale: Broadband projection creates spurious minima
    default: gaussian
    options:
      gaussian:
        label: Informative Gaussian
insights:
  damping_physical:
    claim: BAO damping caused by pairwise displacements of ~10 Mpc
success_criteria:
  - claim: BAO parameters shift <0.5 sigma from DESI 2024 III
container: python:3.11-slim
---
`
	if err := os.WriteFile(filepath.Join(astraDir, "damping-prior.md"), []byte(astraFiber), 0644); err != nil {
		t.Fatalf("write astra fixture: %v", err)
	}

	out = mustFelt(t, dir, "ls", "BAO")
	if !strings.Contains(out, "bao-analysis/damping-prior") {
		t.Fatalf("ls should match ASTRA fields, got: %s", out)
	}
	out = mustFelt(t, dir, "show", "-j", "bao-analysis/damping-prior")
	var astraShown map[string]any
	if err := json.Unmarshal([]byte(out), &astraShown); err != nil {
		t.Fatalf("show -j astra: invalid json: %v\n%s", err, out)
	}
	if _, ok := astraShown["decisions"]; !ok {
		t.Fatalf("show -j astra: missing decisions in %#v", astraShown)
	}

	// export help surface
	outDir := filepath.Join(dir, "exported")
	out = mustFelt(t, dir, "export", "--format", "tapestry", "--out", outDir)
	if !strings.Contains(out, "Exported tapestry to") {
		t.Fatalf("export tapestry: expected export confirmation, got: %s", out)
	}
	if _, err := os.Stat(filepath.Join(outDir, "tapestry.json")); err != nil {
		t.Fatalf("export tapestry: expected tapestry.json, got: %v", err)
	}

	out = mustFelt(t, dir, "export", "--format", "astra")
	if !strings.Contains(out, "Exported ASTRA to") {
		t.Fatalf("export astra: expected export confirmation, got: %s", out)
	}

	astraData, err := os.ReadFile(filepath.Join(dir, "astra.yaml"))
	if err != nil {
		t.Fatalf("export astra: expected astra.yaml, got: %v", err)
	}
	var astraDoc map[string]any
	if err := yaml.Unmarshal(astraData, &astraDoc); err != nil {
		t.Fatalf("export astra: invalid yaml: %v\n%s", err, astraData)
	}
	if got := astraDoc["version"]; got != "1.0" {
		t.Fatalf("export astra: version = %#v, want %q", got, "1.0")
	}
	if got := astraDoc["name"]; got != "Project Fibers" {
		t.Fatalf("export astra: name = %#v, want %q", got, "Project Fibers")
	}
	analyses, ok := astraDoc["analyses"].(map[string]any)
	if !ok {
		t.Fatalf("export astra: missing analyses: %#v", astraDoc)
	}
	if _, ok := analyses["test-fiber"]; ok {
		t.Fatalf("export astra: simple felt should be filtered out: %#v", analyses)
	}
	baoAnalysis, ok := analyses["bao-analysis"].(map[string]any)
	if !ok {
		t.Fatalf("export astra: missing bao-analysis: %#v", analyses)
	}
	children, ok := baoAnalysis["analyses"].(map[string]any)
	if !ok {
		t.Fatalf("export astra: missing nested analyses: %#v", baoAnalysis)
	}
	dampingPrior, ok := children["damping-prior"].(map[string]any)
	if !ok {
		t.Fatalf("export astra: missing damping-prior: %#v", children)
	}
	if parentInputs, ok := baoAnalysis["inputs"].([]any); !ok || len(parentInputs) != 1 {
		t.Fatalf("export astra: structural parent inputs = %#v, want synthesized input", baoAnalysis["inputs"])
	}
	if parentOutputs, ok := baoAnalysis["outputs"].([]any); !ok || len(parentOutputs) != 1 {
		t.Fatalf("export astra: structural parent outputs = %#v, want synthesized output", baoAnalysis["outputs"])
	}
	if got := dampingPrior["name"]; got != "BAO Damping Prior" {
		t.Fatalf("export astra: name = %#v, want %q", got, "BAO Damping Prior")
	}
	inputs, ok := dampingPrior["inputs"].([]any)
	if !ok || len(inputs) != 1 {
		t.Fatalf("export astra: inputs missing from %#v", dampingPrior)
	}
	input0, ok := inputs[0].(map[string]any)
	if !ok {
		t.Fatalf("export astra: input[0] = %#v, want mapping", inputs[0])
	}
	if got := input0["from"]; got != "../desi_dr1_vac" {
		t.Fatalf("export astra: normalized from = %#v, want %q", got, "../desi_dr1_vac")
	}
	if _, ok := dampingPrior["decisions"].(map[string]any); !ok {
		t.Fatalf("export astra: missing decisions: %#v", dampingPrior)
	}

	out = mustFelt(t, dir, "nest", fiber2ID, "bao-analysis")
	if !strings.Contains(out, "Nested second-fiber under bao-analysis as bao-analysis/second-fiber") {
		t.Fatalf("nest: unexpected output: %s", out)
	}
	out = mustFelt(t, dir, "show", "bao-analysis/second-fiber", "-d", "compact")
	if !strings.Contains(out, "bao-analysis/second-fiber") {
		t.Fatalf("nest: expected nested fiber ID, got: %s", out)
	}
	out = mustFelt(t, dir, "tree", "bao-analysis")
	if !strings.Contains(out, "second fiber") {
		t.Fatalf("nest: expected nested child in containment tree, got: %s", out)
	}

	thirdID := strings.TrimSpace(mustFelt(t, dir, "add", "third-fiber", "third fiber"))
	if thirdID != "third-fiber" {
		t.Fatalf("add third fiber: expected ID, got %q", thirdID)
	}
	out = mustFelt(t, dir, "nest", thirdID, "bao-analysis")
	if !strings.Contains(out, "Nested third-fiber under bao-analysis as bao-analysis/third-fiber") {
		t.Fatalf("nest third fiber: unexpected output: %s", out)
	}
	replacementThirdID := strings.TrimSpace(mustFelt(t, dir, "add", "third-fiber", "replacement third fiber"))
	if replacementThirdID != "third-fiber" {
		t.Fatalf("add replacement third fiber: expected ID, got %q", replacementThirdID)
	}
	out, err = felt(dir, "nest", replacementThirdID, "bao-analysis")
	if err == nil {
		t.Fatalf("nest duplicate basename should fail, got: %s", out)
	}
	if !strings.Contains(out, `fiber "bao-analysis/third-fiber" already exists`) {
		t.Fatalf("nest duplicate basename: expected existing-fiber error, got: %s", out)
	}

	out = mustFelt(t, dir, "unnest", "bao-analysis/second-fiber")
	if !strings.Contains(out, "Promoted bao-analysis/second-fiber to second-fiber") {
		t.Fatalf("unnest: unexpected output: %s", out)
	}
	out = mustFelt(t, dir, "show", "second-fiber", "-d", "compact")
	if !strings.Contains(out, "second-fiber") {
		t.Fatalf("unnest: expected top-level fiber ID, got: %s", out)
	}

	out, err = felt(dir, "unnest", "bao-analysis/third-fiber")
	if err == nil {
		t.Fatalf("unnest to existing top-level basename should fail, got: %s", out)
	}
	if !strings.Contains(out, `fiber "third-fiber" already exists`) {
		t.Fatalf("unnest duplicate basename: expected existing-fiber error, got: %s", out)
	}

	migrateDir := filepath.Join(dir, "legacy-project")
	if err := os.MkdirAll(filepath.Join(migrateDir, ".felt"), 0755); err != nil {
		t.Fatalf("mkdir legacy project: %v", err)
	}
	legacyA := `---
name: Legacy Child
created-at: 2026-03-15T10:00:00Z
inputs:
  - id: parent_input
    from: legacy-parent-1234abcd.posterior
---

Child body.
`
	legacyB := `---
name: Legacy Parent
created-at: 2026-03-15T09:00:00Z
---

Parent body.
`
	if err := os.WriteFile(filepath.Join(migrateDir, ".felt", "legacy-child-deadbeef.md"), []byte(legacyA), 0644); err != nil {
		t.Fatalf("write legacy child: %v", err)
	}
	if err := os.WriteFile(filepath.Join(migrateDir, ".felt", "legacy-parent-1234abcd.md"), []byte(legacyB), 0644); err != nil {
		t.Fatalf("write legacy parent: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(migrateDir, ".felt", "session-hub"), 0755); err != nil {
		t.Fatalf("mkdir legacy session hub: %v", err)
	}
	legacyC := `---
title: Session Hub
depends-on:
  - legacy-parent
created-at: 2026-03-15T11:00:00Z
---

(session-hub)=

Session body.
`
	if err := os.WriteFile(filepath.Join(migrateDir, ".felt", "session-hub", "session-hub.md"), []byte(legacyC), 0644); err != nil {
		t.Fatalf("write legacy session hub: %v", err)
	}

	out = mustFelt(t, dir, "migrate", "--dir", migrateDir, "--dry-run")
	if !strings.Contains(out, "Would migrate legacy-child-deadbeef -> legacy-child") {
		t.Fatalf("migrate dry-run: expected mapping, got: %s", out)
	}
	if !strings.Contains(out, "Would rename title -> name in session-hub") {
		t.Fatalf("migrate dry-run: expected title rename, got: %s", out)
	}
	if !strings.Contains(out, "Would remove legacy depends-on from session-hub") {
		t.Fatalf("migrate dry-run: expected depends-on removal, got: %s", out)
	}
	if !strings.Contains(out, "Would strip legacy MyST anchor from session-hub") {
		t.Fatalf("migrate dry-run: expected anchor strip, got: %s", out)
	}
	if _, err := os.Stat(filepath.Join(migrateDir, ".felt", "legacy-child-deadbeef.md")); err != nil {
		t.Fatalf("migrate dry-run should keep flat file: %v", err)
	}

	out = mustFelt(t, dir, "migrate", "--dir", migrateDir)
	if !strings.Contains(out, "Migrated 2 flat fibers, 1 legacy title fields, 1 legacy depends-on keys, 1 legacy MyST anchors") {
		t.Fatalf("migrate: expected summary, got: %s", out)
	}
	if _, err := os.Stat(filepath.Join(migrateDir, ".felt", "myst.yml")); err != nil {
		t.Fatalf("migrate: expected myst.yml, got: %v", err)
	}
	if _, err := os.Stat(filepath.Join(migrateDir, ".felt", "legacy-child", "legacy-child.md")); err != nil {
		t.Fatalf("migrate: expected migrated child, got: %v", err)
	}
	if _, err := os.Stat(filepath.Join(migrateDir, ".felt", "legacy-child-deadbeef.md")); !os.IsNotExist(err) {
		t.Fatalf("migrate: expected flat file removed, err=%v", err)
	}
	out = mustFelt(t, migrateDir, "show", "-j", "legacy-child")
	var migratedShown map[string]any
	if err := json.Unmarshal([]byte(out), &migratedShown); err != nil {
		t.Fatalf("migrate: invalid json from show -j: %v\n%s", err, out)
	}
	inputs, ok = migratedShown["inputs"].([]any)
	if !ok || len(inputs) != 1 {
		t.Fatalf("migrate: unexpected inputs %#v", migratedShown["inputs"])
	}
	input, ok := inputs[0].(map[string]any)
	if !ok || input["from"] != "legacy-parent.posterior" {
		t.Fatalf("migrate: expected rewritten input ref, got %#v", migratedShown["inputs"])
	}
	sessionHubData, err := os.ReadFile(filepath.Join(migrateDir, ".felt", "session-hub", "session-hub.md"))
	if err != nil {
		t.Fatalf("read migrated session hub: %v", err)
	}
	sessionHubText := string(sessionHubData)
	if strings.Contains(sessionHubText, "title: Session Hub") || strings.Contains(sessionHubText, "depends-on:") || strings.Contains(sessionHubText, "(session-hub)=") {
		t.Fatalf("migrate should normalize session hub, got:\n%s", sessionHubText)
	}
	if !strings.Contains(sessionHubText, "name: Session Hub") {
		t.Fatalf("migrate should write name field, got:\n%s", sessionHubText)
	}

	out, err = felt(dir, "tapestry")
	if err == nil {
		t.Fatalf("tapestry should be removed from the public CLI, got: %s", out)
	}
	if !strings.Contains(out, "unknown command") {
		t.Fatalf("tapestry should be unknown, got: %s", out)
	}

	out, err = felt(dir, "tag")
	if err == nil {
		t.Fatalf("tag should be removed from the public CLI, got: %s", out)
	}
	if !strings.Contains(out, "unknown command") {
		t.Fatalf("tag should be unknown, got: %s", out)
	}
	out, err = felt(dir, "tag", "foo")
	if err == nil {
		t.Fatalf("tag with extra args should still be removed from the public CLI, got: %s", out)
	}
	if !strings.Contains(out, "unknown command") {
		t.Fatalf("tag with extra args should be unknown, got: %s", out)
	}
	for _, retired := range []string{"untag", "link", "unlink", "comment", "upstream", "downstream", "graph", "ready", "find", "prime", "path"} {
		out, err = felt(dir, retired)
		if err == nil {
			t.Fatalf("%s should be removed from the public CLI, got: %s", retired, out)
		}
		if !strings.Contains(out, "unknown command") {
			t.Fatalf("%s should be unknown, got: %s", retired, out)
		}
		out, err = felt(dir, retired, "foo")
		if err == nil {
			t.Fatalf("%s with extra args should still be removed from the public CLI, got: %s", retired, out)
		}
		if !strings.Contains(out, "unknown command") {
			t.Fatalf("%s with extra args should be unknown, got: %s", retired, out)
		}
	}

	// rm
	mustFelt(t, dir, "rm", fiber2ID)
	lsOut := mustFelt(t, dir, "ls", "-s", "all")
	if strings.Contains(lsOut, "second fiber") {
		t.Fatalf("rm: fiber should be gone, got: %s", lsOut)
	}

	// setup claude — should print snippet
	out = mustFelt(t, dir, "setup", "claude")
	if !strings.Contains(out, "## felt") {
		t.Fatalf("setup claude: expected CLAUDE.md snippet, got: %s", out)
	}

	// setup codex — install, idempotent, uninstall
	codexHome := t.TempDir()
	codexEnv := append(os.Environ(), "HOME="+codexHome, "SHELL=/bin/zsh")

	cmd := exec.Command(binaryPath, "setup", "codex")
	cmd.Dir = dir
	cmd.Env = codexEnv
	cmdOut, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup codex install: %v\n%s", err, cmdOut)
	}
	if !strings.Contains(string(cmdOut), "## felt") {
		t.Fatalf("setup codex: expected AGENTS.md snippet, got: %s", cmdOut)
	}

	hooksPath := filepath.Join(codexHome, ".codex", "hooks.json")
	hooksContent, _ := os.ReadFile(hooksPath)
	text := string(hooksContent)
	if !strings.Contains(text, "felt hook session") || !strings.Contains(text, "felt hook remind") {
		t.Fatalf("setup codex: hooks.json missing felt hooks, got: %s", hooksContent)
	}

	// idempotent
	cmd2 := exec.Command(binaryPath, "setup", "codex")
	cmd2.Dir = dir
	cmd2.Env = codexEnv
	cmdOut2, _ := cmd2.CombinedOutput()
	if !strings.Contains(string(cmdOut2), "already installed") {
		t.Fatalf("setup codex idempotency: expected 'already installed', got: %s", cmdOut2)
	}

	// uninstall
	cmd3 := exec.Command(binaryPath, "setup", "codex", "--uninstall")
	cmd3.Dir = dir
	cmd3.Env = codexEnv
	cmd3Out, err := cmd3.CombinedOutput()
	if err != nil {
		t.Fatalf("setup codex uninstall: %v\n%s", err, cmd3Out)
	}
	hooksContent2, _ := os.ReadFile(hooksPath)
	if strings.Contains(string(hooksContent2), "felt hook session") || strings.Contains(string(hooksContent2), "felt hook remind") {
		t.Fatalf("setup codex uninstall: hooks still present in hooks.json")
	}

	out = mustFelt(t, dir, "--help")
	if !strings.Contains(out, "export") {
		t.Fatalf("help: expected export command, got: %s", out)
	}
	if strings.Contains(out, "tapestry") {
		t.Fatalf("help: legacy tapestry command should be hidden, got: %s", out)
	}
	for _, retired := range []string{"tag", "untag", "link", "unlink", "comment", "upstream", "downstream", "graph", "ready", "prime", "path"} {
		pattern := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(retired) + `\s`)
		if pattern.MatchString(out) {
			t.Fatalf("help: legacy command %q should be hidden, got: %s", retired, out)
		}
	}
}
