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

// Worker is the daemon's observation of the fiber's live conversation. Idle
// false means busy or not observed: a result's Turn asks for the observation.
type Worker struct {
	Address string
	Epoch   uint64
	Idle    bool
	Costly  bool
}

// Consumption describes the action taken, or the launch the daemon must
// perform. Turn reports, for a worker not observed idle, that a due entry asks
// for a turn, so the daemon's idle and cost facts would decide it. A
// consumption that failed before it could decide has no Action.
type Consumption struct {
	Action  string   `json:"action"`
	Members []string `json:"members,omitempty"`
	Turn    bool     `json:"turn,omitempty"`
}

// launchLease is how long a fresh-launch reservation stands for its receiver.
// A launch that never arrives, or that the Poller refuses after accepting the
// request, is asked for again once it passes.
const launchLease = 2 * time.Minute

// Consume advances every open batch, then selects, claims and delivers one
// turn under the fiber inbox lock. A fresh answer reserves the asking entries
// for launchLease, until the receiver changes, or until the caller retries
// without Costly after a refused launch.
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
		return Consumption{}, err
	}
	if a.Host != host {
		return Consumption{}, errCode("wrong_host", "fiber context belongs to another host")
	}
	root := mailboxDir(env, "fiber", fiber)
	if a.Harness == "codex" {
		_ = discoverCodexTerminalReceiver(ctx, env, a)
	}
	hook := MailboxAvailable(env, a.Harness, a.ID, host)
	if err := ensureDir(root, 0700); err != nil {
		return Consumption{}, err
	}
	if err := subscribeFiberReceiver(env, fiber, a, hook, w.Epoch); err != nil {
		return Consumption{}, err
	}
	if w.Address == "-" {
		return result, nil
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return Consumption{}, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return Consumption{}, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if receiverEpoch(root, w.Address) != w.Epoch || !fiberReceiverMatches(root, a) {
		return Consumption{}, errCode("stale_receiver", "superseded worker identity")
	}
	if a.Harness == "claude" && !hook {
		return Consumption{}, errCode("unavailable", "%s", mailboxUnavailable(env, a.Harness, a.ID, host))
	}
	if err := pruneOffered(root, time.Now()); err != nil {
		return Consumption{}, err
	}
	current := func(c context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(c, env, r) }
	// Each open batch advances on its own, so one awaiting its outcome holds
	// only its own members.
	errs := []error{}
	_, batches, err := openBatches(env, root)
	if err != nil {
		return Consumption{}, err
	}
	for i := range batches {
		// Quiet context pinned before batches existed is taken by a Codex
		// receiver's fiber hook, never sent to its session.
		if !batches[i].Payload.Wake && a.Harness == "codex" {
			if hook {
				errs = append(errs, closeConsumedBatch(root, &batches[i], attemptReleased, nil))
			}
			continue
		}
		sent, err := deliverConsumedBatch(ctx, env, root, host, w, &batches[i], send)
		if sent {
			result.Action, result.Members = "wake", append(result.Members, batches[i].Members...)
		}
		errs = append(errs, err)
	}
	items, _, err := openBatches(env, root)
	if err != nil {
		return Consumption{}, err
	}
	now := time.Now()
	var candidates []mailboxPendingItem
	for _, it := range items {
		if !it.entry.due(now) {
			continue
		}
		if mailboxEntryExpired(it.entry, now) {
			if err := moveToOffered(root, it.path); err != nil {
				return Consumption{}, err
			}
			continue
		}
		candidates = append(candidates, it)
	}
	due, validationErr := validateMailboxItems(root, candidates, current)
	errs = append(errs, validationErr)
	force, asking, fresh, launching := false, false, false, false
	for i := range due {
		if err := settleUnfinishedHookClaim(&due[i]); err != nil {
			return Consumption{}, err
		}
		e := due[i].entry
		// Within its lease, a reservation holds the reserving worker's wake
		// while the launch is in flight, and leaves a new receiver, the
		// launched session, to take the entry through its hook.
		if e.Attempt.open() && e.Attempt.Launch && now.Sub(time.Unix(0, e.Attempt.OpenedAt)) < launchLease {
			if e.Attempt.Conversation != w.Address || e.Attempt.Epoch != w.Epoch {
				continue
			}
			launching = true
		}
		switch e.Wishes.Turn {
		case "force":
			force = true
		case "ask", "idle":
			asking = true
			fresh = fresh || e.Wishes.IfCostly == "fresh"
		}
	}
	if !force && !w.Idle {
		result.Turn = asking
		return result, errors.Join(errs...)
	}
	if !force && !asking {
		return result, errors.Join(errs...)
	}
	if !force && w.Costly {
		if launching || !fresh {
			return result, errors.Join(errs...)
		}
		var members []string
		for _, it := range due {
			if it.entry.Wishes.Turn != "none" {
				members = append(members, it.entry.Request.MessageID)
			}
		}
		attempt := Attempt{BatchID: batchID(members), Conversation: w.Address, Epoch: w.Epoch, Members: members, OpenedAt: now.UnixNano(), Launch: true}
		for _, it := range due {
			if it.entry.Wishes.Turn == "none" {
				continue
			}
			it.entry.Attempt = &attempt
			if err := writeMailboxEntryKeepingTime(it.path, it.entry); err != nil {
				return Consumption{}, err
			}
		}
		return Consumption{Action: "fresh", Members: members}, errors.Join(errs...)
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
		return result, errors.Join(errs...)
	}
	attempt := newConsumedAttempt(w, selected)
	if err := pinConsumedBatch(root, &attempt); err != nil {
		return Consumption{}, err
	}
	sent, err := deliverConsumedBatch(ctx, env, root, host, w, &attempt, send)
	if sent {
		result.Action, result.Members = "wake", append(result.Members, attempt.Members...)
	}
	return result, errors.Join(append(errs, err)...)
}

