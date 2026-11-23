package feltcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

const syncGitTimeout = 2 * time.Minute

type syncFFReport struct {
	Repos []syncFFRepoResult `json:"repos"`
}

type syncFFRepoResult struct {
	Path        string `json:"path"`
	Status      string `json:"status"`
	Upstream    string `json:"upstream,omitempty"`
	Ahead       *int   `json:"ahead,omitempty"`
	Behind      *int   `json:"behind,omitempty"`
	PreviousSHA string `json:"previous_sha,omitempty"`
	SHA         string `json:"sha,omitempty"`
	Commits     int    `json:"commits,omitempty"`
	SyncedAt    string `json:"synced_at,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

func (a *app) syncCmd() *cobra.Command {
	var syncPush bool
	var ffOnly bool
	var fetchTimeout time.Duration
	command := &cobra.Command{
		Use:   "sync",
		Short: "Merge the store's Git upstream; --push publishes committed work",
		Long: `Fetches the tracking branch of the repository that holds the store and merges
it into the checked-out branch. A project .felt that is a symlink syncs the
repository it points into.

A directory inside the store that is a symlink into another Git repository's
.felt mounts that repository's fibers in the store. After its own repository, sync
runs the same sync in each mounted repository, once per repository and at any
depth, naming each one. A symlink to a directory outside Git mounts nothing.
A mounted repository whose branch tracks no remote branch is skipped with a
note; one that fails is reported by its path after the others have run, and
sync exits non-zero. Sync commits nothing in a mounted repository either: it
says when one holds uncommitted fiber changes, which are committed there.

sync never stages, stashes, or force-pushes, and commits nothing of yours; a
diverged upstream makes a merge commit. It refuses to start with
staged changes, unresolved conflicts, or a merge, rebase, cherry-pick, revert,
or bisect in progress. Unstaged and untracked files stay put unless the merge
would overwrite them, in which case Git stops it. A merge that conflicts is
left for you to resolve and commit. --push then pushes the branch to its
tracking branch. --fetch-timeout bounds the network fetch only; the local merge
runs to completion without a hard deadline, so a slow filesystem cannot leave a
killed merge holding the Git index lock.

--ff-only runs a strict fast-forward pass: it fetches the tracking branch and
runs git merge --ff-only only when the working tree is completely clean (no
staged, unstaged, or untracked files), no Git operation is in progress, and the
branch has zero local commits ahead of upstream. Any other state is left
untouched and reported with its reason (use --json for structured output).

Sync ends by naming every fiber in the store whose frontmatter no longer
parses, and then exits non-zero although the merge and push completed: such a
fiber is invisible to every listing, board and daemon until it is fixed.`,
		Example: `  felt sync                   before substantive work
  felt sync --push            after committing
  felt sync --ff-only --json  fast-forward clean store repos only`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if fetchTimeout <= 0 {
				return fmt.Errorf("--fetch-timeout must be positive")
			}
			if ffOnly && syncPush {
				return fmt.Errorf("--ff-only cannot be combined with --push")
			}
			storage, _, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			storeRoot, err := filepath.EvalSymlinks(storage.Root())
			if err != nil {
				return fmt.Errorf("resolving felt store path %s: %w", storage.Root(), err)
			}
			if ffOnly {
				report := a.syncStoreAndMountsFFOnly(cmd.Context(), storeRoot, fetchTimeout)
				if a.json {
					return a.outputJSON(report)
				}
				for _, r := range report.Repos {
					if r.Reason != "" {
						fmt.Fprintf(a.env.Stdout, "%s: %s (%s)\n", r.Path, r.Status, r.Reason)
					} else {
						fmt.Fprintf(a.env.Stdout, "%s: %s\n", r.Path, r.Status)
					}
				}
				return nil
			}
			err = a.syncStoreAndMounts(cmd.Context(), storeRoot, syncPush, fetchTimeout, a.env.Stdout)
			return errors.Join(err, reportUnreadable(storage, a.env.Stdout))
		},
	}
	command.GroupID = groupStore
	command.Flags().BoolVar(&syncPush, "push", false, "Push the branch to its tracking branch after a successful merge")
	command.Flags().BoolVar(&ffOnly, "ff-only", false, "Fast-forward clean store repositories with zero local commits ahead; leave all others untouched")
	command.Flags().DurationVar(&fetchTimeout, "fetch-timeout", syncGitTimeout, "Deadline for the network fetch only; local merge has no hard deadline")
	return command
}

// syncStoreAndMounts syncs the repository holding storeRoot, then each
// repository mounted in the store. A store-repository failure is returned as
// is; mounted-repository failures carry the repository's path, and every
// mount is attempted before any failure is returned.
func (a *app) syncStoreAndMounts(parent context.Context, storeRoot string, push bool, fetchTimeout time.Duration, output io.Writer) error {
	var failures []error
	if err := a.syncStore(parent, storeRoot, push, fetchTimeout, output); err != nil {
		failures = append(failures, err)
	}
	for _, mount := range a.mountedRepositories(parent, storeRoot) {
		if _, err := fmt.Fprintf(output, "Syncing %s, mounted at %s…\n", mount.repo, mount.at); err != nil {
			return err
		}
		err := a.syncStore(parent, mount.repo, push, fetchTimeout, output)
		var noUpstream *noUpstreamError
		switch {
		case errors.As(err, &noUpstream):
			if _, err := fmt.Fprintf(output, "Skipped %s: %s\n", mount.repo, noUpstream); err != nil {
				return err
			}
		case err != nil:
			failures = append(failures, fmt.Errorf("syncing %s, mounted at %s: %w", mount.repo, mount.at, err))
		}
		// The store's own `git add .felt` stops at the link, so work in a
		// mounted repository is committed there or not at all.
		if dirty, _ := a.runSyncGit(parent, mount.repo, syncGitTimeout, "status", "--porcelain", "--", felt.DirName); strings.TrimSpace(dirty) != "" {
			n := len(strings.Split(strings.TrimSpace(dirty), "\n"))
			if _, err := fmt.Fprintf(output, "%s has %d uncommitted change(s) under %s: commit them in that repository, then sync again to publish.\n", mount.repo, n, felt.DirName); err != nil {
				return err
			}
		}
	}
	return errors.Join(failures...)
}

// reportUnreadable ends a sync by naming each fiber in the store that no
// listing can read, whoever broke it and however it arrived. Such a fiber
// vanishes from every view and from dispatch on every host that holds it, so
// this is the sync's last word and its exit status, though the merge and push
// themselves completed.
func reportUnreadable(storage *felt.Storage, output io.Writer) error {
	broken, err := storage.FindUnreadable()
	if err != nil || len(broken) == 0 {
		return nil
	}
	lines := make([]string, 0, len(broken))
	for _, u := range broken {
		lines = append(lines, fmt.Sprintf("  %s\n    %s", u.Path, u.Error))
	}
	if _, err := fmt.Fprintf(output, "\n✗ %d fiber(s) in this store cannot be read by any felt or shuttle command: every listing, board and daemon skips them until their frontmatter parses.\n%s\n", len(broken), strings.Join(lines, "\n")); err != nil {
		return err
	}
	return fmt.Errorf("sync completed, but %d fiber(s) cannot be read; fix the frontmatter above, commit, and sync again", len(broken))
}

// syncMount is a Git repository other than the store's own whose files a
// symlinked directory places inside the store.
type syncMount struct {
	repo string // the repository's top-level directory
	at   string // the symlink's slash-separated path inside the store
}

// mountedRepositories finds the repositories mounted in the store at
// storeRoot: a walk that does not descend through symlinks, so each symlinked
// directory is met as an entry, then walks on into its target to find mounts
// nested inside it. Each repository is listed once, at the first place the
// walk meets it, and the store's own repository not at all. A target outside
// Git or inside the store's own repository is not a mount and is not walked.
func (a *app) mountedRepositories(parent context.Context, storeRoot string) []syncMount {
	toplevel := func(dir string) string {
		out, err := a.runSyncGit(parent, dir, syncGitTimeout, "rev-parse", "--show-toplevel")
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out)
	}
	own := toplevel(storeRoot)
	seen := map[string]bool{}
	walked := map[string]bool{}
	var mounts []syncMount
	var walk func(base, prefix string)
	walk = func(base, prefix string) {
		if walked[base] {
			return
		}
		walked[base] = true
		_ = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() && d.Name() == ".git" {
				return filepath.SkipDir
			}
			if d.Type()&fs.ModeSymlink == 0 {
				return nil
			}
			target, err := filepath.EvalSymlinks(p)
			if err != nil {
				return nil
			}
			if info, err := os.Stat(target); err != nil || !info.IsDir() {
				return nil
			}
			if !slices.Contains(strings.Split(filepath.ToSlash(target), "/"), felt.DirName) {
				return nil
			}
			rel, err := filepath.Rel(base, p)
			if err != nil {
				return nil
			}
			at := path.Join(prefix, filepath.ToSlash(rel))
			repo := toplevel(target)
			if repo == "" || repo == own {
				return nil
			}
			if !seen[repo] {
				seen[repo] = true
				mounts = append(mounts, syncMount{repo: repo, at: at})
			}
			walk(target, at)
			return nil
		})
	}
	walk(storeRoot, "")
	return mounts
}

// noUpstreamError is a branch with no remote branch to sync with.
type noUpstreamError struct{ reason string }

func (e *noUpstreamError) Error() string { return e.reason }

func (a *app) syncStore(parent context.Context, storeRoot string, push bool, fetchTimeout time.Duration, output io.Writer) error {
	if parent == nil {
		parent = context.Background()
	}
	git := func(args ...string) (string, error) {
		timeout := syncGitTimeout
		switch args[0] {
		case "fetch":
			timeout = fetchTimeout
		case "merge":
			timeout = 0 // Never cancel a local Git mutation while it holds index.lock.
		}
		return a.runSyncGit(parent, storeRoot, timeout, args...)
	}

	if _, err := git("rev-parse", "--show-toplevel"); err != nil {
		return fmt.Errorf("finding the felt store's Git root: %w", err)
	}
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
		return fmt.Errorf("felt sync requires a checked-out branch: %w", err)
	}
	branch = strings.TrimSpace(branch)
	tracking, err := git("for-each-ref", "--format=%(upstream:remotename)\n%(upstream:remoteref)", "refs/heads/"+branch)
	if err != nil {
		return fmt.Errorf("reading branch %q tracking configuration: %w", branch, err)
	}
	trackingParts := strings.Split(strings.TrimSpace(tracking), "\n")
	if len(trackingParts) != 2 {
		return &noUpstreamError{fmt.Sprintf("branch %q has no usable upstream; set one with `git branch --set-upstream-to` and retry", branch)}
	}
	remote := strings.TrimSpace(trackingParts[0])
	mergeRef := strings.TrimSpace(trackingParts[1])
	if remote == "" || !strings.HasPrefix(mergeRef, "refs/heads/") {
		return &noUpstreamError{fmt.Sprintf("branch %q must track a remote branch to sync", branch)}
	}
	if err := rejectGitOperationInProgress(git, gitDir); err != nil {
		return err
	}
	_, err = git("diff", "--cached", "--quiet", "--")
	if err != nil {
		return fmt.Errorf("felt store has staged changes; commit or unstage them before `felt sync`: %w", err)
	}

	if _, err := fmt.Fprintf(output, "Fetching %s for %s…\n", remote, branch); err != nil {
		return err
	}
	if _, err := git("fetch", "--no-tags", remote, mergeRef); err != nil {
		return fmt.Errorf("fetching felt store upstream failed; sync did not complete: %w", err)
	}
	mergeOutput, mergeErr := git("merge", "--ff", "--no-autostash", "--no-overwrite-ignore", "--no-edit", "FETCH_HEAD")
	if mergeErr != nil {
		if hasUnmergedIndex(git) {
			return fmt.Errorf("upstream merge has conflicts; resolve and commit them, then retry `felt sync`: %s", strings.TrimSpace(mergeOutput))
		}
		return fmt.Errorf("merging felt store upstream failed: %w: %s", mergeErr, strings.TrimSpace(mergeOutput))
	}
	if strings.TrimSpace(mergeOutput) != "" {
		if _, err := fmt.Fprintln(output, strings.TrimSpace(mergeOutput)); err != nil {
			return err
		}
	}
	if push {
		if _, err := fmt.Fprintf(output, "Pushing %s to %s:%s…\n", branch, remote, strings.TrimPrefix(mergeRef, "refs/heads/")); err != nil {
			return err
		}
		if pushOutput, err := git("push", remote, "HEAD:"+mergeRef); err != nil {
			return fmt.Errorf("push failed after local sync; upstream merge remains applied: %w: %s", err, strings.TrimSpace(pushOutput))
		} else if strings.TrimSpace(pushOutput) != "" {
			if _, err := fmt.Fprintln(output, strings.TrimSpace(pushOutput)); err != nil {
				return err
			}
		}
	}
	return nil
}

func rejectGitOperationInProgress(git func(...string) (string, error), gitDir string) error {
	for _, marker := range []string{"MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"} {
		if _, err := os.Stat(filepath.Join(gitDir, marker)); err == nil {
			return fmt.Errorf("Git operation %q is in progress; finish or abort it, then retry `felt sync`", marker)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("checking Git operation state %q: %w", marker, err)
		}
	}
	if hasUnmergedIndex(git) {
		return fmt.Errorf("Git index has unresolved conflicts; resolve and commit them, then retry `felt sync`")
	}
	return nil
}

func (a *app) syncStoreAndMountsFFOnly(parent context.Context, storeRoot string, fetchTimeout time.Duration) syncFFReport {
	if parent == nil {
		parent = context.Background()
	}
	seen := map[string]bool{}
	var repos []string
	addRepo := func(dir string) {
		out, err := a.runSyncGit(parent, dir, syncGitTimeout, "rev-parse", "--show-toplevel")
		if err != nil {
			return
		}
		root := strings.TrimSpace(out)
		if root == "" {
			return
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		if !seen[root] {
			seen[root] = true
			repos = append(repos, root)
		}
	}
	addRepo(storeRoot)
	for _, mount := range a.mountedRepositories(parent, storeRoot) {
		addRepo(mount.repo)
	}
	results := make([]syncFFRepoResult, 0, len(repos))
	for _, repo := range repos {
		results = append(results, a.syncStoreFFOnly(parent, repo, fetchTimeout))
	}
	return syncFFReport{Repos: results}
}

func (a *app) syncStoreFFOnly(parent context.Context, repo string, fetchTimeout time.Duration) syncFFRepoResult {
	if parent == nil {
		parent = context.Background()
	}
	git := func(args ...string) (string, error) {
		timeout := syncGitTimeout
		switch args[0] {
		case "fetch":
			timeout = fetchTimeout
		case "merge":
			timeout = 0 // Never cancel a local Git mutation while it holds index.lock.
		}
		return a.runSyncGit(parent, repo, timeout, args...)
	}

	commonDir, err := git("rev-parse", "--git-common-dir")
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Reason: conciseSyncError(err)}
	}
	commonDir = strings.TrimSpace(commonDir)
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(repo, commonDir)
	}
	gitDir, err := git("rev-parse", "--git-dir")
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Reason: conciseSyncError(err)}
	}
	gitDir = strings.TrimSpace(gitDir)
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(repo, gitDir)
	}
	unlock, err := lockSyncRepository(commonDir)
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Reason: conciseSyncError(err)}
	}
	defer unlock()

	branch, err := git("symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "no_upstream", Reason: "detached HEAD or no upstream configured"}
	}
	branch = strings.TrimSpace(branch)
	tracking, err := git("for-each-ref", "--format=%(upstream:remotename)\n%(upstream:remoteref)\n%(upstream)\n%(upstream:short)", "refs/heads/"+branch)
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Reason: conciseSyncError(err)}
	}
	parts := strings.Split(strings.TrimRight(tracking, "\n"), "\n")
	if len(parts) < 4 {
		return syncFFRepoResult{Path: repo, Status: "no_upstream", Reason: "detached HEAD or no upstream configured"}
	}
	remote := strings.TrimSpace(parts[0])
	mergeRef := strings.TrimSpace(parts[1])
	upstreamRef := strings.TrimSpace(parts[2])
	upstreamShort := strings.TrimSpace(parts[3])
	if remote == "" || !strings.HasPrefix(mergeRef, "refs/heads/") {
		return syncFFRepoResult{Path: repo, Status: "no_upstream", Reason: "detached HEAD or no upstream configured"}
	}

	refspec := mergeRef
	if upstreamRef != "" {
		refspec = "+" + mergeRef + ":" + upstreamRef
	}
	if _, err := git("fetch", "--quiet", "--no-tags", remote, refspec); err != nil {
		return syncFFRepoResult{Path: repo, Status: "fetch_failed", Upstream: upstreamShort, Reason: conciseSyncError(err)}
	}

	countsOut, err := git("rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD")
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Upstream: upstreamShort, Reason: conciseSyncError(err)}
	}
	fields := strings.Fields(countsOut)
	if len(fields) != 2 {
		return syncFFRepoResult{Path: repo, Status: "error", Upstream: upstreamShort, Reason: "unexpected rev-list count: " + strings.TrimSpace(countsOut)}
	}
	ahead, err1 := strconv.Atoi(fields[0])
	behind, err2 := strconv.Atoi(fields[1])
	if err1 != nil || err2 != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Upstream: upstreamShort, Reason: "unexpected rev-list count: " + strings.TrimSpace(countsOut)}
	}

	if err := rejectGitOperationInProgress(git, gitDir); err != nil {
		return syncFFRepoResult{Path: repo, Status: "stale_dirty", Upstream: upstreamShort, Ahead: &ahead, Behind: &behind, Reason: "git operation in progress"}
	}
	statusOut, err := git("status", "--porcelain")
	if err != nil {
		return syncFFRepoResult{Path: repo, Status: "error", Upstream: upstreamShort, Ahead: &ahead, Behind: &behind, Reason: conciseSyncError(err)}
	}
	if statusOut != "" {
		return syncFFRepoResult{Path: repo, Status: "stale_dirty", Upstream: upstreamShort, Ahead: &ahead, Behind: &behind, Reason: "working tree has uncommitted changes"}
	}

	zero := 0
	switch {
	case ahead == 0 && behind == 0:
		return syncFFRepoResult{Path: repo, Status: "up_to_date", Upstream: upstreamShort, Ahead: &zero, Behind: &zero}

	case ahead == 0 && behind > 0:
		prevOut, _ := git("rev-parse", "--short", "HEAD")
		prevSHA := strings.TrimSpace(prevOut)
		if _, err := git("merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", "FETCH_HEAD"); err != nil {
			return syncFFRepoResult{Path: repo, Status: "stale_dirty", Upstream: upstreamShort, Ahead: &zero, Behind: &behind, Reason: conciseSyncError(err)}
		}
		newOut, _ := git("rev-parse", "--short", "HEAD")
		newSHA := strings.TrimSpace(newOut)
		return syncFFRepoResult{
			Path:        repo,
			Status:      "fast_forwarded",
			Upstream:    upstreamShort,
			Ahead:       &zero,
			Behind:      &zero,
			PreviousSHA: prevSHA,
			SHA:         newSHA,
			Commits:     behind,
			SyncedAt:    time.Now().UTC().Format(time.RFC3339),
		}

	case ahead > 0 && behind == 0:
		return syncFFRepoResult{
			Path:     repo,
			Status:   "ahead",
			Upstream: upstreamShort,
			Ahead:    &ahead,
			Behind:   &zero,
			Reason:   fmt.Sprintf("%d local commit(s) ahead of %s", ahead, upstreamShort),
		}

	default:
		return syncFFRepoResult{
			Path:     repo,
			Status:   "stale_diverged",
			Upstream: upstreamShort,
			Ahead:    &ahead,
			Behind:   &behind,
			Reason:   fmt.Sprintf("branch has diverged (%d ahead, %d behind %s)", ahead, behind, upstreamShort),
		}
	}
}

func conciseSyncError(err error) string {
	msg := strings.TrimSpace(err.Error())
	if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
		msg = strings.TrimSpace(msg[:idx])
	}
	if len(msg) > 240 {
		return msg[:240]
	}
	return msg
}

func hasUnmergedIndex(git func(...string) (string, error)) bool {
	files, err := git("ls-files", "--unmerged")
	return err == nil && strings.TrimSpace(files) != ""
}

func (a *app) runSyncGit(parent context.Context, dir string, timeout time.Duration, args ...string) (string, error) {
	ctx := context.WithoutCancel(parent)
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, timeout)
		defer cancel()
	}
	fullArgs := append([]string{"--no-optional-locks", "-C", dir}, args...)
	cmd := a.env.CommandContext(ctx, "git", fullArgs...)
	if a.env.Getenv("GIT_TERMINAL_PROMPT") == "" {
		cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0")
	}
	if args[0] == "fetch" || args[0] == "push" {
		if a.env.Getenv("GIT_SSH_COMMAND") == "" {
			cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=15")
		}
		cancelSyncNetworkTree(cmd)
		cmd.WaitDelay = time.Second
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	if ctx.Err() != nil {
		return output.String(), fmt.Errorf("git %s timed out after %s", strings.Join(args, " "), timeout)
	}
	if err != nil {
		return output.String(), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(output.String()))
	}
	return output.String(), nil
}
