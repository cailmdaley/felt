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
}

// queueForFiber routes attachment-free fiber messages to the fiber's inbox
// through its owner. A waking or idle-notification request queues only
// without a live worker, where the owner starts a session for it when the
// fiber allows; otherwise the caller resolves and messages that worker. A
// quiet one queues whether or not a worker is live. force records the
// explicit --wake. Session targets and attachments always take the session
// path.
func (a *app) queueForFiber(request messaging.Request, force bool) (*fiberReceipt, error) {
	if len(request.Attachments) > 0 {
		return nil, nil
	}
	f, block := a.messageFiber(request.Address)
	if f == nil {
		return nil, nil
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
	payload, err := json.Marshal(map[string]any{
		"fiber_id":         fiberID,
		"origin":           block.Host,
		"address":          request.Address,
		"text":             request.Text,
		"from":             request.From,
		"reply_to":         request.ReplyTo,
		"notify_address":   request.NotifyAddress,
		"notify_when_idle": request.NotifyWhenIdle,
		"notify_wake":      request.NotifyWake,
		"message_id":       request.MessageID,
		"wake":             request.Wake,
		"turn":             turn,
		"context_only":     true,
		"unless_live":      request.Wake || request.NotifyWhenIdle,
	})
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
		Live   bool   `json:"live"`
		Status string `json:"status"`
		Detail string `json:"detail"`
		Error  string `json:"error"`
	}
	_ = json.Unmarshal(body, &answer)
	switch {
	case resp.StatusCode == http.StatusConflict && answer.Live && (request.Wake || request.NotifyWhenIdle):
		return nil, nil
	case resp.StatusCode < 300 && answer.Queued:
		receipt := &fiberReceipt{MessageID: request.MessageID, Fiber: f.ID, Status: string(messaging.StatusQueued), Detail: answer.Detail}
		if answer.Status == statusStarting {
			receipt.Status = statusStarting
		}
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

// printFiberReceipt reports a message queued in a fiber's inbox: JSON with
// --json, else one line naming the fiber, what happens next and the message
// id a retry reuses.
func (a *app) printFiberReceipt(receipt *fiberReceipt, wake bool) error {
	if a.json {
		return a.outputJSON(receipt)
	}
	var err error
	switch {
	case receipt.Status == statusStarting:
		_, err = fmt.Fprintf(a.env.Stdout, "starting a session on %s for it (%s)\n", receipt.Fiber, receipt.MessageID)
	case wake:
		_, err = fmt.Fprintf(a.env.Stdout, "queued for %s: %s (%s)\n", receipt.Fiber, receipt.Detail, receipt.MessageID)
	default:
		_, err = fmt.Fprintf(a.env.Stdout, "queued as context for %s (%s)\n", receipt.Fiber, receipt.MessageID)
	}
	return err
}

// messageFiber is the one Shuttle-owned fiber a message target names, with its
// block, or nil when the target is a session or names no such fiber.
func (a *app) messageFiber(target string) (*felt.Felt, *shuttle.Block) {
	if strings.HasPrefix(target, "shuttle://") || looksLikeNativeSessionID(target) {
		return nil, nil
	}
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

// messageFresh starts a new session on the target fiber with the message as
// its launch directive, replacing a live worker. The owning daemon names the
// previous session to the new one.
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
		// The owner took the request without confirming the launch. A second
		// --fresh would replace the session this one may still start.
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
