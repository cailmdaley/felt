package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// isolateCommits is an env whose every ledger resolver tier points into the
// test's own temp tree, so no test can read or write a real ~/.shuttle
// ledger. It returns the env and its (empty) home.
func isolateCommits(t *testing.T) (*sysenv.Env, string) {
	t.Helper()
	env, home := envWithHome(t)
	env.Set("SHUTTLE_COMMITS_FILE", "")
	env.Set("SHUTTLE_DATA_DIR", "")
	env.Set("SHUTTLE_TMUX_SESSION", "test-session")
	env.Set("TMUX", "")
	return env, home
}

// commitLedger is isolateCommits with SHUTTLE_COMMITS_FILE naming a fresh
// ledger, whose path it returns.
func commitLedger(t *testing.T) (*sysenv.Env, string) {
	t.Helper()
	env, _ := isolateCommits(t)
	path := filepath.Join(t.TempDir(), "commits.jsonl")
	env.Set("SHUTTLE_COMMITS_FILE", path)
	return env, path
}

// sharedRepos holds one repository per commit subject, built once for the
// package run inside the TestMain fence directory. The hook only reads a
// repository, so tests that never commit share it.
var sharedRepos sync.Map // subject → *sharedRepo

type sharedRepo struct {
	once sync.Once
	dir  string
	err  error
}

// sharedGitRepo is a read-only repository with one commit whose subject is
// subject, shared by every test that asks for it. A test that commits builds
// its own with gitRepo.
func sharedGitRepo(t *testing.T, subject string) string {
	t.Helper()
	requireGit(t)
	entry, _ := sharedRepos.LoadOrStore(subject, &sharedRepo{})
	repo := entry.(*sharedRepo)
	repo.once.Do(func() {
		repo.dir, repo.err = os.MkdirTemp(testFenceDir, "repo-*")
		if repo.err == nil {
			repo.err = initGitRepo(repo.dir, subject)
		}
	})
	if repo.err != nil {
		t.Fatal(repo.err)
	}
	return repo.dir
}

// gitRepo makes a throwaway repository with one commit and returns its path.
func gitRepo(t *testing.T, subject string) string {
	t.Helper()
	requireGit(t)
	dir := t.TempDir()
	if err := initGitRepo(dir, subject); err != nil {
		t.Fatal(err)
	}
	return dir
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
}

// initGitRepo makes dir a repository whose one commit adds a two-line a.txt.
func initGitRepo(dir, subject string) error {
	if err := runGit(dir, "init", "--initial-branch=main"); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		return err
	}
	if err := runGit(dir, "add", "a.txt"); err != nil {
		return err
	}
	return runGit(dir, "commit", "-m", subject)
}

