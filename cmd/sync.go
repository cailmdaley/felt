package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const syncGitTimeout = 2 * time.Minute

var syncPush bool

func init() {
	rootCmd.AddCommand(syncCmd)
	syncCmd.Flags().BoolVar(&syncPush, "push", false, "push the current branch to its configured tracking branch after syncing")
}

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Fetch and merge the felt store's configured upstream",
	Long: `Fetch and merge the configured upstream for the Git repository containing
the active felt store. A project .felt symlink syncs the repository it points
to. Sync refuses staged changes and in-progress Git operations. Unstaged and
untracked files stay in place; Git blocks a merge if it would overwrite them.
Use --push to push this branch to its
configured tracking branch after a successful merge.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := requireStore()
		if err != nil {
			return err
		}
		storeRoot, err := filepath.EvalSymlinks(storage.Root())
		if err != nil {
			return fmt.Errorf("resolving felt store path %s: %w", storage.Root(), err)
		}
		return syncStore(cmd.Context(), storeRoot, syncPush, cmd.OutOrStdout())
	},
}

func syncStore(parent context.Context, storeRoot string, push bool, output io.Writer) error {
	if parent == nil {
		parent = context.Background()
	}
	git := func(args ...string) (string, error) { return runSyncGit(parent, storeRoot, args...) }

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
	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"} {
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

func hasUnmergedIndex(git func(...string) (string, error)) bool {
	files, err := git("ls-files", "--unmerged")
	return err == nil && strings.TrimSpace(files) != ""
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
