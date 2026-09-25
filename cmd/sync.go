package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const syncGitTimeout = 2 * time.Minute

// syncConflictPathCap bounds the path lists an error message carries. Every
// conflicted path matters — an agent has to open each one — but a merge that
// collides on hundreds of files is a situation to describe, not to enumerate.
const syncConflictPathCap = 25

var (
	syncPush    bool
	syncVerbose bool
)

func init() {
	rootCmd.AddCommand(syncCmd)
	syncCmd.Flags().BoolVar(&syncPush, "push", false, "push the current branch to its configured tracking branch after syncing")
	syncCmd.Flags().BoolVarP(&syncVerbose, "verbose", "v", false, "pass Git's own fetch, merge, and push output through instead of the summary")
}

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Fetch and merge the felt store's configured upstream",
	Long: `Fetch and merge the configured upstream for the Git repository containing
the active felt store. A project .felt symlink syncs the repository it points
to. Sync refuses staged changes and in-progress Git operations. Unstaged and
untracked files stay in place; Git blocks a merge if it would overwrite them.
Use --push to push this branch to its
configured tracking branch after a successful merge.

Success is summarized in at most four lines — commits in, commits out, files
changed, local worktree state — because the caller is usually an agent whose
context the per-file Git listing would bury. Failures print Git's own text
verbatim, and a conflicted merge names every conflicted path. Use --verbose for
Git's fetch, merge, and push output, or --json for the same summary as a
record.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		// A sync that fails does so for a Git reason, not a usage reason, and the
		// flag block cobra would append is a dozen lines between the caller and
		// the error text. Silencing it here rather than on the command keeps
		// usage for the argument errors cobra raises before RunE.
		cmd.SilenceUsage = true
		storage, _, err := requireStore()
		if err != nil {
			return err
		}
		storeRoot, err := filepath.EvalSymlinks(storage.Root())
		if err != nil {
			return fmt.Errorf("resolving felt store path %s: %w", storage.Root(), err)
		}
		return syncStore(cmd.Context(), storeRoot, syncOptions{Push: syncPush, Verbose: syncVerbose, JSON: jsonOutput}, cmd.OutOrStdout())
	},
}

// syncReport is what one sync did, in the terms that decide what happens next:
// how much came in, how much is still waiting to go out, how much of the
// worktree moved, and how the merge landed.
type syncReport struct {
	Store        string `json:"store"`
	Branch       string `json:"branch"`
	Upstream     string `json:"upstream"`
	Result       string `json:"result"`
	CommitsIn    int    `json:"commits_in"`
	CommitsOut   int    `json:"commits_out"`
	FilesChanged int    `json:"files_changed"`
	Insertions   int    `json:"insertions"`
	Deletions    int    `json:"deletions"`
	Pushed       bool   `json:"pushed"`
	Modified     int    `json:"modified"`
	Untracked    int    `json:"untracked"`
}

const (
	syncResultCurrent     = "up-to-date"
	syncResultFastForward = "fast-forward"
	syncResultMerge       = "merge-commit"
)

// lines renders the report as the lines `felt sync` prints: a header naming the
// store and the branch pair, then one line each for anything that happened or
// is still pending. A sync with nothing to say is a single line.
func (r syncReport) lines() []string {
	header := fmt.Sprintf("felt sync %s (%s ← %s)", r.Store, r.Branch, r.Upstream)
	var body []string
	if r.CommitsIn > 0 {
		verb := "merged"
		if r.Result == syncResultFastForward {
			verb = "fast-forwarded"
		}
		body = append(body, fmt.Sprintf("  in:    %s %s, %s changed (+%d/-%d)",
			countNoun(r.CommitsIn, "commit"), verb, countNoun(r.FilesChanged, "file"), r.Insertions, r.Deletions))
	}
	switch {
	case r.Pushed && r.CommitsOut > 0:
		body = append(body, fmt.Sprintf("  out:   %s pushed to %s", countNoun(r.CommitsOut, "commit"), r.Upstream))
	case r.CommitsOut > 0:
		body = append(body, fmt.Sprintf("  out:   %s unpushed — publish with `felt sync --push`", countNoun(r.CommitsOut, "commit")))
	}
	if r.Modified > 0 || r.Untracked > 0 {
		body = append(body, fmt.Sprintf("  local: %d modified, %d untracked", r.Modified, r.Untracked))
	}
	if len(body) == 0 {
		return []string{header + ": already current"}
	}
	return append([]string{header}, body...)
}

func countNoun(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// syncOptions are the caller's choices about one sync: whether to publish, and
// which of the three output shapes to render.
type syncOptions struct {
	Push    bool
	Verbose bool
	JSON    bool
}

func syncStore(parent context.Context, storeRoot string, opts syncOptions, output io.Writer) error {
	if parent == nil {
		parent = context.Background()
	}
	push, verbose := opts.Push, opts.Verbose
	git := func(args ...string) (string, error) { return runSyncGit(parent, storeRoot, args...) }
	// Git's own chatter reaches the caller only under --verbose; the summary
	// path captures it so a failure can still quote it exactly.
	passThrough := func(text string) error {
		if !verbose || strings.TrimSpace(text) == "" {
			return nil
		}
		_, err := fmt.Fprintln(output, strings.TrimSpace(text))
		return err
	}
	quiet := func(args ...string) []string {
		if verbose {
			return args
		}
		return append(args, "--quiet")
	}

	topLevel, err := git("rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("finding the felt store's Git root: %w", err)
	}
	topLevel = strings.TrimSpace(topLevel)
	commonDir, err := git("rev-parse", "--git-common-dir")
	if err != nil {
		return fmt.Errorf("finding the Git metadata directory: %w", err)
	}
	commonDir = strings.TrimSpace(commonDir)
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(storeRoot, commonDir)
	}
	gitDir, err := git("rev-parse", "--git-dir")
	if err != nil {
		return fmt.Errorf("finding the Git worktree metadata directory: %w", err)
	}
	gitDir = strings.TrimSpace(gitDir)
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(storeRoot, gitDir)
	}
	unlock, err := lockSyncRepository(commonDir)
	if err != nil {
		return err
	}
	defer unlock()

	branch, err := git("symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		at := "an unknown commit"
		if head, headErr := git("rev-parse", "--short", "HEAD"); headErr == nil {
			at = strings.TrimSpace(head)
		}
		return fmt.Errorf("felt sync requires a checked-out branch; HEAD is detached at %s — `git switch <branch>` and retry", at)
	}
	branch = strings.TrimSpace(branch)
	tracking, err := git("for-each-ref", "--format=%(upstream:remotename)\n%(upstream:remoteref)", "refs/heads/"+branch)
	if err != nil {
		return fmt.Errorf("reading branch %q tracking configuration: %w", branch, err)
	}
	trackingParts := strings.Split(strings.TrimSpace(tracking), "\n")
	if len(trackingParts) != 2 {
		return fmt.Errorf("branch %q has no usable upstream; set one with `git branch --set-upstream-to` and retry", branch)
	}
	remote := strings.TrimSpace(trackingParts[0])
	mergeRef := strings.TrimSpace(trackingParts[1])
	if remote == "" || !strings.HasPrefix(mergeRef, "refs/heads/") {
		return fmt.Errorf("branch %q must track a remote branch to sync", branch)
	}
	if err := rejectGitOperationInProgress(git, gitDir); err != nil {
		return err
	}
	staged, err := git("diff", "--cached", "--name-only", "--")
	if err != nil {
		return fmt.Errorf("reading the felt store's staged changes: %w", err)
	}
	if paths := splitGitPaths(staged); len(paths) > 0 {
		return fmt.Errorf("felt store has staged changes (%s); commit or unstage them before `felt sync`:\n%s",
			countNoun(len(paths), "file"), indentGitPaths(paths))
	}

	report := syncReport{
		Store:    abbreviateHome(topLevel),
		Branch:   branch,
		Upstream: remote + "/" + strings.TrimPrefix(mergeRef, "refs/heads/"),
		Result:   syncResultCurrent,
	}

	if verbose {
		if _, err := fmt.Fprintf(output, "Fetching %s for %s…\n", remote, branch); err != nil {
			return err
		}
	}
	fetchOutput, err := git(quiet("fetch", "--no-tags", remote, mergeRef)...)
	if err != nil {
		return fmt.Errorf("fetching felt store upstream failed; sync did not complete: %w", err)
	}
	if err := passThrough(fetchOutput); err != nil {
		return err
	}

	before, err := git("rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("reading the current commit: %w", err)
	}
	before = strings.TrimSpace(before)

	mergeOutput, mergeErr := git(quiet("merge", "--ff", "--no-autostash", "--no-overwrite-ignore", "--no-edit", "FETCH_HEAD")...)
	if mergeErr != nil {
		if conflicts := unmergedPaths(git); len(conflicts) > 0 {
			return fmt.Errorf("upstream merge left %s conflicted; resolve and commit them, then retry `felt sync`:\n%s",
				countNoun(len(conflicts), "file"), indentGitPaths(conflicts))
		}
		return fmt.Errorf("merging felt store upstream failed: %w", mergeErr)
	}
	if err := passThrough(mergeOutput); err != nil {
		return err
	}

	after, err := git("rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("reading the merged commit: %w", err)
	}
	after = strings.TrimSpace(after)
	if report.CommitsIn, err = countCommits(git, before+"..FETCH_HEAD"); err != nil {
		return err
	}
	if report.CommitsOut, err = countCommits(git, "FETCH_HEAD.."+after); err != nil {
		return err
	}
	switch {
	case after == before:
		report.Result = syncResultCurrent
	case isAncestor(git, before, "FETCH_HEAD"):
		report.Result = syncResultFastForward
	default:
		report.Result = syncResultMerge
	}
	if after != before {
		if report.FilesChanged, report.Insertions, report.Deletions, err = diffMagnitude(git, before, after); err != nil {
			return err
		}
	}

	if push && report.CommitsOut > 0 {
		if verbose {
			if _, err := fmt.Fprintf(output, "Pushing %s to %s:%s…\n", branch, remote, strings.TrimPrefix(mergeRef, "refs/heads/")); err != nil {
				return err
			}
		}
		pushOutput, err := git(quiet("push", remote, "HEAD:"+mergeRef)...)
		if err != nil {
			return fmt.Errorf("push failed after local sync; upstream merge remains applied: %w", err)
		}
		if err := passThrough(pushOutput); err != nil {
			return err
		}
		report.Pushed = true
	}

	if report.Modified, report.Untracked, err = worktreeState(git); err != nil {
		return err
	}

	if opts.JSON {
		enc := json.NewEncoder(output)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	for _, line := range report.lines() {
		if _, err := fmt.Fprintln(output, line); err != nil {
			return err
		}
	}
	return nil
}

// countCommits counts the commits in a revision range.
func countCommits(git func(...string) (string, error), rangeSpec string) (int, error) {
	out, err := git("rev-list", "--count", rangeSpec)
	if err != nil {
		return 0, fmt.Errorf("counting commits in %s: %w", rangeSpec, err)
	}
	n, convErr := strconv.Atoi(strings.TrimSpace(out))
	if convErr != nil {
		return 0, fmt.Errorf("counting commits in %s: unexpected git output %q", rangeSpec, strings.TrimSpace(out))
	}
	return n, nil
}

// isAncestor reports whether ancestor is reachable from descendant, the
// predicate that separates a fast-forward from a merge commit: Git fast-forwards
// exactly when the branch tip already lies on the fetched history.
func isAncestor(git func(...string) (string, error), ancestor, descendant string) bool {
	_, err := git("merge-base", "--is-ancestor", ancestor, descendant)
	return err == nil
}

// diffMagnitude measures a revision pair as counts rather than a per-file
// listing. It reads --numstat rather than --shortstat because the numbers are
// columns, not a sentence git may translate.
func diffMagnitude(git func(...string) (string, error), old, new string) (files, insertions, deletions int, err error) {
	out, err := git("diff", "--numstat", old, new)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("measuring the merged change: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(strings.TrimRight(line, "\r"), "\t", 3)
		if len(fields) < 3 {
			continue
		}
		files++
		// A binary file reports "-" for both columns.
		if n, convErr := strconv.Atoi(fields[0]); convErr == nil {
			insertions += n
		}
		if n, convErr := strconv.Atoi(fields[1]); convErr == nil {
			deletions += n
		}
	}
	return files, insertions, deletions, nil
}

// worktreeState counts the local changes a sync leaves in place: tracked files
// with unstaged edits, and untracked entries as `git status` collapses them.
func worktreeState(git func(...string) (string, error)) (modified, untracked int, err error) {
	out, err := git("status", "--porcelain")
	if err != nil {
		return 0, 0, fmt.Errorf("reading the felt store's worktree state: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.TrimSpace(line) == "":
		case strings.HasPrefix(line, "??"):
			untracked++
		default:
			modified++
		}
	}
	return modified, untracked, nil
}

func rejectGitOperationInProgress(git func(...string) (string, error), gitDir string) error {
	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"} {
		if _, err := os.Stat(filepath.Join(gitDir, marker)); err == nil {
			if conflicts := unmergedPaths(git); len(conflicts) > 0 {
				return fmt.Errorf("Git operation %q is in progress with %s still conflicted; resolve and commit them, then retry `felt sync`:\n%s",
					marker, countNoun(len(conflicts), "file"), indentGitPaths(conflicts))
			}
			return fmt.Errorf("Git operation %q is in progress; finish or abort it, then retry `felt sync`", marker)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("checking Git operation state %q: %w", marker, err)
		}
	}
	if conflicts := unmergedPaths(git); len(conflicts) > 0 {
		return fmt.Errorf("Git index has %s unresolved; resolve and commit them, then retry `felt sync`:\n%s",
			countNoun(len(conflicts), "conflict"), indentGitPaths(conflicts))
	}
	return nil
}

// unmergedPaths lists the paths carrying conflict stages, one entry per path.
func unmergedPaths(git func(...string) (string, error)) []string {
	out, err := git("diff", "--name-only", "--diff-filter=U", "--")
	if err != nil {
		return nil
	}
	return splitGitPaths(out)
}

func splitGitPaths(out string) []string {
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			paths = append(paths, trimmed)
		}
	}
	return paths
}

func indentGitPaths(paths []string) string {
	shown := paths
	var tail string
	if len(shown) > syncConflictPathCap {
		shown = shown[:syncConflictPathCap]
		tail = fmt.Sprintf("\n  … and %d more", len(paths)-syncConflictPathCap)
	}
	return "  " + strings.Join(shown, "\n  ") + tail
}

// abbreviateHome shortens a path under the user's home directory to a ~ form,
// so the header names the store without spending a line on it.
func abbreviateHome(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if strings.HasPrefix(path, home+string(os.PathSeparator)) {
		return "~" + path[len(home):]
	}
	return path
}

func runSyncGit(parent context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, syncGitTimeout)
	defer cancel()
	fullArgs := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	if ctx.Err() != nil {
		return output.String(), fmt.Errorf("git %s timed out after %s", strings.Join(args, " "), syncGitTimeout)
	}
	if err != nil {
		return output.String(), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(output.String()))
	}
	return output.String(), nil
}