// runGit runs one git command in dir. Identity is passed per-command: the
// runner's own git config must not decide whether this test can commit, and
// a name in tracked source is what lint-personal exists to catch.
func runGit(dir string, args ...string) error {
	full := append([]string{"-C", dir, "-c", "user.name=felt test", "-c", "user.email=test@example.invalid"}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return nil
}

// commitPayload is the PostToolUse envelope a Bash call produces.
func commitPayload(cwd, command string) map[string]any {
	return map[string]any{
		"hook_event_name": "PostToolUse",
		"session_id":      "sess-1",
		"cwd":             cwd,
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": command},
	}
}

func writeCommit(t *testing.T, env *sysenv.Env, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if err := newApp(env).runCommitHook(bytes.NewReader(raw)); err != nil {
		t.Fatalf("runCommitHook: %v", err)
	}
}

// TestCommitLineShape pins the record Shuttle.CommitLedger consumes: `at` an
// integer and `sha` a non-empty string (parse_line/3 drops anything else), plus
// the fields /api/v1/commits serves verbatim to the board's CommitRecord.
func TestCommitLineShape(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)
	repo := sharedGitRepo(t, "desk: cycle lens")

	writeCommit(t, env, commitPayload(repo, `git commit -m "desk: cycle lens"`))

	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	line := lines[0]

	at, ok := line["at"].(float64)
	if !ok || at <= 0 || at != float64(int64(at)) {
		t.Fatalf("at = %v, want a positive integer (CommitLedger drops a line without one)", line["at"])
	}
	sha, ok := line["sha"].(string)
	if !ok || len(sha) != 40 {
		t.Fatalf("sha = %v, want a 40-char string", line["sha"])
	}
	if line["kind"] != "commit" {
		t.Fatalf("kind = %v, want \"commit\"", line["kind"])
	}
	if line["subject"] != "desk: cycle lens" {
		t.Fatalf("subject = %v, want the commit subject", line["subject"])
	}
	// The repo is the toplevel, not the cwd the call happened to run in.
	repoRoot, ok := line["repo"].(string)
	if !ok || filepath.Base(repoRoot) != filepath.Base(repo) {
		t.Fatalf("repo = %v, want the repository root %q", line["repo"], repo)
	}
	// One added file, two lines, nothing deleted.
	for field, want := range map[string]float64{"files": 1, "insertions": 2, "deletions": 0} {
		got, ok := line[field].(float64)
		if !ok || got != want {
			t.Fatalf("%s = %v, want %v", field, line[field], want)
		}
	}
	if line["session"] != "sess-1" {
		t.Fatalf("session = %v, want \"sess-1\"", line["session"])
	}
	if line["tmux"] != "test-session" {
		t.Fatalf("tmux = %v, want \"test-session\"", line["tmux"])
	}
	if line["cwd"] != repo {
		t.Fatalf("cwd = %v, want %q", line["cwd"], repo)
	}
	// `host` is stamped by the reader that knows which machine served the
	// ledger (ShuttleWeb.TemporalComposite), never by the writer.
	if _, present := line["host"]; present {
		t.Fatalf("writer stamped a host field: %v", line["host"])
	}
}

// TestCommitProvenanceNulls: an absent provenance field is null, not "". The
// board's CommitRecord types these `string | null`, and an empty string would
// render as a session that exists but has no name.
func TestCommitProvenanceNulls(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)
	repo := sharedGitRepo(t, "subject")
	env.Set("SHUTTLE_TMUX_SESSION", "")

	payload := commitPayload(repo, "git commit -m anonymous")
	// "unknown" is the placeholder an anonymous session carries; it names no
	// session, so it must not be written as one.
	payload["session_id"] = "unknown"
	writeCommit(t, env, payload)

	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	for _, field := range []string{"session", "tmux"} {
		v, present := lines[0][field]
		if !present || v != nil {
			t.Fatalf("%s = %v (present=%v), want present and null", field, v, present)
		}
	}
}

// TestCommitRecordingCases is the matcher matrix: which payloads produce a line
// at all.
func TestCommitRecordingCases(t *testing.T) {
	t.Parallel()
	repo := sharedGitRepo(t, "subject")
	notRepo := t.TempDir()

	for _, tc := range []struct {
		name    string
		mutate  func(map[string]any)
		command string
		want    int
	}{
		{name: "a plain commit", command: `git commit -m "subject"`, want: 1},
		{
			// pi names its tools lowercase; the ledger must not depend on the
			// adapter remembering to re-capitalize.
			name:    "pi-shaped lowercase tool name",
			command: "git commit -m x",
			mutate:  func(p map[string]any) { p["tool_name"] = "bash" },
			want:    1,
		},
		{name: "committed from another directory", command: "git -C /some/repo commit -m x", want: 1},
		{name: "commit behind a cd", command: "cd /tmp/repo && git commit --amend --no-edit", want: 1},
		{name: "commit with a global option", command: "git --no-pager commit -m x", want: 1},
		{name: "commit on a later line", command: "set -e\ngit commit -m x", want: 1},
		{name: "heredoc message", command: "git commit -F - <<'EOF'\nsubject\nEOF", want: 1},
		{name: "another git verb", command: "git status --short", want: 0},
		{name: "a word ending in commit", command: "grep -r precommit .", want: 0},
		{name: "the word alone", command: "echo commit", want: 0},
		{name: "an unrelated command", command: "ls -la", want: 0},
		{
			name:    "another tool entirely",
			command: "git commit -m x",
			mutate:  func(p map[string]any) { p["tool_name"] = "Edit" },
			want:    0,
		},
		{
			// HEAD is still the previous commit when the call has not run yet;
			// recording here would pair an older commit with this session.
			name:    "the same call before it ran",
			command: "git commit -m x",
			mutate:  func(p map[string]any) { p["hook_event_name"] = "PreToolUse" },
			want:    0,
		},
		{
			name:    "a cwd that is not a repository",
			command: "git commit -m x",
			mutate:  func(p map[string]any) { p["cwd"] = notRepo },
			want:    0,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env, path := commitLedger(t)
			payload := commitPayload(repo, tc.command)
			if tc.mutate != nil {
				tc.mutate(payload)
			}
			writeCommit(t, env, payload)
			if got := len(readEventLines(t, path)); got != tc.want {
				t.Fatalf("got %d lines, want %d", got, tc.want)
			}
		})
	}
}

