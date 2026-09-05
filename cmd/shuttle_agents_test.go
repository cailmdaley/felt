package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runAgents executes a `felt shuttle agents …` invocation and returns stdout and
// stderr separately. The split is the point: the daemon pipes stdout into
// Jason.decode!, so the provenance footer and any load warnings must land on
// stderr or the browser's agent picker breaks.
func runAgents(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()

	prevJSON, prevSource, prevPath, prevForce := jsonOutput, agentsSourceFilter, agentsInitPath, agentsInitForce
	prevArgs, prevChangeDir, prevStdout := os.Args, changeDir, os.Stdout
	defer func() {
		jsonOutput, agentsSourceFilter, agentsInitPath, agentsInitForce = prevJSON, prevSource, prevPath, prevForce
		os.Args, changeDir, os.Stdout = prevArgs, prevChangeDir, prevStdout
		rootCmd.SetArgs(nil)
		rootCmd.SetOut(io.Discard)
		rootCmd.SetErr(io.Discard)
	}()

	// Cobra only assigns flag values on parse, so a prior --json run leaves them
	// set. Reset to defaults.
	jsonOutput, agentsSourceFilter, agentsInitPath, agentsInitForce = false, "", "", false

	var errBuf bytes.Buffer
	rootCmd.SetErr(&errBuf)
	rootCmd.SetArgs(args)

	r, w, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatalf("os.Pipe: %v", pipeErr)
	}
	os.Stdout = w
	runErr := rootCmd.Execute()
	if err := w.Close(); err != nil {
		t.Fatalf("close write pipe: %v", err)
	}
	var outBuf bytes.Buffer
	if _, err := io.Copy(&outBuf, r); err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	_ = r.Close()

	return outBuf.String(), errBuf.String(), runErr
}

// userRegistry writes a user registry and points $FELT_AGENTS_FILE at it.
func userRegistry(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agents.json")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	t.Setenv("FELT_AGENTS_FILE", path)
	return path
}

// ---- listing ----------------------------------------------------------------

func TestShuttleAgents_FooterNamesTheUserFile(t *testing.T) {
	// No user file: the footer says so, and says where it looked.
	missing := filepath.Join(t.TempDir(), "absent.json")
	t.Setenv("FELT_AGENTS_FILE", missing)
	_, stderr, err := runAgents(t, "shuttle", "agents")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if !strings.Contains(stderr, "no user file at "+missing) {
		t.Fatalf("footer should name the path it looked at:\n%s", stderr)
	}

	// With one: the footer names it and the merge mode.
	path := userRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x"}]}`)
	_, stderr, err = runAgents(t, "shuttle", "agents")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if !strings.Contains(stderr, path) || !strings.Contains(stderr, "builtins: merge") {
		t.Fatalf("footer should name the loaded path and mode:\n%s", stderr)
	}
}

func TestShuttleAgents_MarksUserRecords(t *testing.T) {
	userRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x"}]}`)
	stdout, _, err := runAgents(t, "shuttle", "agents")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if !strings.Contains(stdout, "u mine") {
		t.Fatalf("user records should carry the `u` marker:\n%s", stdout)
	}
	if !strings.Contains(stdout, "* claude-opus") {
		t.Fatalf("the default should carry the `*` marker:\n%s", stdout)
	}
}

func TestShuttleAgents_SourceFilter(t *testing.T) {
	userRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x"}]}`)

	stdout, _, err := runAgents(t, "shuttle", "agents", "--source", "user", "--json")
	if err != nil {
		t.Fatalf("agents --source user: %v", err)
	}
	var user []map[string]any
	if err := json.Unmarshal([]byte(stdout), &user); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	if len(user) != 1 || user[0]["id"] != "mine" {
		t.Fatalf("--source user = %v, want just the user record", user)
	}

	stdout, _, err = runAgents(t, "shuttle", "agents", "--source", "builtin", "--json")
	if err != nil {
		t.Fatalf("agents --source builtin: %v", err)
	}
	var builtin []map[string]any
	if err := json.Unmarshal([]byte(stdout), &builtin); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	for _, rec := range builtin {
		if rec["id"] == "mine" {
			t.Fatal("--source builtin leaked a user record")
		}
	}

	if _, _, err := runAgents(t, "shuttle", "agents", "--source", "nonsense"); err == nil {
		t.Fatal("an unknown --source value should error")
	}
}

// --json must emit the array and nothing else, on EITHER stream. The daemon
// shells this verb through Shuttle.Felt.run, which always sets
// stderr_to_stdout, so "clean stdout, chatter on stderr" is not clean enough:
// the chatter would arrive inside the bytes Jason.decode! sees and empty the
// browser's agent picker. Text mode carries the same information for people.
func TestShuttleAgents_JSONEmitsNothingButTheArray(t *testing.T) {
	userRegistry(t, `{"version":1,"agents":[
	  {"id":"a","cli":"x","default":true},
	  {"id":"b","cli":"x","default":true}
	]}`)

	stdout, stderr, err := runAgents(t, "shuttle", "agents", "--json")
	if err != nil {
		t.Fatalf("agents --json: %v", err)
	}
	var records []map[string]any
	if err := json.Unmarshal([]byte(stdout), &records); err != nil {
		t.Fatalf("stdout is not pure JSON: %v\n%s", err, stdout)
	}
	if stderr != "" {
		t.Fatalf("--json must write nothing to stderr, got:\n%s", stderr)
	}
	// Folding the streams the way the daemon does must still decode.
	if err := json.Unmarshal([]byte(stdout+stderr), &records); err != nil {
		t.Fatalf("stdout+stderr does not decode as JSON: %v", err)
	}

	// The same run in text mode tells a person what --json withholds.
	_, stderr, err = runAgents(t, "shuttle", "agents")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if !strings.Contains(stderr, "warning:") {
		t.Fatalf("the duplicate-default warning should be on stderr:\n%s", stderr)
	}
	if !strings.Contains(stderr, "registry:") {
		t.Fatalf("the footer should be on stderr:\n%s", stderr)
	}
}

