package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// statusQueuedForNextWorker is the receipt status of a message that waits in
// a fiber's mailbox because the fiber has no live worker. It never means
// delivered: the next worker the fiber launches reads it as context.
const statusQueuedForNextWorker = "queued_for_next_worker"

// nextWorkerReceipt is shuttle message's answer for a message queued for a
// fiber's next worker.
type nextWorkerReceipt struct {
	MessageID string `json:"message_id"`
	Fiber     string `json:"fiber"`
	Status    string `json:"status"`
	Detail    string `json:"detail"`
}

// queueForNextWorker offers a message addressed to a fiber to the fiber's
// owning daemon, which queues it in the fiber's durable context mailbox when
// no worker is live. It returns nil, with no error, when the target does not
// name exactly one shuttle fiber by a non-session-shaped name, or when the
// owner reports a live worker: the caller then resolves and messages that
// worker. Attachments cannot wait in a mailbox, so a message carrying them
// always takes the live-worker path.
//
// The request is context_only, so an owner that predates unless_live queues
// the message rather than launching the fiber; one that knows it answers 409
// while a worker is live and queues nothing.
func (a *app) queueForNextWorker(request messaging.Request) (*nextWorkerReceipt, error) {
	target := request.Address
	if len(request.Attachments) > 0 || strings.HasPrefix(target, "shuttle://") || looksLikeNativeSessionID(target) {
		return nil, nil
	}
	lookup, err := a.lookupShuttleAddressFibers(target)
	if err != nil || lookup.refused() || len(lookup.Fibers) != 1 {
		return nil, nil
	}
	f := lookup.Fibers[0]
	block, ok, err := shuttle.BlockOf(f)
	if err != nil || !ok || block.Host == "" {
		return nil, nil
	}
	fiberID := f.UID
	if fiberID == "" {
		fiberID = f.ID
	}
	payload, err := json.Marshal(map[string]any{
		"fiber_id":     fiberID,
		"origin":       block.Host,
		"text":         request.Text,
		"from":         request.From,
		"message_id":   request.MessageID,
		"wake":         request.Wake,
		"context_only": true,
		"unless_live":  true,
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
		Error  string `json:"error"`
	}
	_ = json.Unmarshal(body, &answer)
	switch {
	case resp.StatusCode == http.StatusConflict && answer.Live:
		return nil, nil
	case resp.StatusCode < 300 && answer.Queued:
		return &nextWorkerReceipt{
			MessageID: request.MessageID,
			Fiber:     f.ID,
			Status:    statusQueuedForNextWorker,
			Detail:    fmt.Sprintf("%s has no live worker; not delivered, queued as context for its next worker", f.ID),
		}, nil
	default:
		detail := answer.Error
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return nil, fmt.Errorf("message %s: queueing for %s's next worker: daemon returned %d: %s", request.MessageID, f.ID, resp.StatusCode, detail)
	}
}

// printNextWorkerReceipt reports a queued message: JSON with --json, else one
// line naming the fiber and the message id a retry reuses.
func (a *app) printNextWorkerReceipt(receipt *nextWorkerReceipt) error {
	if a.json {
		return a.outputJSON(receipt)
	}
	_, err := fmt.Fprintf(a.env.Stdout, "queued for %s's next worker (%s)\n", receipt.Fiber, receipt.MessageID)
	return err
}