// TestCommitDedupe: the same sha is never appended twice. A re-run of the
// command, or a `git commit` that failed and left HEAD where it was, must not
// draw a second commit on the board.
func TestCommitDedupe(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)
	repo := gitRepo(t, "first")

	writeCommit(t, env, commitPayload(repo, "git commit -m first"))
	writeCommit(t, env, commitPayload(repo, "git commit -m first"))
	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines after a repeat, want 1", len(lines))
	}

	// A real second commit still lands: dedupe is per sha, not "one per repo".
	if err := runGit(repo, "commit", "--allow-empty", "-m", "second"); err != nil {
		t.Fatalf("second commit: %v", err)
	}
	writeCommit(t, env, commitPayload(repo, "git commit --allow-empty -m second"))
	lines = readEventLines(t, path)
	if len(lines) != 2 {
		t.Fatalf("got %d lines after a second commit, want 2", len(lines))
	}
	if lines[0]["sha"] == lines[1]["sha"] {
		t.Fatalf("both lines carry the same sha: %v", lines[0]["sha"])
	}
	if lines[1]["subject"] != "second" {
		t.Fatalf("second line's subject = %v, want \"second\"", lines[1]["subject"])
	}
}

// TestCommitWriteGate: with no explicit path, the daemon's state directory is
// the opt-in. Absent, the hook writes nothing AND creates nothing — a felt user
// who never runs shuttle gets no surprise ~/.shuttle.
func TestCommitWriteGate(t *testing.T) {
	t.Parallel()
	env, home := isolateCommits(t)
	repo := sharedGitRepo(t, "subject")

	writeCommit(t, env, commitPayload(repo, "git commit -m gated"))
	if _, err := os.Stat(filepath.Join(home, ".shuttle")); !os.IsNotExist(err) {
		t.Fatalf("~/.shuttle was created (err=%v); the gate must not create it", err)
	}

	// Create it, and the same payload now lands.
	if err := os.Mkdir(filepath.Join(home, ".shuttle"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeCommit(t, env, commitPayload(repo, "git commit -m gated"))
	if lines := readEventLines(t, filepath.Join(home, ".shuttle", "commits.jsonl")); len(lines) != 1 {
		t.Fatalf("got %d lines after enabling, want 1", len(lines))
	}
}

// TestCommitDataDirTier: SHUTTLE_DATA_DIR is the middle tier and is still
// gated — it names a directory the daemon owns, not a path the caller asked for.
func TestCommitDataDirTier(t *testing.T) {
	t.Parallel()
	env, _ := isolateCommits(t)
	repo := sharedGitRepo(t, "subject")
	dataDir := filepath.Join(t.TempDir(), "shuttle-data")
	env.Set("SHUTTLE_DATA_DIR", dataDir)

	writeCommit(t, env, commitPayload(repo, "git commit -m tiered"))
	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("SHUTTLE_DATA_DIR was created (err=%v); it is gated like the default", err)
	}

	if err := os.Mkdir(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeCommit(t, env, commitPayload(repo, "git commit -m tiered"))
	if lines := readEventLines(t, filepath.Join(dataDir, "commits.jsonl")); len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
}

// TestCommitExplicitFileOverridesGate: SHUTTLE_COMMITS_FILE is explicit intent,
// so it creates its parent rather than declining to write.
func TestCommitExplicitFileOverridesGate(t *testing.T) {
	t.Parallel()
	env, _ := isolateCommits(t)
	repo := sharedGitRepo(t, "subject")
	path := filepath.Join(t.TempDir(), "nested", "deeper", "commits.jsonl")
	env.Set("SHUTTLE_COMMITS_FILE", path)

	writeCommit(t, env, commitPayload(repo, "git commit -m explicit"))
	if lines := readEventLines(t, path); len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
}

// TestCommitDegenerateInput: a tracking hook must never fail a tool call. Every
// unusable payload is a silent, writeless pass.
func TestCommitDegenerateInput(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)

	for _, in := range []string{
		"", "   ", "not json", "{", `{"tool_name":`, `[]`, `"a string"`,
		`{"tool_name":123}`,
		`{"hook_event_name":"PostToolUse","tool_name":"Bash"}`,
		`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"git commit"},"cwd":"/nonexistent/path"}`,
	} {
		if err := newApp(env).runCommitHook(strings.NewReader(in)); err != nil {
			t.Fatalf("runCommitHook(%q) = %v, want nil", in, err)
		}
	}
	if lines := readEventLines(t, path); len(lines) != 0 {
		t.Fatalf("degenerate payloads recorded %d lines, want 0", len(lines))
	}
}

// TestCommitHookIsSilent: the hook prints nothing on stdout. Claude Code parses
// hook stdout as an envelope; any stray byte is a protocol error.
func TestCommitHookIsSilent(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)
	repo := sharedGitRepo(t, "subject")

	streams := sysenvtest.Capture(env)
	writeCommit(t, env, commitPayload(repo, "git commit -m quiet"))
	if out := streams.Stdout.String(); out != "" {
		t.Fatalf("hook wrote %q to stdout, want nothing", out)
	}
	if lines := readEventLines(t, path); len(lines) != 1 {
		t.Fatalf("hook recorded %d lines, want 1: the silence must come from a hook that ran", len(lines))
	}
}

