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

// Worker is the daemon's observation of the fiber's live conversation, or
// Address "-" when the fiber has no worker. Idle false means busy or not
// observed: a result's Turn asks for the observation. Unknown marks an Idle
// the daemon inferred rather than observed (a turn ended with a task still
// open, or no hook has reported one): it wakes for ask, never for idle.
type Worker struct {
	Address string
	Epoch   uint64
	Idle    bool
	Unknown bool
	Costly  bool
	Busy    bool
	// Message names an entry whose state the answer reports (Consumption.Message).
	Message string
}

// Consumption describes the action taken (wake, or context for quiet entries
// sent to a receiver without a hook), or the launch the daemon must perform:
// fresh, a session replacing a costly live worker, or launch, a session for a
// fiber with none. Turn reports, for a worker not observed idle, that a due
// entry asks for a turn, so the daemon's idle and cost facts would decide it.
// A consumption that failed before it could decide has no Action.
type Consumption struct {
	Action  string   `json:"action"`
	Members []string `json:"members,omitempty"`
	Turn    bool     `json:"turn,omitempty"`
	Held    string   `json:"held,omitempty"`
	// Followup marks a wake sent while the worker was busy in a turn.
	Followup bool `json:"followup,omitempty"`
	// Launching marks a wait for a fiber with no worker while a launch
	// reserved earlier is in its lease.
	Launching bool `json:"launching,omitempty"`
	// Message is the state of the worker's Message entry after the pass:
	// delivered, sent (its send's outcome is not yet confirmed), reserved
	// (a launch in its lease is for it), pending, or unknown (it expired, or
	// the inbox does not hold it).
	Message string `json:"message,omitempty"`
}

// Consume advances every open batch, then selects, claims and delivers one
// turn under the fiber inbox lock. A fresh or launch answer reserves a launch
// for the asking entries (launchReservation) for launchLease: until the
// receiver changes, until the caller retries without Costly after a refused
// fresh launch, or until the launched session takes them. A fiber without a
// worker (Address "-") advances no batch and answers launch or wait; its
// batches that ask for a turn ask for a launch too, and the launched session's
// consume then advances them. A tracked worker whose conversation is not yet
// known (Address "-" with its epoch) waits.
func Consume(ctx context.Context, env *sysenv.Env, fiber, host string, worker Worker) (Consumption, error) {
	return consumeWith(ctx, env, fiber, host, worker, sendFiberContextAttempt)
}

// A pass that fails before it decides, as for a receiver whose process is
// gone, still answers wait for a Message already delivered.
func consumeWith(ctx context.Context, env *sysenv.Env, fiber, host string, w Worker, send fiberContextSender) (Consumption, error) {
	result, err := consumePass(ctx, env, fiber, host, w, send)
	if w.Message == "" {
		return result, err
	}
	state := messageState(mailboxDir(env, "fiber", fiber), w.Message, time.Now())
	if result.Action == "" && state == "delivered" {
		result.Action = "wait"
	}
	if result.Action != "" {
		result.Message = state
	}
	return result, err
}

// messageState reads one entry's state after a pass (Consumption.Message).
// An entry offered with no disposition was delivered; one that expired, or
// that the inbox does not hold, is unknown.
func messageState(root, id string, now time.Time) string {
	_, err := readFiberMailboxEntry(filepath.Join(root, "pending", mailboxKey(id)+".json"))
	if err != nil {
		if offered, err := readFiberMailboxEntry(filepath.Join(root, "offered", mailboxKey(id)+".json")); err == nil && offered.Disposition == "" {
			return "delivered"
		}
		return "unknown"
	}
	if pinned, _ := pinnedBy(root); pinned[id] != nil && !pinned[id].Hook {
		return "sent"
	}
	if r, err := readLaunchReservation(root); err == nil && r.holds(id, now) {
		return "reserved"
	}
	return "pending"
}

