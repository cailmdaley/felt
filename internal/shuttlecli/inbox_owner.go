package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// rawInboxKey reports whether ref is a host-local inbox key (a fiber's
// fiber:<uid> key or, for a fiber without a uid, its store path and id, a
// session address, or the routing inbox) rather than a fiber reference.
func rawInboxKey(ref string) bool {
	return strings.HasPrefix(ref, messaging.FiberKeyPrefix) || strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "shuttle://") || ref == "threads"
}

// inboxFiber resolves the reference an inbox verb or a delayed send names:
// nil for a raw inbox key, which this host reads itself, else the one fiber
// it names, or an error saying it names none.
func (a *app) inboxFiber(ref string) (*felt.Felt, *shuttle.Block, error) {
	if rawInboxKey(ref) {
		return nil, nil, nil
	}
	if f, block := a.lookupFiber(ref); f != nil {
		return f, block, nil
	}
	return nil, nil, fmt.Errorf("no fiber %q with a shuttle: block; use a fiber id, slug, uid or raw inbox key", ref)
}

// listInbox lists a fiber's pending entries from its owner, or a raw key's
// from this host; scheduled keeps only those with a delivery time.
func (a *app) listInbox(ref string, scheduled bool) ([]messaging.PendingEntry, error) {
	f, block, err := a.inboxFiber(ref)
	if err != nil {
		return nil, err
	}
	var entries []messaging.PendingEntry
	if f == nil {
		entries, err = messaging.PendingEntries(a.env, ref)
	} else {
		entries, err = a.ownerInbox(f, block, "list", "")
	}
	if !scheduled {
		return entries, err
	}
	out := []messaging.PendingEntry{}
	for _, e := range entries {
		if e.NotBefore != "" {
			out = append(out, e)
		}
	}
	return out, err
}

// cancelInbox cancels a pending entry on a fiber's owner, or under a raw key
// on this host.
func (a *app) cancelInbox(ref, id string) error {
	f, block, err := a.inboxFiber(ref)
	if err != nil {
		return err
	}
	if f == nil {
		return messaging.CancelPending(a.env, ref, id)
	}
	_, err = a.ownerInbox(f, block, "cancel", id)
	return err
}

// ownerInbox asks fiber f's owner, through the local daemon, to list or
// cancel in its inbox.
func (a *app) ownerInbox(f *felt.Felt, block *shuttle.Block, action, id string) ([]messaging.PendingEntry, error) {
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
