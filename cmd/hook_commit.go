package cmd

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// ----------------------------------------------------------------------------
// `felt hook commit` — the host-local commit ledger
// ----------------------------------------------------------------------------
//
// Appends one JSONL line per commit to ~/.shuttle/commits.jsonl, pairing the
// commit with the session that made it. The pairing is knowable only inside
// the session's own process tree, which is why the writer is a hook and the
// daemon is only a reader (lib/shuttle/commit_ledger.ex); anything else would
// be back to guessing the author from a commit subject.
//
// The reader takes a line as a commit when `at` is an integer and `sha` a
// non-empty string (CommitLedger.parse_line/3); the board renders the rest
// (subject, repo, --shortstat counts, session/tmux/cwd provenance) without
// going back to the repo, which may live on another host.
//
// The contract with the harness is runEventHook's: print nothing, exit 0,
// always. A tracking hook that can fail a tool call is worse than no tracking
// hook, so every step below is guarded and any surprise records nothing.

var hookCommitCmd = &cobra.Command{
	Use:   "commit",
	Short: "Record the commit a Bash call just made on the host-local ledger",
	Long: `Reads the PostToolUse payload from stdin and, when the Bash call ran a
git commit, appends one JSON line to the commit ledger (SHUTTLE_COMMITS_FILE,
else $SHUTTLE_DATA_DIR/commits.jsonl, else ~/.shuttle/commits.jsonl) naming
the commit and the session that made it. The board's Chronicle narrates work
from that ledger.

Writes only when the ledger's parent directory already exists — the daemon's
state directory is the opt-in. An explicit SHUTTLE_COMMITS_FILE overrides that
and creates the directory.

A sha already near the end of the ledger is not appended twice, so a re-run of
the same command, or a git commit that failed and left HEAD where it was,
records nothing.

Prints nothing and exits 0 on every path, including malformed input.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCommitHook(os.Stdin)
	},
}

type commitHookInput struct {
	HookEventName string `json:"hook_event_name"`
	SessionID     string `json:"session_id"`
	CWD           string `json:"cwd"`
	ToolName      string `json:"tool_name"`
	ToolInput     struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

// commitLine is the wire shape, in wire order. Field set and names are what
// Shuttle.CommitLedger serves verbatim to /api/v1/commits and the board's
// CommitRecord (ui/src/board/views/TemporalData.ts) — `host` is the one field
// the line does not carry, stamped by the reader that knows which machine the
// ledger came from.
type commitLine struct {
	At         int64   `json:"at"`
	Kind       string  `json:"kind"`
	SHA        string  `json:"sha"`
	Subject    string  `json:"subject"`
	Repo       string  `json:"repo"`
	Files      int     `json:"files"`
	Insertions int     `json:"insertions"`
	Deletions  int     `json:"deletions"`
	Session    *string `json:"session"`
	Tmux       *string `json:"tmux"`
	CWD        *string `json:"cwd"`
}

// gitCommitPattern recognizes a command that ran `git commit`, tolerating the
// options that sit between the two words (`git -C <path> commit`, `git --no-pager
// commit`) and the shell separators that can precede them (`cd x && git commit`).
//
// Deliberately loose: a false positive costs nothing, because a sha already in
// the ledger is skipped and a command that ran no commit leaves HEAD where the
// previous line already recorded it. `(?m)` anchors ^ and $ per line, so a
// commit on any line of a multi-line script counts.
var gitCommitPattern = regexp.MustCompile(
	`(?m)(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+commit([[:space:]]|$)`)

// `git log -1 --shortstat` prints e.g. " 3 files changed, 42 insertions(+), 7
// deletions(-)". Any of the three clauses may be absent; each parse defaults to 0.
var (
	shortstatFiles      = regexp.MustCompile(`([0-9]+) files? changed`)
	shortstatInsertions = regexp.MustCompile(`([0-9]+) insertions?`)
	shortstatDeletions  = regexp.MustCompile(`([0-9]+) deletions?`)
)

const (
	// commitDedupeLines is how far back a just-made commit could be — the tail
	// of the ledger is the only place its sha would appear.
	commitDedupeLines = 200
	// commitDedupeBytes bounds the tail read that feeds it. One line runs a few
	// hundred bytes, so this covers the window without reading a ledger that
	// has been accumulating for years.
	commitDedupeBytes = 64 << 10
	// gitProbeTimeout bounds each git call. This runs after a Bash tool call,
	// and a wedged repo must not stall the agent.
	gitProbeTimeout = 5 * time.Second
)

// runCommitHook decodes the payload and appends at most one line. Every
// failure — unparseable stdin, another tool, no commit in the command, no
// repository, a sha already recorded, an unwritable ledger — returns nil
// without output.
func runCommitHook(stdin io.Reader) error {
	var input commitHookInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return nil
	}
	// The plugin's hooks.json matcher already narrows to PostToolUse on Bash,
	// but we re-check so the binary is correct under a harness that fires the
	// hook more widely or names its tools with different casing (pi: "bash").
	// PreToolUse in particular must not record: the commit has not happened
	// yet, and HEAD is still the previous session's.
	if !strings.EqualFold(input.HookEventName, "PostToolUse") || !strings.EqualFold(input.ToolName, "Bash") {
		return nil
	}
	if !gitCommitPattern.MatchString(input.ToolInput.Command) {
		return nil
	}
	path, enabled := commitsSink()
	if !enabled {
		return nil
	}
	line, ok := renderCommitLine(input, path)
	if !ok {
		return nil
	}
	// No rollover, unlike the event stream: this is the durable record the
	// board narrates history from, and a commit it drops is one no reader can
	// recover. It grows by a few hundred bytes per commit, so it does not need
	// one.
	_ = appendLine(path, line)
	return nil
}