// openBatches reads the pending entries no open batch holds, and every open
// batch: one per manifest under batches/, and one for each entry pinned
// without a manifest. A pin made before batches had manifests is completed
// here as a batch of one, under the transport id it already used.
func openBatches(env *sysenv.Env, root string) ([]mailboxPendingItem, []Attempt, error) {
	items, err := pendingItems(root)
	if err != nil {
		return nil, nil, err
	}
	batches, err := readBatchManifests(root)
	if err != nil {
		return nil, nil, err
	}
	pinned := map[string]bool{}
	for _, b := range batches {
		for _, id := range b.Members {
			pinned[id] = true
		}
	}
	var free []mailboxPendingItem
	for _, it := range items {
		id := it.entry.Request.MessageID
		switch {
		case pinned[id]:
		case it.entry.AttemptAddress == "":
			free = append(free, it)
		default:
			a, err := legacyBatch(env, root, it)
			if err != nil {
				return nil, nil, err
			}
			batches = append(batches, a)
		}
	}
	return free, batches, nil
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
	if len(items) == 1 {
		// The transport's header names a lone member's own sender.
		r := items[0].entry.Request
		req.Text, req.From, req.ReplyTo = r.Text, r.From, r.ReplyTo
	}
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

// legacyBatch reads an entry pinned without a manifest as a batch of one. An
// attempt without a stored payload was pinned before batches: it keeps the
// transport id it was sent under (see freezeLegacyAttempt), and its wait for
// an unknown outcome starts now.
func legacyBatch(env *sysenv.Env, root string, it mailboxPendingItem) (Attempt, error) {
	e := it.entry
	if e.Attempt.Payload != nil {
		return *e.Attempt, nil
	}
	e, err := freezeLegacyAttempt(env, e, e.Request)
	if err != nil {
		return Attempt{}, err
	}
	a := *e.Attempt
	a.OpenedAt = time.Now().UnixNano()
	switch {
	case a.Retry > 0:
		a.Variant = "retry-1"
	case e.PossibleRepeat:
		a.Variant = "possible-repeat"
	default:
		a.Variant = "plain"
	}
	// A warning on a successor's send must still fit the transport's limit.
	if len(a.BaseText) > (64<<10)-512 {
		text := "Full message JSON (read request.text before acting): " + filepath.Join(root, "offered", filepath.Base(it.path))
		if strings.Contains(a.Payload.Text, staleThreadSignalCaveat) {
			text = withStalenessCaveat(text)
		}
		a.BaseText = text
	}
	return a, nil
}

// pinConsumedBatch records the batch's manifest, with its complete payload and
// membership, before pinning member files. The manifest repairs partial
// multi-file claims after a crash.
func pinConsumedBatch(root string, a *Attempt) error {
	bytes, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if err := ensureDir(filepath.Join(root, "batches"), 0700); err != nil {
		return err
	}
	if err := mailboxWrite(batchManifest(root, a), bytes, false); err != nil {
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

// deliverConsumedBatch sends an open batch's pinned payload and closes it on a
// confirmed receipt. It reports whether it sent anything.
func deliverConsumedBatch(ctx context.Context, env *sysenv.Env, root, host string, w Worker, a *Attempt, send fiberContextSender) (bool, error) {
	if a.Outcome != "" {
		return false, closeConsumedBatch(root, a, a.Outcome, nil)
	}
	// A confirmed receipt already delivered every member as sent; otherwise a
	// superseded member is dropped, and the rest are released when the payload
	// never reached the conversation or held as ambiguous when it may have.
	stored, err := readDedupRecord(filepath.Join(dataDir(env), "messages", mailboxKey(a.Payload.MessageID+"-"+mailboxKey(a.Conversation)[:16])+".json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	unsent := err != nil || stored.Receipt.Status == StatusRejected
	if stored.State != "complete" || stored.ErrorCode != "" || !confirmedReceipt(stored.Receipt) {
		var superseded []string
		for _, id := range a.Members {
			path := filepath.Join(root, "pending", mailboxKey(id)+".json")
			e, err := readFiberMailboxEntry(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return false, err
			}
			if !hasThreadSignalValidation(e.Request) {
				continue
			}
			checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			current, err := currentThreadSignalWithBackoff(checkCtx, env, e.Request)
			cancel()
			var skew threadSignalSkewError
			if err != nil && !errors.As(err, &skew) {
				return false, err
			}
			if err == nil && !current {
				superseded = append(superseded, path)
			}
		}
		if len(superseded) > 0 {
			a.Outcome = attemptAmbiguous
			if unsent {
				a.Outcome = attemptReleased
			}
			bytes, _ := json.Marshal(a)
			if err := mailboxWrite(batchManifest(root, a), bytes, false); err != nil {
				return false, err
			}
			for _, path := range superseded {
				if err := moveToOffered(root, path); err != nil {
					return false, err
				}
			}
			return false, closeConsumedBatch(root, a, a.Outcome, nil)
		}
	}
	if err := pinConsumedBatch(root, a); err != nil {
		return false, err
	}
	receipt, err := send(ctx, env, host, *a.Payload, a.Conversation)
	unknown := receipt.Status == StatusUnknown
	ended := unknown && a.Conversation != w.Address && fiberContextSessionEnded(env, host, a.Conversation)
	stale := unknown && ErrorCode(err) != "wake_held" && time.Since(time.Unix(0, a.OpenedAt)) >= liveAttemptRetryAfter
	if receipt.Status == StatusRejected || ended || (stale && (a.Conversation != w.Address || a.Retry == 0)) {
		if a.Conversation == w.Address && receipt.Status == StatusRejected {
			return true, closeConsumedBatch(root, a, attemptReleased, err)
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
			return true, err
		}
		receipt, err = send(ctx, env, host, req, w.Address)
		*a = next
	}
	if err == nil && confirmedReceipt(receipt) {
		for _, id := range a.Members {
			e, readErr := readFiberMailboxEntry(filepath.Join(root, "pending", mailboxKey(id)+".json"))
			if readErr == nil && e.Request.NotifyWhenIdle {
				req := e.Request
				req.Address = a.Conversation
				address, _ := ParseAddress(a.Conversation)
				subscribeIdle(env, address, req)
			}
		}
		return true, closeConsumedBatch(root, a, attemptDelivered, nil)
	}
	if err == nil {
		err = errCode("unconfirmed", "batch delivery: %s", receipt.Status)
	}
	if receipt.Status == StatusRejected {
		return true, closeConsumedBatch(root, a, attemptReleased, err)
	}
	return true, err
}

func confirmedReceipt(r Receipt) bool {
	return r.Status == StatusAccepted || r.Status == StatusContextAdded || (r.Status == StatusSubmitted && r.Transport == "codex-terminal")
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
	if err := os.Remove(batchManifest(root, a)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return errors.Join(sendErr, syncDir(filepath.Join(root, "batches")))
}

func batchManifest(root string, a *Attempt) string {
	return filepath.Join(root, "batches", a.BatchID+".json")
}

// readBatchManifests reads every open batch's manifest.
func readBatchManifests(root string) ([]Attempt, error) {
	dir := filepath.Join(root, "batches")
	files, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var batches []Attempt
	for _, file := range files {
		if file.IsDir() || strings.HasPrefix(file.Name(), ".") || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		bytes, err := readBounded(filepath.Join(dir, file.Name()), 512<<10)
		var a Attempt
		if err == nil {
			err = json.Unmarshal(bytes, &a)
		}
		if err != nil {
			return nil, err
		}
		batches = append(batches, a)
	}
	return batches, nil
}

// settleUnfinishedHookClaim closes an open, unpinned claim that is not a
// launch reservation as ambiguous. Read under the inbox lock, such a claim
// belongs to a hook that died between its output and its close.
func settleUnfinishedHookClaim(it *mailboxPendingItem) error {
	if !it.entry.Attempt.open() || it.entry.AttemptAddress != "" || it.entry.Attempt.Launch {
		return nil
	}
	it.entry.closeAttempt(attemptAmbiguous)
	return writeMailboxEntryKeepingTime(it.path, it.entry)
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
		req.Text = "Possible repeat: an earlier delivery of this message had an unknown outcome.\n\n" + req.Text
	}
	req.MessageID = batchTransportID(a.Members, a.Conversation, a.Variant, req.Text)
	return req
}