// TestCommitSubjectWithTabs: `%H%x09%at%x09%s` is split into three fields, and
// the third keeps its own tabs — the subject is the last field, not a field
// count.
func TestCommitSubjectWithTabs(t *testing.T) {
	t.Parallel()
	env, path := commitLedger(t)
	repo := sharedGitRepo(t, "tabbed\tsubject\there")

	writeCommit(t, env, commitPayload(repo, "git commit -m tabbed"))
	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if lines[0]["subject"] != "tabbed\tsubject\there" {
		t.Fatalf("subject = %q, want the whole tabbed subject", lines[0]["subject"])
	}
}

// TestParseShortstat covers the clauses git omits: a commit with only additions
// prints no deletions clause, and each missing count reads as 0.
func TestParseShortstat(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		in                           string
		files, insertions, deletions int
	}{
		{" 3 files changed, 42 insertions(+), 7 deletions(-)", 3, 42, 7},
		{" 1 file changed, 1 insertion(+)", 1, 1, 0},
		{" 1 file changed, 1 deletion(-)", 1, 0, 1},
		{" 2 files changed", 2, 0, 0},
		{"", 0, 0, 0},
	} {
		files, insertions, deletions := parseShortstat(tc.in)
		if files != tc.files || insertions != tc.insertions || deletions != tc.deletions {
			t.Fatalf("parseShortstat(%q) = %d/%d/%d, want %d/%d/%d",
				tc.in, files, insertions, deletions, tc.files, tc.insertions, tc.deletions)
		}
	}
}
