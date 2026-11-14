package shuttle

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// UncommittedSubject is the message of the commit that snapshots a worktree's
// uncommitted work.
const UncommittedSubject = "Uncommitted changes"

// untrackedLimit leaves larger untracked files out of a worktree snapshot.
const untrackedLimit = 1 << 20

// DefaultChangeBase is the remote's default branch: origin/HEAD's target,
// else origin/main, else origin/master.
func DefaultChangeBase(env *sysenv.Env, repo string) (string, error) {
	if env.Command("git", "-C", repo, "rev-parse", "--git-dir").Run() != nil {
		return "", fmt.Errorf("%s is not a Git repository", repo)
	}
	if out, err := env.Command("git", "-C", repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").Output(); err == nil {
		return strings.TrimSpace(string(out)), nil
	}
	for _, ref := range []string{"origin/main", "origin/master"} {
		if env.Command("git", "-C", repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Run() == nil {
			return ref, nil
		}
	}
	return "", fmt.Errorf("no base found in %s: it has no origin/HEAD, origin/main or origin/master; set shuttle.change.base", repo)
}

// SnapshotWorktree returns a commit holding the worktree as it stands: HEAD
// plus tracked edits and untracked, non-ignored files up to 1 MiB. It stages
// through a copy of the index, so the worktree's own index and refs are never
// touched. With no uncommitted work it returns "HEAD". The commit takes HEAD's
// identity and date, so the same work snapshots to the same commit.
func SnapshotWorktree(env *sysenv.Env, repo string) (string, error) {
	scratch, err := os.MkdirTemp("", "shuttle-index-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(scratch)
	index := filepath.Join(scratch, "index")
	git := func(stdin string, args ...string) (string, error) {
		cmd := env.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(env.Environ(), "GIT_INDEX_FILE="+index, "GIT_LITERAL_PATHSPECS=1")
		cmd.Stdin = strings.NewReader(stdin)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(stderr.String()), err)
		}
		return strings.TrimSpace(string(out)), nil
	}
	// The real index's path, asked without GIT_INDEX_FILE, which would name the copy.
	real, err := env.Command("git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "index").Output()
	if err != nil {
		return "", fmt.Errorf("%s is not a Git repository: %w", repo, err)
	}
	if data, err := os.ReadFile(strings.TrimSpace(string(real))); err == nil {
		if err := os.WriteFile(index, data, 0600); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	} else if _, err := git("", "read-tree", "HEAD"); err != nil {
		return "", err
	}
	if _, err := git("", "add", "--update"); err != nil {
		return "", err
	}
	top, err := git("", "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	untracked, err := git("", "-C", top, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}
	var small []string
	for _, path := range strings.Split(untracked, "\x00") {
		if path == "" {
			continue
		}
		if info, err := os.Lstat(filepath.Join(top, path)); err == nil && info.Size() <= untrackedLimit {
			small = append(small, path)
		}
	}
	if len(small) > 0 {
		if _, err := git(strings.Join(small, "\x00"), "-C", top, "add", "--pathspec-from-file=-", "--pathspec-file-nul"); err != nil {
			return "", err
		}
	}
	tree, err := git("", "write-tree")
	if err != nil {
		return "", err
	}
	head, err := git("", "show", "-s", "--format=%T%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd", "--date=raw", "HEAD")
	if err != nil {
		return "", err
	}
	fields := strings.Split(head, "\x00")
	if fields[0] == tree {
		return "HEAD", nil
	}
	cmd := env.Command("git", "-C", repo, "commit-tree", tree, "-p", "HEAD", "-m", UncommittedSubject)
	cmd.Env = append(env.Environ(),
		"GIT_AUTHOR_NAME="+fields[1], "GIT_AUTHOR_EMAIL="+fields[2], "GIT_AUTHOR_DATE="+fields[3],
		"GIT_COMMITTER_NAME="+fields[4], "GIT_COMMITTER_EMAIL="+fields[5], "GIT_COMMITTER_DATE="+fields[6])
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git commit-tree: %s: %w", strings.TrimSpace(stderr.String()), err)
	}
	return strings.TrimSpace(string(out)), nil
}
