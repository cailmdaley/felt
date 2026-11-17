package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// statusStarting is the receipt status of a waking message to a fiber with no
// live worker, for which the fiber's owner is starting a session. It never
// means delivered: the session takes the message through its hook.
const statusStarting = "starting"

// fiberReceipt is shuttle message's answer for a message the fiber's owner
// queued in the fiber's inbox: starting, or queued with what it waits for.
type fiberReceipt struct {
	MessageID string `json:"message_id"`
	Fiber     string `json:"fiber"`
	Status    string `json:"status"`
	Detail    string `json:"detail"`
	NotBefore string `json:"not_before,omitempty"`
}

// queueInFiber sends a message to fiber f's inbox through its owner, where
// consumption decides context, follow-up, wake or a gated launch. force
// records --wake; a notBefore instant (UTC RFC 3339) schedules it.
// Attachments are retained as owner-local references.
func (a *app) queueInFiber(f *felt.Felt, block *shuttle.Block, request messaging.Request, force bool, notBefore string) (*fiberReceipt, error) {
	if err := a.requireDeliveringDaemon(block.Host); err != nil {
		return nil, fmt.Errorf("message %s: %w", request.MessageID, err)
	}
	fiberID := f.UID
	if fiberID == "" {
		fiberID = f.ID
	}
	turn := ""
	if request.Wake {
		turn = "ask"
		if force {
			turn = "force"
		}
	}
	if request.Text == "" && len(request.Attachments) > 0 {
		request.Text = "Attached files."
	}
	fields := map[string]any{
		"fiber_id":         fiberID,
		"origin":           block.Host,
		"address":          request.Address,
		"text":             request.Text,
		"attachments":      request.Attachments,
		"from":             request.From,
		"reply_to":         request.ReplyTo,
		"notify_address":   request.NotifyAddress,
		"notify_when_idle": request.NotifyWhenIdle,
		"notify_wake":      request.NotifyWake,
		"message_id":       request.MessageID,
		"wake":             request.Wake,
		"turn":             turn,
		"context_only":     true,
	}
	if notBefore != "" {
		fields["not_before"] = notBefore
	}
	payload, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	endpoint, err := a.daemonEndpoint("/api/v1/deliver")
	if err != nil {
		return nil, err
	}
	resp, err := a.daemonHTTPClient(52*time.Second).Post(endpoint, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("message %s: reaching daemon at %s: %w", request.MessageID, endpoint, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxMessageReceiptBytes))
	var answer struct {
		Queued bool   `json:"queued"`
		Status string `json:"status"`
		Detail string `json:"detail"`
		Error  string `json:"error"`
	}
	_ = json.Unmarshal(body, &answer)
	switch {
	case resp.StatusCode < 300 && answer.Queued:
		receipt := &fiberReceipt{MessageID: request.MessageID, Fiber: f.ID, Status: string(messaging.StatusQueued), Detail: answer.Detail}
		switch answer.Status {
		case statusStarting, "woken", "followed_up", "delivered", "held", "scheduled":
			receipt.Status = answer.Status
		}
		receipt.NotBefore = notBefore
		if receipt.Detail == "" {
			receipt.Detail = fmt.Sprintf("not delivered; queued in %s's inbox", f.ID)
		}
		return receipt, nil
	default:
		detail := answer.Error
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return nil, fmt.Errorf("message %s: queueing in %s's inbox: daemon returned %d: %s", request.MessageID, f.ID, resp.StatusCode, detail)
	}
}

// subscriptionRefused is a notify-only subscription its owner definitely
// refused without a receipt: nothing was subscribed.
type subscriptionRefused struct{ msg string }

func (e subscriptionRefused) Error() string { return e.msg }

