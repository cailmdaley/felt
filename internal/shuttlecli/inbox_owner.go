package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/messaging"
	"io"
	"strings"
	"time"
)

func rawInboxKey(ref string) bool {
	return strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "shuttle://") || ref == "threads"
}
func scheduledEntries(entries []messaging.PendingEntry) []messaging.PendingEntry {
	out := []messaging.PendingEntry{}
	for _, e := range entries {
		if e.NotBefore != "" {
			out = append(out, e)
		}
	}
	return out
}
func (a *app) listInbox(ref string, scheduled bool) ([]messaging.PendingEntry, error) {
	var entries []messaging.PendingEntry
	var err error
	f, _ := a.messageFiber(ref)
	if rawInboxKey(ref) || f == nil {
		entries, err = messaging.PendingEntries(a.env, ref)
	} else {
		entries, err = a.ownerInbox(ref, "list", "")
	}
	if scheduled {
		entries = scheduledEntries(entries)
	}
	for i := range entries {
		at, parseErr := time.Parse(time.RFC3339, entries[i].NotBefore)
		if parseErr == nil && !at.After(time.Now()) && entries[i].Waiting == "" {
			entries[i].Waiting = "awaiting consumer or hook; use the fiber reference for its owner's launch-gate reason"
		}
	}
	return entries, err
}
func (a *app) ownerInbox(ref, action, id string) ([]messaging.PendingEntry, error) {
	f, block := a.messageFiber(ref)
	if f == nil {
		return nil, fmt.Errorf("no owned fiber %q; use a fiber id, slug, uid or raw inbox key", ref)
	}
	uid := f.UID
	if uid == "" {
		uid = f.ID
	}
	payload, _ := json.Marshal(map[string]string{"fiber_id": uid, "origin": block.Host, "action": action, "message_id": id})
	endpoint, err := a.daemonEndpoint("/api/v1/inbox")
	if err != nil {
		return nil, err
	}
	resp, err := a.daemonHTTPClient(15*time.Second).Post(endpoint, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("owner %s unreachable: %w", block.Host, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("owner %s inbox: %s", block.Host, strings.TrimSpace(string(body)))
	}
	var answer struct {
		Entries []messaging.PendingEntry `json:"entries"`
	}
	err = json.Unmarshal(body, &answer)
	return answer.Entries, err
}
