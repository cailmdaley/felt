package shuttlecli

import (
	"encoding/json"
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

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

func (a *app) createRemoteFiber(owner string, f *felt.Felt, block *shuttle.Block) error {
	response, err := a.postOwnerFiberCreate(owner, remoteFiberCreatePayload(f, block))
	if err != nil {
		return err
	}
	var created struct {
		ID  string `json:"id"`
		UID string `json:"uid"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		return fmt.Errorf("parsing create response from %s: %w", owner, err)
	}
	if created.ID != f.ID || created.UID != f.UID {
		return fmt.Errorf("owner %s created %s with uid %s; expected uid %s", owner, created.ID, created.UID, f.UID)
	}
	return nil
}