// subscribeFiberIdle asks fiber f's owner to subscribe the request's sender to
// one idle notice from the fiber's live worker. The answer is the
// subscription's receipt, addressed to that worker, or an unknown receipt
// when the owner did not answer the local daemon in time. A 4xx with no
// receipt, such as a fiber with no live worker, is a subscriptionRefused
// error and no receipt.
func (a *app) subscribeFiberIdle(f *felt.Felt, block *shuttle.Block, request messaging.Request) (messaging.Receipt, error) {
	fiberID := f.UID
	if fiberID == "" {
		fiberID = f.ID
	}
	payload, err := json.Marshal(map[string]any{
		"fiber_id":         fiberID,
		"origin":           block.Host,
		"from":             request.From,
		"message_id":       request.MessageID,
		"notify_address":   request.NotifyAddress,
		"notify_when_idle": true,
		"notify_wake":      request.NotifyWake,
	})
	if err != nil {
		return messaging.Receipt{}, err
	}
	endpoint, err := a.daemonEndpoint("/api/v1/deliver")
	if err != nil {
		return messaging.Receipt{}, err
	}
	resp, err := a.daemonHTTPClient(52*time.Second).Post(endpoint, "application/json", bytes.NewReader(payload))
	if err != nil {
		return messaging.Receipt{}, fmt.Errorf("reaching daemon at %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxMessageReceiptBytes))
	var receipt messaging.Receipt
	_ = json.Unmarshal(body, &receipt)
	if resp.StatusCode >= 400 && resp.StatusCode < 500 && receipt.Status == "" {
		var refusal struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &refusal)
		detail := refusal.Error
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return messaging.Receipt{}, subscriptionRefused{fmt.Sprintf("subscribing to %s's idleness: daemon returned %d: %s", f.ID, resp.StatusCode, detail)}
	}
	if resp.StatusCode >= 300 {
		return receipt, daemonStatusError{url: endpoint, status: resp.StatusCode, body: strings.TrimSpace(string(body))}
	}
	if receipt.Status == "" {
		// The local daemon took the request but the owner did not answer in time.
		return messaging.Receipt{
			MessageID: request.MessageID,
			Address:   request.Address,
			Status:    messaging.StatusUnknown,
			Transport: "daemon",
			Detail:    strings.TrimSuffix(receipt.Detail, ".") + ". Retry this exact request with the same message_id",
		}, nil
	}
	return receipt, nil
}

// printFiberReceipt reports a message queued in a fiber's inbox: JSON with
// --json, else one line naming the fiber, what happens next and the message
// id a retry reuses.
func (a *app) printFiberReceipt(receipt *fiberReceipt, wake bool) error {
	if a.json {
		return a.outputJSON(receipt)
	}
	var err error
	switch {
	case receipt.Status == "scheduled":
		t, _ := time.Parse(time.RFC3339, receipt.NotBefore)
		_, err = fmt.Fprintf(a.env.Stdout, "scheduled for %s: %s (%s UTC; %s)\n", receipt.Fiber, t.Local().Format(time.RFC3339), t.UTC().Format("2006-01-02 15:04:05"), receipt.MessageID)
	case receipt.Status == "woken":
		_, err = fmt.Fprintf(a.env.Stdout, "woken %s (%s)\n", receipt.Fiber, receipt.MessageID)
	case receipt.Status == "delivered":
		_, err = fmt.Fprintf(a.env.Stdout, "delivered to %s (%s)\n", receipt.Fiber, receipt.MessageID)
	case receipt.Status == "followed_up":
		_, err = fmt.Fprintf(a.env.Stdout, "followed up in a turn on %s (%s)\n", receipt.Fiber, receipt.MessageID)
	case receipt.Status == "held":
		_, err = fmt.Fprintf(a.env.Stdout, "held as context for cost on %s (%s)\n", receipt.Fiber, receipt.MessageID)
	case receipt.Status == statusStarting:
		_, err = fmt.Fprintf(a.env.Stdout, "starting a session on %s for it (%s)\n", receipt.Fiber, receipt.MessageID)
	case wake:
		_, err = fmt.Fprintf(a.env.Stdout, "queued for %s: %s (%s)\n", receipt.Fiber, receipt.Detail, receipt.MessageID)
	default:
		_, err = fmt.Fprintf(a.env.Stdout, "queued as context for %s (%s)\n", receipt.Fiber, receipt.MessageID)
	}
	return err
}

// messageFiber is the one Shuttle-owned fiber a message target names (its
// path, slug or uid), with its block, or nil when the target is a session
// address or id, or names no such fiber.
func (a *app) messageFiber(target string) (*felt.Felt, *shuttle.Block) {
	if strings.HasPrefix(target, "shuttle://") || sessionUUIDPattern.MatchString(target) {
		return nil, nil
	}
	return a.lookupFiber(target)
}

// lookupFiber is the one Shuttle-owned fiber an id, slug or uid names, looked
// up in this host's stores and then the owners' feed, with its block.
func (a *app) lookupFiber(target string) (*felt.Felt, *shuttle.Block) {
	lookup, err := a.lookupShuttleAddressFibers(target)
	if err != nil || len(lookup.Ambiguous) > 0 {
		return nil, nil
	}
	if len(lookup.Fibers) == 0 {
		var ownerFibers []*felt.Felt
		ownerFibers, err = a.ownerFeedFibers(target)
		if len(ownerFibers) > 0 {
			lookup = addressFiberLookup{Fibers: ownerFibers}
		}
	}
	if err != nil || lookup.refused() || len(lookup.Fibers) != 1 {
		return nil, nil
	}
	f := lookup.Fibers[0]
	block, ok, err := shuttle.BlockOf(f)
	if err != nil || !ok || block.Host == "" {
		return nil, nil
	}
	return f, block
}

// messageFresh asks the target fiber's owner for a fresh session with the
// text in its launch prompt, replacing a live worker. The owner records the
// request under its id, so a repeat never starts a second session, and a
// launch it refuses (a closed or resting fiber, the boot quarantine) answers
// with its reason; the same id may be sent again once that changes.
func (a *app) messageFresh(request messaging.Request) error {
	f, block := a.messageFiber(request.Address)
	if f == nil {
		return fmt.Errorf("--fresh needs a fiber with a shuttle: block; %q names none", request.Address)
	}
	fiberID := f.UID
	if fiberID == "" {
		fiberID = f.ID
	}
	payload, err := json.Marshal(map[string]any{
		"fiber_id":    fiberID,
		"origin":      block.Host,
		"text":        request.Text,
		"from":        request.From,
		"message_id":  request.MessageID,
		"resume_mode": "fresh",
	})
	if err != nil {
		return err
	}
	endpoint, err := a.daemonEndpoint("/api/v1/deliver")
	if err != nil {
		return err
	}
	resp, err := a.daemonHTTPClient(52*time.Second).Post(endpoint, "application/json", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("message %s: reaching daemon at %s: %w", request.MessageID, endpoint, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxMessageReceiptBytes))
	var answer struct {
		Delivered *bool  `json:"delivered"`
		Error     string `json:"error"`
		Detail    string `json:"detail"`
	}
	_ = json.Unmarshal(body, &answer)
	if resp.StatusCode == http.StatusAccepted && answer.Delivered == nil {
		// The owner took the request without confirming the launch. The same
		// id sent again never starts a second session.
		_, err = fmt.Fprintf(a.env.Stdout, "fresh session requested on %s, launch unconfirmed: %s (%s)\n", f.ID, answer.Detail, request.MessageID)
		return err
	}
	if resp.StatusCode >= 300 || answer.Delivered == nil || !*answer.Delivered {
		detail := answer.Error
		if detail == "" {
			detail = answer.Detail
		}
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return fmt.Errorf("message %s: starting a fresh session on %s: daemon returned %d: %s", request.MessageID, f.ID, resp.StatusCode, detail)
	}
	if a.json {
		return a.outputJSON(map[string]string{"message_id": request.MessageID, "fiber": f.ID, "status": "started_fresh"})
	}
	_, err = fmt.Fprintf(a.env.Stdout, "started a fresh session on %s (%s)\n", f.ID, request.MessageID)
	return err
}