// A broken user file is fatal everywhere, and the error names the path — a typo
// must not read as "my agents vanished".
func TestShuttleAgents_MalformedUserFileIsFatal(t *testing.T) {
	path := userRegistry(t, `{"version":9,"agents":[]}`)
	_, _, err := runAgents(t, "shuttle", "agents")
	if err == nil {
		t.Fatal("expected a fatal error")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("error %q does not name %q", err, path)
	}
}

// ---- resolve ----------------------------------------------------------------

func TestShuttleAgentsResolve_SeesUserAgents(t *testing.T) {
	userRegistry(t, `{"version":1,"agents":[
	  {"id":"my-agent","cli":"mycli","model":"m1","effort_levels":["low","high"],"default_effort":"high"}
	]}`)

	stdout, _, err := runAgents(t, "shuttle", "agents", "resolve", "my-agent", "--json")
	if err != nil {
		t.Fatalf("resolve my-agent: %v", err)
	}
	var resolved map[string]any
	if err := json.Unmarshal([]byte(stdout), &resolved); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	if resolved["id"] != "my-agent" || resolved["effort"] != "high" {
		t.Fatalf("resolved = %v, want my-agent at its default effort", resolved)
	}
	// Provenance is a listing concern; the dispatch contract must not carry it.
	if _, present := resolved["source"]; present {
		t.Fatalf("ResolvedAgent must not expose source: %v", resolved)
	}
}

// ---- init -------------------------------------------------------------------

func TestShuttleAgentsInit_WritesRefusesAndForces(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agents.json")
	t.Setenv("FELT_AGENTS_FILE", path)

	stdout, _, err := runAgents(t, "shuttle", "agents", "init")
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if !strings.Contains(stdout, path) {
		t.Fatalf("init should print the path it wrote:\n%s", stdout)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seeded registry: %v", err)
	}
	var file struct {
		Version  int              `json:"version"`
		Builtins string           `json:"builtins"`
		Agents   []map[string]any `json:"agents"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatalf("seeded registry is not valid JSON: %v\n%s", err, body)
	}
	if file.Version != 1 || file.Builtins != "merge" || len(file.Agents) == 0 {
		t.Fatalf("seeded envelope = %+v", file)
	}
	for _, rec := range file.Agents {
		if _, present := rec["source"]; present {
			t.Fatalf("a seeded record must not claim provenance: %v", rec)
		}
	}
	// The seed round-trips: loading it back is not an error.
	if _, _, err := runAgents(t, "shuttle", "agents"); err != nil {
		t.Fatalf("the seeded registry must load: %v", err)
	}

	if _, _, err := runAgents(t, "shuttle", "agents", "init"); err == nil {
		t.Fatal("init should refuse to overwrite without --force")
	}
	if _, _, err := runAgents(t, "shuttle", "agents", "init", "--force"); err != nil {
		t.Fatalf("init --force: %v", err)
	}

	// --path overrides the resolved location.
	other := filepath.Join(t.TempDir(), "elsewhere.json")
	if _, _, err := runAgents(t, "shuttle", "agents", "init", "--path", other); err != nil {
		t.Fatalf("init --path: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("init --path did not write %s: %v", other, err)
	}
}

// ---- install-time validation -------------------------------------------------

// The explicit "install checks user agents" proof: block validation resolves
// against whatever registry it is handed, so a user-registry agent is installable
// with no change to the create path.
func TestShuttleInstall_AcceptsUserRegistryAgent(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")
	pdir := t.TempDir()

	// Without the user registry the id is unknown, and the error lists what is.
	t.Setenv("FELT_AGENTS_FILE", filepath.Join(t.TempDir(), "absent.json"))
	out, err := runCommand(t, dir, "shuttle", "install", "task",
		"--host", "testhost", "--project-dir", pdir, "--model", "my-agent")
	if err == nil {
		t.Fatalf("install with an unknown agent should fail:\n%s", out)
	}

	userRegistry(t, `{"version":1,"agents":[{"id":"my-agent","cli":"mycli"}]}`)
	out, err = runCommand(t, dir, "shuttle", "install", "task",
		"--host", "testhost", "--project-dir", pdir, "--model", "my-agent")
	if err != nil {
		t.Fatalf("install with a user-registry agent: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "task")
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Agent != "my-agent" {
		t.Fatalf("agent = %q, want my-agent", b.Agent)
	}
}
