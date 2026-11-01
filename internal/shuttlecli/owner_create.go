package shuttlecli

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// ownerCreateResponseError marks failures after the create POST was accepted.
// remoteRouteError uses the response-read prefix to retain its uncertainty
// path, so callers are told to inspect the owner before retrying.
type ownerCreateResponseError struct {
	owner string
	fiber string
	err   error
}

func (e ownerCreateResponseError) Error() string {
	return fmt.Sprintf("reading daemon response after creating fiber %s on %s: %v; the fiber may already exist, inspect it on %s before retrying", e.fiber, e.owner, e.err, e.owner)
}

func (e ownerCreateResponseError) Unwrap() error { return e.err }

func remoteFiberCreatePayload(f *felt.Felt, block *shuttle.Block) map[string]any {
	frontmatter := map[string]any{"name": f.Name, "status": f.Status, "tags": f.Tags}
	if f.Outcome != "" {
		frontmatter["outcome"] = f.Outcome
	}
	if f.Due != nil {
		frontmatter["due"] = f.Due.Format("2006-01-02")
	}
	if f.Description != "" {
		frontmatter["description"] = f.Description
	}
	if !f.CreatedAt.IsZero() {
		frontmatter["created-at"] = f.CreatedAt
	}
	if f.UpdatedAt != nil {
		frontmatter["updated-at"] = f.UpdatedAt
	}
	if f.ClosedAt != nil {
		frontmatter["closed-at"] = f.ClosedAt
	}
	for key, node := range f.ExtraFields {
		if key == "shuttle" || node == nil {
			continue
		}
		var value any
		if node.Decode(&value) == nil {
			frontmatter[key] = value
		}
	}
	frontmatter["shuttle"] = block
	return map[string]any{
		"id": f.ID, "uid": f.UID, "name": f.Name, "body": f.Body,
		"frontmatter": frontmatter,
	}
}

type movedDraftError struct{ message string }

func (e movedDraftError) Error() string { return e.message }

// moveRemoteDraft removes the source only after the owner confirms creation.
func (a *app) moveRemoteDraft(owner string, f *felt.Felt, block *shuttle.Block) error {
	path, err := a.createRemoteFiberWithPath(owner, f, block)
	if err != nil {
		return err
	}
	if path == "" {
		return movedDraftError{fmt.Sprintf("created %s on %s, but the owner returned no path; local draft retained", f.ID, owner)}
	}
	localInfo, err := os.Stat(f.Path)
	if err != nil {
		return movedDraftError{fmt.Sprintf("created %s on %s, but cannot inspect local draft: %v", f.ID, owner, err)}
	}
	ownerInfo, err := os.Stat(path)
	if err != nil && !os.IsNotExist(err) {
		return movedDraftError{fmt.Sprintf("created %s on %s, but cannot inspect owner path: %v", f.ID, owner, err)}
	}
	if err != nil || !os.SameFile(localInfo, ownerInfo) {
		if err := os.Remove(f.Path); err != nil {
			return movedDraftError{fmt.Sprintf("created %s on %s, but cannot remove local draft: %v", f.ID, owner, err)}
		}
	}
	fmt.Fprintf(a.env.Stdout, "created %s on %s from its local draft and armed it\n", f.ID, owner)
	return nil
}

func (a *app) createRemoteFiber(owner string, f *felt.Felt, block *shuttle.Block) error {
	_, err := a.createRemoteFiberWithPath(owner, f, block)
	return err
}

func (a *app) createRemoteFiberWithPath(owner string, f *felt.Felt, block *shuttle.Block) (string, error) {
	response, err := a.postOwnerFiberCreate(owner, remoteFiberCreatePayload(f, block))
	if err != nil {
		return "", err
	}
	var created struct {
		ID   string `json:"id"`
		UID  string `json:"uid"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		return "", ownerCreateResponseError{owner: owner, fiber: f.ID, err: fmt.Errorf("invalid create response: %w", err)}
	}
	if created.ID != f.ID || (f.UID != "" && created.UID != f.UID) {
		return "", ownerCreateResponseError{
			owner: owner, fiber: f.ID,
			err: fmt.Errorf("owner returned id %q and uid %q; expected id %q and uid %q", created.ID, created.UID, f.ID, f.UID),
		}
	}
	if f.UID == "" {
		if !felt.LooksLikeUID(created.UID) || created.UID != strings.ToUpper(created.UID) {
			return "", ownerCreateResponseError{
				owner: owner, fiber: f.ID,
				err: fmt.Errorf("owner returned no canonical intrinsic UID (got %q)", created.UID),
			}
		}
		f.UID = created.UID
	}
	return created.Path, nil
}
