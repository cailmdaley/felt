package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/cailmdaley/felt/internal/sysenv"
)

type ChangeStats struct {
	Files     int `json:"files"`
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
}

type ChangeChecks struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Pending int `json:"pending"`
}

type ChangePR struct {
	Number     int          `json:"number"`
	Title      string       `json:"title"`
	URL        string       `json:"url"`
	HeadBranch string       `json:"head_branch"`
	BaseBranch string       `json:"base_branch"`
	State      string       `json:"state"`
	Draft      bool         `json:"draft"`
	Mergeable  string       `json:"mergeable"`
	Checks     ChangeChecks `json:"checks"`
	// MergeCommit is set once the PR has merged; the change then spans that commit's first parent to itself.
	MergeCommit string `json:"merge_commit,omitempty"`
	// Body is the PR description; the bundle carries it as its description.
	Body string `json:"-"`
}

// ChangePRListing is one PR a constitution follows, read from GitHub without a
// bake: its metadata and line counts, or the error gh gave for it.
type ChangePRListing struct {
	ChangePR
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Error     string `json:"error,omitempty"`
}

// prView is what gh reports for a PR beyond ChangePR: what a bake fetches and a listing counts.
type prView struct {
	HeadRefOid           string
	Additions, Deletions int
}

// viewChangePR reads a PR through gh in repo.
func viewChangePR(env *sysenv.Env, repo string, number int) (*ChangePR, prView, error) {
	cmd := env.Command("gh", "pr", "view", fmt.Sprint(number), "--json", "number,title,body,url,headRefName,headRefOid,baseRefName,state,isDraft,mergeable,statusCheckRollup,mergeCommit,additions,deletions")
	cmd.Dir = repo
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, prView{}, fmt.Errorf("gh pr view %d: %s: %w", number, strings.TrimSpace(stderr.String()), err)
	}
	var raw struct {
		prView
		Number                                                       int
		Title, Body, URL, HeadRefName, BaseRefName, State, Mergeable string
		IsDraft                                                      bool
		StatusCheckRollup                                            []struct{ Status, Conclusion, State string }
		MergeCommit                                                  *struct{ Oid string }
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, prView{}, err
	}
	pr := &ChangePR{Number: raw.Number, Title: raw.Title, Body: raw.Body, URL: raw.URL, HeadBranch: raw.HeadRefName, BaseBranch: raw.BaseRefName, State: raw.State, Draft: raw.IsDraft, Mergeable: raw.Mergeable}
	if raw.State == "MERGED" && raw.MergeCommit != nil {
		pr.MergeCommit = raw.MergeCommit.Oid
	}
	for _, check := range raw.StatusCheckRollup {
		pr.Checks.Total++
		result := check.Conclusion
		if result == "" {
			result = check.State
		}
		switch result {
		case "SUCCESS", "NEUTRAL", "SKIPPED":
			pr.Checks.Passed++
		case "FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE":
			pr.Checks.Failed++
		default:
			pr.Checks.Pending++
		}
	}
	return pr, raw.prView, nil
}

// ListChangePRs reads each PR through gh, concurrently, in the order given.
// It fetches nothing.
func ListChangePRs(env *sysenv.Env, repo string, numbers []int) []ChangePRListing {
	listings := make([]ChangePRListing, len(numbers))
	var wg sync.WaitGroup
	for i, number := range numbers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pr, view, err := viewChangePR(env, repo, number)
			if err != nil {
				listings[i] = ChangePRListing{ChangePR: ChangePR{Number: number}, Error: err.Error()}
				return
			}
			listings[i] = ChangePRListing{ChangePR: *pr, Additions: view.Additions, Deletions: view.Deletions}
		}()
	}
	wg.Wait()
	return listings
}

// ResolveChangePR fetches GitHub's exact head and the PR's base into explicit refs.
// A merged PR's base already contains it, so its range is instead the merge commit's
// first parent to the merge commit, which holds the PR's changes for merge and squash merges alike.
func ResolveChangePR(env *sysenv.Env, repo string, number int) (*ChangePR, string, string, error) {
	pr, view, err := viewChangePR(env, repo, number)
	if err != nil {
		return nil, "", "", err
	}
	head := fmt.Sprintf("refs/shuttle/pr/%d/head", number)
	base := fmt.Sprintf("refs/shuttle/pr/%d/base", number)
	baseRepo, _, _ := strings.Cut(pr.URL, "/pull/")
	// Fetch by OID rather than a similarly named local or remote branch.
	refspecs := []string{"+" + view.HeadRefOid + ":" + head, "+refs/heads/" + pr.BaseBranch + ":" + base}
	if pr.MergeCommit != "" {
		refspecs = []string{"+" + pr.MergeCommit + ":" + head}
	}
	fetch := env.Command("git", append([]string{"-C", repo, "fetch", baseRepo}, refspecs...)...)
	if out, err := fetch.CombinedOutput(); err != nil {
		return nil, "", "", fmt.Errorf("fetch PR: %s: %w", strings.TrimSpace(string(out)), err)
	}
	if pr.MergeCommit != "" {
		if out, err := env.Command("git", "-C", repo, "update-ref", base, pr.MergeCommit+"^1").CombinedOutput(); err != nil {
			return nil, "", "", fmt.Errorf("merged PR base: %s: %w", strings.TrimSpace(string(out)), err)
		}
	}
	return pr, base, head, nil
}