func consumePass(ctx context.Context, env *sysenv.Env, fiber, host string, w Worker, send fiberContextSender) (Consumption, error) {
	result := Consumption{Action: "wait"}
	// "-" with an epoch is a tracked worker whose conversation is not yet
	// known: nothing can reach it, so it waits. "-" with epoch 0 is a fiber
	// with no worker.
	dormant := w.Address == "-" && w.Epoch == 0
	if w.Address == "-" && !dormant {
		return result, verifyUnaddressedReceiver(env, fiber, host, w.Epoch)
	}
	var a Address
	hook := false
	if !dormant {
		var err error
		if a, err = ParseAddress(w.Address); err != nil {
			return Consumption{}, err
		}
		if a.Host != host {
			return Consumption{}, errCode("wrong_host", "fiber context belongs to another host")
		}
		if a.Harness == "codex" {
			_ = discoverCodexTerminalReceiver(ctx, env, a)
		}
		hook = MailboxAvailable(env, a.Harness, a.ID, host)
	}
	root := mailboxDir(env, "fiber", fiber)
	if err := ensureDir(root, 0700); err != nil {
		return Consumption{}, err
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
	if !dormant && (receiverEpoch(root, w.Address) != w.Epoch || !fiberReceiverMatches(root, a)) {
		return Consumption{}, errCode("stale_receiver", "superseded worker identity")
	}
	if a.Harness == "claude" && !hook {
		return Consumption{}, errCode("unavailable", "%s", mailboxUnavailable(env, a.Harness, a.ID, host))
	}
	if err := pruneOffered(root, time.Now()); err != nil {
		return Consumption{}, err
	}
	current := func(c context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(c, env, r) }
	reservation, err := readLaunchReservation(root)
	if err != nil {
		return Consumption{}, err
	}
	// Each open batch advances on its own, so one awaiting its outcome holds
	// only its own members. A hook's claim left open is closed by its recorded
	// outcome, else ambiguous. A fiber without a worker has no conversation to
	// advance a batch to: it settles only what the batch's own records decide
	// (a confirmed receipt, a superseded member), and the rest wait for the
	// next receiver.
	errs := []error{}
	_, batches, err := openBatches(root)
	if err != nil {
		return Consumption{}, err
	}
	// A batch whose members could not be checked does not authorize a launch
	// on this pass; it stays pending for the next.
	unverified := map[string]bool{}
	for i := range batches {
		b := &batches[i]
		switch {
		case b.Hook:
			errs = append(errs, closeBatch(root, b, attemptAmbiguous))
		case dormant:
			if _, err := reconcileConsumedBatch(ctx, env, root, b); err != nil {
				errs = append(errs, err)
				for _, id := range b.Members {
					unverified[id] = true
				}
			}
		default:
			sent, err := advanceBatch(ctx, env, root, host, w, b, send)
			if sent {
				result.Action, result.Members = "context", append(result.Members, b.Members...)
				if b.Payload.Wake {
					result.Action, result.Followup = "wake", w.Busy
				}
			}
			errs = append(errs, err)
		}
	}
	items, _, err := openBatches(root)
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
			// Marked, so offered/ never reads as its delivery.
			it.entry.Disposition = "expired"
			if err := writeMailboxEntryKeepingTime(it.path, it.entry); err != nil {
				return Consumption{}, err
			}
			if err := moveToOffered(root, it.path); err != nil {
				return Consumption{}, err
			}
			continue
		}
		candidates = append(candidates, it)
	}
	// A fiber without a worker launches for its batches that ask for a turn
	// as for its free entries, unless a launch in its lease still owes any of
	// them.
	var held []string
	inFlight := false
	if dormant {
		pending, err := pendingItems(root)
		if err != nil {
			return Consumption{}, err
		}
		for _, id := range heldAsking(pending, items, now) {
			if !unverified[id] {
				held = append(held, id)
			}
		}
		inFlight = reservation.inFlight(pending, now)
	}
	// Deciding reads entries unchecked; only a reservation or a wake checks
	// thread signals' currency, and decides again over the current ones.
	// A receiver without a hook takes quiet context directly; a harness that
	// takes pasted input (Codex, Antigravity) leaves it to its fiber hook.
	direct := !dormant && !hook && !PastedTransport(a.Harness+"-terminal")
	decide := func(due []mailboxPendingItem) (string, bool) {
		if dormant {
			return decideLaunch(due, held, inFlight), false
		}
		action, turn := decideConsumption(due, w, direct, reservation, now)
		if action == "wait" && w.Busy {
			for _, it := range due {
				if it.entry.Wishes.Turn != "ask" || reservation.holds(it.entry.Request.MessageID, now) {
					continue
				}
				if a.Harness != "claude" || now.Sub(it.entry.availableAt()) >= 30*time.Second {
					return "wake", false
				}
			}
		}
		return action, turn
	}
	action, turn := decide(candidates)
	if action == "wait" {
		result.Turn, result.Launching = turn, inFlight
		if w.Costly && turn == false {
			result.Held = "cost"
		}
		return result, errors.Join(errs...)
	}
	due, validationErr := validateMailboxItems(root, candidates, current)
	errs = append(errs, validationErr)
	action, result.Turn = decide(due)
	if action == "wait" {
		result.Launching = inFlight
		return result, errors.Join(errs...)
	}
	if action == "fresh" || action == "launch" {
		var members []string
		for _, it := range due {
			if it.entry.Wishes.Turn != "none" {
				members = append(members, it.entry.Request.MessageID)
			}
		}
		members = append(members, held...)
		if err := reserveLaunch(root, w, members, now); err != nil {
			return Consumption{}, err
		}
		return Consumption{Action: action, Members: members}, errors.Join(errs...)
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
		if (action == "context" && it.entry.Wishes.Turn != "none") || (it.entry.Wishes.Turn == "idle" && (!w.Idle || w.Unknown)) {
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
	attempt := newConsumedAttempt(w, selected, action == "wake")
	sent, err := sendBatch(ctx, env, root, host, &attempt, send)
	if sent {
		result.Action, result.Members = action, append(result.Members, attempt.Members...)
		result.Followup = result.Followup || (w.Busy && action == "wake")
	}
	return result, errors.Join(append(errs, err)...)
}

// verifyUnaddressedReceiver checks that the fiber's receiver is still the
// tracked worker at epoch whose conversation is unknown.
func verifyUnaddressedReceiver(env *sysenv.Env, fiber, host string, epoch uint64) error {
	root := mailboxDir(env, "fiber", fiber)
	if err := ensureDir(root, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	receiver, err := readFiberReceiver(root)
	if err != nil || receiver.Generation != epoch || receiver.Address != (Address{Host: host}) {
		return errCode("stale_receiver", "superseded worker identity")
	}
	return nil
}

// heldAsking lists the due entries among pending that ask for a turn and that
// an open batch holds (those not among free): a batch pinned to a conversation
// that has since ended, waiting for a receiver to advance it.
func heldAsking(pending, free []mailboxPendingItem, now time.Time) []string {
	isFree := map[string]bool{}
	for _, it := range free {
		isFree[it.entry.Request.MessageID] = true
	}
	var held []string
	for _, it := range pending {
		if id := it.entry.Request.MessageID; !isFree[id] && it.entry.Wishes.Turn != "none" && it.entry.due(now) {
			held = append(held, id)
		}
	}
	return held
}

// decideLaunch answers launch or wait for a fiber without a worker: launch
// when a due entry asks for a turn, free or held by an open batch, and no
// launch is in flight.
func decideLaunch(due []mailboxPendingItem, held []string, inFlight bool) string {
	if inFlight {
		return "wait"
	}
	asking := len(held) > 0
	for _, it := range due {
		asking = asking || it.entry.Wishes.Turn != "none"
	}
	if asking {
		return "launch"
	}
	return "wait"
}

// decideConsumption answers wait, fresh or wake for a live worker over the due
// entries no open batch holds, or context when it would wait and a direct
// receiver has quiet entries. turn reports that the worker's idle and cost
// facts would decide the entries asking for a turn.
func decideConsumption(due []mailboxPendingItem, w Worker, direct bool, reservation launchReservation, now time.Time) (action string, turn bool) {
	force, asking, wants, fresh, launching, quiet := false, false, false, false, false, false
	for _, it := range due {
		e := it.entry
		// Within its lease, a reservation holds the reserving worker's wake
		// while the launch is in flight, and leaves a new receiver, the
		// launched session, to take the entry through its hook.
		if reservation.holds(e.Request.MessageID, now) {
			if !reservation.requestedBy(w) {
				continue
			}
			launching = true
			if e.Wishes.Turn == "force" {
				continue
			}
		}
		// An idle entry starts a turn only in a worker observed idle.
		wanted := e.Wishes.Turn == "ask" || (e.Wishes.Turn == "idle" && w.Idle && !w.Unknown)
		switch e.Wishes.Turn {
		case "force":
			force = true
		case "ask", "idle":
			asking = true
		case "none":
			quiet = true
		}
		wants = wants || wanted
		fresh = fresh || (wanted && e.Wishes.IfCostly == "fresh")
	}
	action = "wait"
	switch {
	case force:
		return "wake", false
	case !w.Idle:
		turn = asking
	case !wants:
	case !w.Costly:
		return "wake", false
	case !launching && fresh:
		return "fresh", false
	}
	if direct && quiet {
		action = "context"
	}
	return action, turn
}

// openBatches reads the pending entries no open batch holds, and every open
// batch, one per manifest under batches/.
func openBatches(root string) ([]mailboxPendingItem, []Attempt, error) {
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
		if !pinned[it.entry.Request.MessageID] {
			free = append(free, it)
		}
	}
	return free, batches, nil
}

func newConsumedAttempt(w Worker, items []mailboxPendingItem, wake bool) Attempt {
	members := make([]string, len(items))
	texts := make([]string, len(items))
	repeat := false
	for i, it := range items {
		members[i] = it.entry.Request.MessageID
		texts[i] = Labeled(it.entry.Request)
		repeat = repeat || it.entry.PossibleRepeat
	}
	req := Request{Text: strings.Join(texts, "\n\n"), From: "shuttle", Wake: wake}
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

// sendBatch records the batch's manifest, with where its conversation's
// transcript ends, before sending its payload, and records the transport's
// receipt in it after. A confirmed receipt closes the batch delivered and a
// rejection releases it. It reports whether the payload may have reached the
// conversation.
func sendBatch(ctx context.Context, env *sysenv.Env, root, host string, a *Attempt, send fiberContextSender) (bool, error) {
	a.Receipt, a.ErrorCode, a.TranscriptOffset = nil, "", transcriptEnd(env, a.Conversation)
	if err := writeBatch(root, a); err != nil {
		return false, err
	}
	receipt, err := send(ctx, env, host, *a.Payload, a.Conversation)
	a.Receipt = &receipt
	if err != nil {
		a.ErrorCode = ErrorCode(err)
	}
	if a.confirmed() {
		return true, closeDeliveredBatch(env, root, a)
	}
	if err == nil {
		err = a.sendError()
	}
	if a.status() == StatusRejected {
		return false, errors.Join(err, closeBatch(root, a, attemptReleased))
	}
	return true, errors.Join(err, writeBatch(root, a))
}

// reconcileConsumedBatch settles what an open batch's own records decide,
// sending nothing: a recorded outcome finishes its close; its receipt,
// observed again from the conversation's transcript, closes it delivered once
// confirmed; and a superseded member drops it, returning the rest to the inbox
// as ambiguous, since the payload may have arrived. It reports whether the
// batch closed.
func reconcileConsumedBatch(ctx context.Context, env *sysenv.Env, root string, a *Attempt) (bool, error) {
	if a.Outcome != "" {
		return true, closeBatch(root, a, a.Outcome)
	}
	if observeBatch(env, a) {
		if err := writeBatch(root, a); err != nil {
			return false, err
		}
	}
	if a.confirmed() {
		return true, closeDeliveredBatch(env, root, a)
	}
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
		if err != nil {
			return false, err
		}
		if !current {
			superseded = append(superseded, path)
		}
	}
	if len(superseded) == 0 {
		return false, nil
	}
	// Closed first: a superseded member left pending by a crash is free, and
	// the next pass's currency check drops it.
	if err := closeBatch(root, a, attemptAmbiguous); err != nil {
		return false, err
	}
	for _, path := range superseded {
		if err := moveToOffered(root, path); err != nil {
			return true, err
		}
	}
	return true, nil
}

// advanceBatch advances an open batch for the live worker w, never sending
// the same payload twice. Its own records settle it first
// (reconcileConsumedBatch); what remains is a send whose outcome is not
// confirmed. It rolls forward to w once its conversation has ended, or
// liveAttemptRetryAfter after its send to a conversation w has replaced; and
// to a conversation still w, it makes one warning-marked retry once its
// outcome has stayed unknown for liveAttemptRetryAfter, or queued or
// submitted for queuedAttemptRetryAfter.
// A receiver holding it for approval is not retried, and a quiet payload is
// never sent again: its members return to the fiber's hooks marked
// possible_repeat. It reports whether the payload may have reached the
// conversation.
func advanceBatch(ctx context.Context, env *sysenv.Env, root, host string, w Worker, a *Attempt, send fiberContextSender) (bool, error) {
	if closed, err := reconcileConsumedBatch(ctx, env, root, a); closed || err != nil {
		return false, err
	}
	replaced := a.Conversation != w.Address
	age, status := time.Since(time.Unix(0, a.OpenedAt)), a.status()
	stale := a.ErrorCode != "wake_held" && age >= liveAttemptRetryAfter
	waited := status == StatusUnknown || ((status == StatusQueued || status == StatusSubmitted) && age >= queuedAttemptRetryAfter)
	retry := !replaced && stale && waited && a.Retry == 0
	roll := replaced && (stale || fiberContextSessionEnded(env, host, a.Conversation))
	if !retry && !roll {
		return true, a.sendError()
	}
	if !a.Payload.Wake {
		return false, closeBatch(root, a, attemptAmbiguous)
	}
	next := *a
	next.Conversation, next.Epoch, next.OpenedAt = w.Address, w.Epoch, time.Now().UnixNano()
	next.Retry, next.Variant = 0, "possible-repeat"
	if retry {
		next.Retry, next.Variant = 1, "retry-1"
	}
	req := consumedVariant(next)
	next.Payload = &req
	*a = next
	return sendBatch(ctx, env, root, host, a, send)
}

// observeBatch reads the batch's conversation transcript again, from where it
// ended before the send to where it ends now, without waiting, and records the
// furthest stage it shows in the receipt, including for a send whose receipt
// was never recorded. It reports whether the receipt changed.
func observeBatch(env *sysenv.Env, a *Attempt) bool {
	if a.TranscriptOffset == nil || a.confirmed() {
		return false
	}
	req := *a.Payload
	req.Address = a.Conversation
	before := Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown}
	if a.Receipt != nil {
		before = *a.Receipt
	}
	receipt, code := before, a.ErrorCode
	switch address, _ := ParseAddress(a.Conversation); address.Harness {
	case "claude":
		receipt, code = observeClaudeNative(env, req, *a.TranscriptOffset, receipt, code)
	case "pi":
		if observePiNative(env, req, *a.TranscriptOffset) {
			receipt, code = piTranscriptReceipt(req), ""
		}
	}
	if receipt.Status == before.Status && receipt.Detail == before.Detail && code == a.ErrorCode {
		return false
	}
	a.Receipt, a.ErrorCode = &receipt, code
	return true
}