// renderCommitLine reads HEAD back out of the repository the Bash call ran in
// and builds the newline-terminated JSONL line for it, or ok=false when there
// is nothing to record.
func renderCommitLine(input commitHookInput, ledgerPath string) (string, bool) {
	repoDir := strings.TrimSpace(input.CWD)
	if repoDir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", false
		}
		repoDir = wd
	}
	// Not a repository, a deleted cwd, no commits yet: all mean "nothing to
	// record", never "fail".
	repoRoot, ok := gitOutput(repoDir, "rev-parse", "--show-toplevel")
	if !ok || repoRoot == "" {
		return "", false
	}
	head, ok := gitOutput(repoRoot, "log", "-1", "--format=%H%x09%at%x09%s")
	if !ok {
		return "", false
	}
	// Three tab-separated fields, and the subject may itself contain tabs.
	parts := strings.SplitN(head, "\t", 3)
	sha := parts[0]
	if sha == "" {
		return "", false
	}
	if ledgerHasSHA(ledgerPath, sha) {
		return "", false
	}

	var at int64
	if len(parts) > 1 {
		if secs, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
			at = secs * 1000
		}
	}
	if at == 0 {
		// An unreadable commit date still gets a stamp: the reader drops a
		// record with no usable `at`, and "now" is within seconds of the truth.
		at = eventNow().UnixMilli()
	}
	var subject string
	if len(parts) > 2 {
		subject = parts[2]
	}
	files, insertions, deletions := 0, 0, 0
	if shortstat, ok := gitOutput(repoRoot, "log", "-1", "--shortstat", "--format="); ok {
		files, insertions, deletions = parseShortstat(shortstat)
	}

	line := commitLine{
		At:         at,
		Kind:       "commit",
		SHA:        sha,
		Subject:    subject,
		Repo:       repoRoot,
		Files:      files,
		Insertions: insertions,
		Deletions:  deletions,
		Session:    nullableField(sessionOrAnonymous(input.SessionID)),
		Tmux:       nullableField(currentTmuxSession()),
		CWD:        nullableField(input.CWD),
	}
	encoded, err := encodeJSONLine(line)
	if err != nil {
		return "", false
	}
	return encoded, true
}

// sessionOrAnonymous drops the placeholder an anonymous session carries, so a
// line claims a session only when it has one.
func sessionOrAnonymous(sessionID string) string {
	if sessionID == "unknown" {
		return ""
	}
	return sessionID
}

// nullableField renders an absent field as JSON null rather than "". The
// provenance fields are optional by nature — a session outside tmux has no
// tmux name — and null is what the reader's record type expects for one.
func nullableField(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// parseShortstat pulls the three counts out of a `--shortstat` summary. A
// clause git omitted (a commit with no deletions) reads as 0.
func parseShortstat(shortstat string) (files, insertions, deletions int) {
	number := func(re *regexp.Regexp) int {
		m := re.FindStringSubmatch(shortstat)
		if m == nil {
			return 0
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			return 0
		}
		return n
	}
	return number(shortstatFiles), number(shortstatInsertions), number(shortstatDeletions)
}

// gitOutput runs one git command in dir and returns its trimmed stdout, or
// ok=false on any failure — including the timeout, which is the point of
// running it under a context at all.
func gitOutput(dir string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gitProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return "", false
	}
	return strings.TrimRight(string(out), "\n"), true
}

// ledgerHasSHA reports whether the tail of the ledger already records this
// commit. Reads the last commitDedupeBytes rather than the file: the ledger is
// append-only and never pruned, and a just-made commit can only be at the end.
// A partial first line costs nothing — it is scanned as a substring, and the
// same sha, if it is really in the window, is on a whole line too.
func ledgerHasSHA(path, sha string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false
	}
	if offset := info.Size() - commitDedupeBytes; offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return false
		}
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > commitDedupeLines {
		lines = lines[len(lines)-commitDedupeLines:]
	}
	for _, line := range lines {
		if strings.Contains(line, sha) {
			return true
		}
	}
	return false
}
