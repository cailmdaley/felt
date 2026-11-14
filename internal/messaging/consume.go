package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Worker is the daemon's observation of the fiber's live conversation.
// Idle false also represents an unknown turn state.
type Worker struct {
	Address string
	Epoch   uint64
	Idle    bool
	Costly  bool
}

// Consumption describes the action taken, or the launch the daemon must perform.
type Consumption struct {
	Action  string   `json:"action"`
	Members []string `json:"members,omitempty"`
}

// Consume selects, claims and delivers one turn under the fiber inbox lock.
// A fresh answer reserves the asking entries until the receiver changes or the
// caller retries without Costly after a refused launch.
func Consume(ctx context.Context, env *sysenv.Env, fiber, host string, worker Worker) (Consumption, error) {
	return consumeWith(ctx, env, fiber, host, worker, sendFiberContextAttempt)
}

func consumeWith(ctx context.Context, env *sysenv.Env, fiber, host string, w Worker, send fiberContextSender) (Consumption, error) {
	result := Consumption{Action: "wait"}
	a := Address{Host: host}
	var err error
	if w.Address != "-" {
		a, err = ParseAddress(w.Address)
	}
	if err != nil {
		return result, err
	}
	if a.Host != host {
		return result, errCode("wrong_host", "fiber context belongs to another host")
	}
	root := mailboxDir(env, "fiber", fiber)
	if a.Harness == "codex" {
		_ = discoverCodexTerminalReceiver(ctx, env, a)
	}
	hook := MailboxAvailable(env, a.Harness, a.ID, host)
	if err := ensureDir(root, 0700); err != nil {
		return result, err
	}
	if err := subscribeFiberReceiver(env, fiber, a, hook, w.Epoch); err != nil {
		return result, err
	}
	if w.Address == "-" {
		return result, nil
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return result, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return result, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if receiverEpoch(root, w.Address) != w.Epoch || !fiberReceiverMatches(root, a) {
		return result, errCode("stale_receiver", "superseded worker identity")
	}
	if a.Harness == "claude" && !hook {
		return result, errCode("unavailable", "%s", mailboxUnavailable(env, a.Harness, a.ID, host))
	}
	if err := pruneOffered(root, time.Now()); err != nil {
		return result, err
	}
	items, err := pendingItems(root)
	if err != nil {
		return result, err
	}
	launching := false
	if active, err := readConsumedBatch(root); err == nil {
		if !active.Launch {
			return deliverConsumedBatch(ctx, env, root, host, w, &active, send)
		}
		for _, it := range items {
			for _, id := range active.Members {
				if id == it.entry.Request.MessageID {
					launching = active.Conversation == w.Address && active.Epoch == w.Epoch && w.Costly
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	// Finish an existing pinned batch before selecting another one. Its stored
	// payload is the emission, even after a partial claim or close across files.
	for _, it := range items {
		if it.entry.AttemptAddress == "" {
			continue
		}
		if it.entry.Attempt.Variant == "" {
			// Single-entry attempts without a variant keep their transport identity.
			checked, current, err := validateMailboxItem(root, it, func(c context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(c, env, r) })
			if err != nil || !current {
				return result, err
			}
			err = deliverFiberContextItemWith(ctx, env, fiber, host, w.Address, checked.entry.Request, send)
			if err == nil {
				err = closeAttempts([]string{it.path}, attemptDelivered)
			}
			return Consumption{Action: "wake", Members: []string{it.entry.Request.MessageID}}, err
		}
		return deliverConsumedBatch(ctx, env, root, host, w, it.entry.Attempt, send)
	}
	var candidates []mailboxPendingItem
	for _, it := range items {
		if !it.entry.due(time.Now()) {
			continue
		}
		if mailboxEntryExpired(it.entry, time.Now()) {
			if err := moveToOffered(root, it.path); err != nil {
				return result, err
			}
			continue
		}
		candidates = append(candidates, it)
	}
	due, validationErr := validateMailboxItems(root, candidates, func(c context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(c, env, r) })
	force, asking, fresh := false, false, false
	for _, it := range due {
		if it.entry.Attempt.open() && it.entry.Attempt.Launch && it.entry.Attempt.Conversation == w.Address && it.entry.Attempt.Epoch == w.Epoch && w.Costly {
			launching = true
		}
		switch it.entry.Wishes.Turn {
		case "force":
			force = true
			asking = true
		case "ask", "idle":
			asking = true
			fresh = fresh || it.entry.Wishes.IfCostly == "fresh"
		}
	}
	if !force && (!asking || !w.Idle) {
		return result, validationErr
	}
	if !force && w.Costly {
		if launching || !fresh {
			return result, validationErr
		}
		var paths, members []string
		for _, it := range due {
			if it.entry.Wishes.Turn != "none" {
				paths = append(paths, it.path)
				members = append(members, it.entry.Request.MessageID)
			}
		}
		attempt := Attempt{BatchID: batchID(members), Conversation: w.Address, Epoch: w.Epoch, Members: members, OpenedAt: time.Now().UnixNano(), Launch: true}
		bytes, err := json.Marshal(attempt)
		if err != nil {
			return result, err
		}
		if err := mailboxWrite(filepath.Join(root, "active-batch.json"), bytes, false); err != nil {
			return result, err
		}
		for _, path := range paths {
			e, err := readFiberMailboxEntry(path)
			if err != nil {
				return result, err
			}
			e.Attempt = &attempt
			if err := writeMailboxEntryKeepingTime(path, e); err != nil {
				return result, err
			}
		}
		return Consumption{Action: "fresh", Members: attempt.Members}, nil
	}
	var selected []mailboxPendingItem
	size, lifecycle := 0, false
	limit := 64 << 10
	if a.Harness == "claude" {
		limit = claudeHookBatchBytes
	}
	// Leave framing and a possible-repeat warning inside the harness limit.
	limit -= 512
	for _, it := range due {
		if it.entry.Wishes.Turn == "idle" && !w.Idle {
			continue
		}
		if hasThreadSignalValidation(it.entry.Request) && lifecycle {
			continue
		}
		cost := len(Labeled(it.entry.Request)) + 2
		if cost > limit {
			it.entry.Request.Text = "Full message JSON (read request.text before acting): " + filepath.Join(root, "offered", filepath.Base(it.path))
			cost = len(Labeled(it.entry.Request)) + 2
		}
		if size+cost > limit {
			break
		}
		selected = append(selected, it)
		size += cost
		lifecycle = lifecycle || hasThreadSignalValidation(it.entry.Request)
		if len(selected) == 16 {
			break
		}
	}
	if len(selected) == 0 {
		return result, validationErr
	}
	attempt := newConsumedAttempt(w, selected)
	if err := pinConsumedBatch(root, &attempt); err != nil {
		return result, err
	}
	result, err = deliverConsumedBatch(ctx, env, root, host, w, &attempt, send)
	return result, err
}

func newConsumedAttempt(w Worker, items []mailboxPendingItem) Attempt {
	members := make([]string, len(items))
	texts := make([]string, len(items))
	repeat := false
	for i, it := range items {
		members[i] = it.entry.Request.MessageID
		texts[i] = Labeled(it.entry.Request)
		repeat = repeat || it.entry.PossibleRepeat
	}
	req := Request{Text: strings.Join(texts, "\n\n"), From: "shuttle", Wake: true}
	for _, it := range items {
		req.Attachments = append(req.Attachments, it.entry.Request.Attachments...)
	}
	a := Attempt{BatchID: batchID(members), Conversation: w.Address, Epoch: w.Epoch, Members: members, OpenedAt: time.Now().UnixNano(), Payload: &req, BaseText: req.Text, Variant: "plain"}
	if repeat {
		a.Variant = "possible-repeat"
	}
	payload := consumedVariant(a)
	a.Payload = &payload
	return a
}

// pinConsumedBatch records the complete payload and membership before pinning
// member files. Its manifest repairs partial multi-file claims after a crash.
func pinConsumedBatch(root string, a *Attempt) error {
	bytes, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if err := mailboxWrite(filepath.Join(root, "active-batch.json"), bytes, false); err != nil {
		return err
	}
	for _, id := range a.Members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		e, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		e.Attempt, e.AttemptAddress = a, a.Conversation
		if a.Variant == "possible-repeat" {
			e.PossibleRepeat = true
		}
		if err := writeMailboxEntry(path, e); err != nil {
			return err
		}
	}
	return nil
}

func deliverConsumedBatch(ctx context.Context, env *sysenv.Env, root, host string, w Worker, a *Attempt, send fiberContextSender) (Consumption, error) {
	result := Consumption{Action: "wake", Members: a.Members}
	if a.Outcome != "" {
		return Consumption{Action: "wait"}, closeConsumedBatch(root, a, a.Outcome, nil)
	}
	for _, id := range a.Members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		e, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return result, err
		}
		if hasThreadSignalValidation(e.Request) {
			checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			current, err := currentThreadSignalWithBackoff(checkCtx, env, e.Request)
			cancel()
			var skew threadSignalSkewError
			if err != nil && !errors.As(err, &skew) {
				return result, err
			}
			if err == nil && !current {
				a.Outcome = attemptAmbiguous
				bytes, _ := json.Marshal(a)
				if err := mailboxWrite(filepath.Join(root, "active-batch.json"), bytes, false); err != nil {
					return result, err
				}
				if err := moveToOffered(root, path); err != nil {
					return result, err
				}
				return Consumption{Action: "wait"}, closeConsumedBatch(root, a, attemptAmbiguous, nil)
			}
		}
	}
	if err := pinConsumedBatch(root, a); err != nil {
		return result, err
	}
	receipt, err := send(ctx, env, host, *a.Payload, a.Conversation)
	unknown := receipt.Status == StatusUnknown
	ended := unknown && a.Conversation != w.Address && fiberContextSessionEnded(env, host, a.Conversation)
	stale := unknown && ErrorCode(err) != "wake_held" && time.Since(time.Unix(0, a.OpenedAt)) >= liveAttemptRetryAfter
	if receipt.Status == StatusRejected || ended || (stale && (a.Conversation != w.Address || a.Retry == 0)) {
		if a.Conversation == w.Address && receipt.Status == StatusRejected {
			return result, closeConsumedBatch(root, a, attemptReleased, err)
		}
		next := *a
		next.Conversation, next.Epoch, next.OpenedAt = w.Address, w.Epoch, time.Now().UnixNano()
		if a.Conversation == w.Address {
			next.Retry++
			next.Variant = "retry-1"
		} else {
			next.Retry = 0
			if unknown || a.Retry > 0 || a.Variant == "possible-repeat" {
				next.Variant = "possible-repeat"
			} else {
				next.Variant = "plain"
			}
		}
		req := consumedVariant(next)
		next.Payload = &req
		if err := pinConsumedBatch(root, &next); err != nil {
			return result, err
		}
		receipt, err = send(ctx, env, host, req, w.Address)
		a = &next
	}
	confirmed := receipt.Status == StatusAccepted || receipt.Status == StatusContextAdded || (receipt.Status == StatusSubmitted && receipt.Transport == "codex-terminal")
	if err == nil && confirmed {
		for _, id := range a.Members {
			e, readErr := readFiberMailboxEntry(filepath.Join(root, "pending", mailboxKey(id)+".json"))
			if readErr == nil && e.Request.NotifyWhenIdle {
				req := e.Request
				req.Address = a.Conversation
				address, _ := ParseAddress(a.Conversation)
				subscribeIdle(env, address, req)
			}
		}
		return result, closeConsumedBatch(root, a, attemptDelivered, nil)
	}
	if err == nil {
		err = errCode("unconfirmed", "batch delivery: %s", receipt.Status)
	}
	if receipt.Status == StatusRejected {
		return result, closeConsumedBatch(root, a, attemptReleased, err)
	}
	return result, err
}

func closeConsumedBatch(root string, a *Attempt, outcome string, sendErr error) error {
	var paths []string
	for _, id := range a.Members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		if _, err := os.Stat(path); err == nil {
			paths = append(paths, path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := closeAttempts(paths, outcome); err != nil {
		return errors.Join(sendErr, err)
	}
	if err := os.Remove(filepath.Join(root, "active-batch.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return errors.Join(sendErr, syncDir(root))
}

// batchTransportID is a bounded, domain-separated identity for the ordered
// members, conversation and exact text variant. Publications cannot mint it by
// choosing an id that resembles a retry suffix.
func batchTransportID(members []string, conversation, variant, text string) string {
	bytes, _ := json.Marshal(struct {
		Domain                          string
		Members                         []string
		Conversation, Variant, TextHash string
	}{"shuttle/fiber-batch/v1", members, conversation, variant, mailboxKey(text)})
	return "batch-" + mailboxKey(string(bytes))
}

func consumedVariant(a Attempt) Request {
	req := *a.Payload
	req.Text = a.BaseText
	switch a.Variant {
	case "retry-1":
		req.Text = "Possible repeat: an earlier delivery of this message to this session had an unknown outcome.\n\n" + req.Text
	case "possible-repeat":
		req.Text = "Possible repeat: delivery to a previous worker had an unknown outcome before its session ended.\n\n" + req.Text
	}
	req.MessageID = batchTransportID(a.Members, a.Conversation, a.Variant, req.Text)
	return req
}

func readConsumedBatch(root string) (Attempt, error) {
	bytes, err := readBounded(filepath.Join(root, "active-batch.json"), 512<<10)
	var a Attempt
	if err == nil {
		err = json.Unmarshal(bytes, &a)
	}
	return a, err
}

// TurnPending reports whether wake-cost facts can affect this fiber's consume.
func TurnPending(env *sysenv.Env, fiber string) (bool, error) {
	items, err := pendingItems(mailboxDir(env, "fiber", fiber))
	if err != nil {
		return false, err
	}
	for _, it := range items {
		if it.entry.due(time.Now()) && it.entry.Wishes.Turn != "none" {
			return true, nil
		}
	}
	return false, nil
}