// transcriptEnd is where the registered transcript of a Claude or Pi
// conversation ends now, zero when it does not exist yet, and nil when the
// conversation has none.
func transcriptEnd(env *sysenv.Env, conversation string) *int64 {
	a, err := ParseAddress(conversation)
	if err != nil {
		return nil
	}
	var path string
	switch a.Harness {
	case "claude":
		r, err := readClaudeNative(env, a.ID)
		if err == nil {
			path = r.Transcript
		}
	case "pi":
		r, err := readPiNative(env, a.ID)
		if err == nil {
			path = r.Transcript
		}
	}
	if path == "" {
		return nil
	}
	var end int64
	if info, err := os.Stat(path); err == nil {
		end = info.Size()
	}
	return &end
}

// closeDeliveredBatch closes a batch whose payload its conversation
// confirmed, subscribing that conversation to the idle notices its members
// asked for.
func closeDeliveredBatch(env *sysenv.Env, root string, a *Attempt) error {
	for _, id := range a.Members {
		e, err := readFiberMailboxEntry(filepath.Join(root, "pending", mailboxKey(id)+".json"))
		if err == nil && e.Request.NotifyWhenIdle {
			req := e.Request
			req.Address = a.Conversation
			address, _ := ParseAddress(a.Conversation)
			subscribeIdle(env, address, req)
		}
	}
	return closeBatch(root, a, attemptDelivered)
}

// confirmed reports a receipt that delivered every member as sent.
func (a *Attempt) confirmed() bool {
	return a.Receipt != nil && a.ErrorCode == "" && confirmedReceipt(*a.Receipt)
}

func confirmedReceipt(r Receipt) bool {
	return r.Status == StatusAccepted || r.Status == StatusContextAdded || (r.Status == StatusSubmitted && PastedTransport(r.Transport))
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
