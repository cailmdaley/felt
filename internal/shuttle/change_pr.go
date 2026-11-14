package shuttle

import (
	"encoding/json"
	"fmt"
	"strings"

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
}

// ResolveChangePR fetches GitHub's exact head and the PR's base into explicit refs.
// A merged PR's base already contains it, so its range is instead the merge commit's
// first parent to the merge commit, which holds the PR's changes for merge and squash merges alike.
func ResolveChangePR(env *sysenv.Env, repo string, number int) (*ChangePR, string, string, error) {
	cmd := env.Command("gh", "pr", "view", fmt.Sprint(number), "--json", "number,title,url,headRefName,headRefOid,baseRefName,state,isDraft,mergeable,statusCheckRollup,mergeCommit")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		return nil, "", "", fmt.Errorf("gh pr view: %w", err)
	}
	var raw struct {
		Number                                                             int
		Title, URL, HeadRefName, HeadRefOid, BaseRefName, State, Mergeable string
		IsDraft                                                            bool
		StatusCheckRollup                                                  []struct{ Status, Conclusion, State string }
		MergeCommit                                                        *struct{ Oid string }
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, "", "", err
	}
	pr := &ChangePR{Number: raw.Number, Title: raw.Title, URL: raw.URL, HeadBranch: raw.HeadRefName, BaseBranch: raw.BaseRefName, State: raw.State, Draft: raw.IsDraft, Mergeable: raw.Mergeable}
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
	head := fmt.Sprintf("refs/shuttle/pr/%d/head", number)
	base := fmt.Sprintf("refs/shuttle/pr/%d/base", number)
	baseRepo, _, _ := strings.Cut(raw.URL, "/pull/")
	// Fetch by OID rather than a similarly named local or remote branch.
	refspecs := []string{"+" + raw.HeadRefOid + ":" + head, "+refs/heads/" + raw.BaseRefName + ":" + base}
	if raw.State == "MERGED" && raw.MergeCommit != nil {
		pr.MergeCommit = raw.MergeCommit.Oid
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
