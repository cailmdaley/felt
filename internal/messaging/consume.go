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
}

// Consumption describes the action taken (wake, or context for quiet entries
// sent to a receiver without a hook), or the launch the daemon must perform:
// fresh, a session replacing a costly live worker, or launch, a session for a
// fiber with none. Turn reports, for a worker not observed idle, that a due
// entry asks for a turn, so the daemon's idle and cost facts would decide it.
// A consumption that failed before it could decide has no Action.
type Consumption struct {
	Action   string   `json:"action"`
	Members  []string `json:"members,omitempty"`
	Turn     bool     `json:"turn,omitempty"`
	Session  string   `json:"session,omitempty"`
	Held     string   `json:"held,omitempty"`
	Followup bool     `json:"followup,omitempty"`
	// Launching marks a wait for a fiber with no worker while a launch
	// reserved earlier is in its lease.
	Launching bool `json:"launching,omitempty"`
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

func consumeWith(ctx context.Context, env *sysenv.Env, fiber, host string, w Worker, send fiberContextSender) (Consumption, error) {
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
	if err := migrateEntryReservations(root); err != nil {
		return Consumption{}, err
	}
	current := func(c context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(c, env, r) }
	reservation, err := readLaunchReservation(root)
	if err != nil {
		return Consumption{}, err
	}
	// Each open batch advances on its own, so one awaiting its outcome holds
	// only its own members. A fiber without a worker has no conversation to
	// advance a batch to: it settles only what local records decide (a
	// confirmed receipt, a superseded member), and the rest wait for the next
	// receiver.
	errs := []error{}
	_, batches, err := openBatches(env, root)
	if err != nil {
		return Consumption{}, err
	}
	// A batch whose members could not be checked does not authorize a launch
	// on this pass; it stays pending for the next.
	unverified := map[string]bool{}
	if dormant {
		for i := range batches {
			if err := settleHeldBatch(ctx, env, root, &batches[i]); err != nil {
				errs = append(errs, err)
				for _, id := range batches[i].Members {
					unverified[id] = true
				}
			}
		}
		batches = nil
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
			result.Action, result.Members = "context", append(result.Members, batches[i].Members...)
			if batches[i].Payload.Wake {
				result.Action = "wake"
			}
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
	for i := range candidates {
		if err := settleUnfinishedHookClaim(&candidates[i]); err != nil {
			return Consumption{}, err
		}
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
	// A receiver without a hook takes quiet context directly; Codex leaves it to
	// its fiber hook.
	direct := !dormant && !hook && a.Harness != "codex"
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
				if a.Harness != "claude" || now.Sub(time.Unix(0, it.entry.QueuedAt)) >= 30*time.Second {
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
		session := ""
		for _, it := range due {
			if it.entry.Wishes.Session == "fresh" {
				session = "fresh"
			}
		}
		return Consumption{Action: action, Members: members, Session: session}, errors.Join(errs...)
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
	if err := pinConsumedBatch(root, &attempt); err != nil {
		return Consumption{}, err
	}
	sent, err := deliverConsumedBatch(ctx, env, root, host, w, &attempt, send)
	if sent {
		result.Action, result.Members = action, append(result.Members, attempt.Members...)
		result.Followup = w.Busy && action == "wake"
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

// settleHeldBatch settles an open batch of a fiber with no worker from local
// records alone (reconcileConsumedBatch), closing it delivered on a confirmed
// receipt.
func settleHeldBatch(ctx context.Context, env *sysenv.Env, root string, a *Attempt) error {
	closed, confirmed, err := reconcileConsumedBatch(ctx, env, root, a)
	if closed || err != nil || !confirmed {
		return err
	}
	return closeDeliveredBatch(env, root, a)
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
	explicitFresh := false
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
			if e.Wishes.Session == "fresh" || e.Wishes.Turn == "force" {
				continue
			}
		}
		explicitFresh = explicitFresh || (e.Wishes.Session == "fresh" && e.Wishes.Turn != "none")
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
	case explicitFresh:
		return "fresh", false
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

// legacyBatch reads an entry pinned without a manifest as a batch of one. An
// attempt without a stored payload was pinned before batches: it keeps the
// transport id it was sent under (see freezeLegacyAttempt), and its wait for
// an unknown outcome starts now.
func legacyBatch(env *sysenv.Env, root string, it mailboxPendingItem) (Attempt, error) {
	e := it.entry
	if e.Attempt.Payload != nil {
		return *e.Attempt, nil
	}
	e, err := freezeLegacyAttempt(env, e)
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

// reconcileConsumedBatch settles what an open batch's local records already
// decide, without emitting anything: a recorded outcome closes it, and a
// superseded member drops it, releasing the rest when the payload never
// reached the conversation or holding them as ambiguous when it may have.
// confirmed reports a locally recorded confirmed receipt for the pinned
// payload, which delivered every member as sent; closed, that the batch is
// closed.
func reconcileConsumedBatch(ctx context.Context, env *sysenv.Env, root string, a *Attempt) (closed, confirmed bool, err error) {
	if a.Outcome != "" {
		return true, false, closeConsumedBatch(root, a, a.Outcome, nil)
	}
	stored, err := readDedupRecord(filepath.Join(dataDir(env), "messages", mailboxKey(a.Payload.MessageID+"-"+mailboxKey(a.Conversation)[:16])+".json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, false, err
	}
	unsent := err != nil || stored.Receipt.Status == StatusRejected
	if stored.State == "complete" && stored.ErrorCode == "" && confirmedReceipt(stored.Receipt) {
		return false, true, nil
	}
	var superseded []string
	for _, id := range a.Members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		e, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, false, err
		}
		if !hasThreadSignalValidation(e.Request) {
			continue
		}
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		current, err := currentThreadSignalWithBackoff(checkCtx, env, e.Request)
		cancel()
		var skew threadSignalSkewError
		if err != nil && !errors.As(err, &skew) {
			return false, false, err
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
			return false, false, err
		}
		for _, path := range superseded {
			if err := moveToOffered(root, path); err != nil {
				return false, false, err
			}
		}
		return true, false, closeConsumedBatch(root, a, a.Outcome, nil)
	}
	return false, false, nil
}

// deliverConsumedBatch sends an open batch's pinned payload and closes it on a
// confirmed receipt. It reports whether the payload may have reached the
// conversation: false when nothing was sent or the final send was rejected.
func deliverConsumedBatch(ctx context.Context, env *sysenv.Env, root, host string, w Worker, a *Attempt, send fiberContextSender) (bool, error) {
	if closed, _, err := reconcileConsumedBatch(ctx, env, root, a); closed || err != nil {
		return false, err
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
			return false, closeConsumedBatch(root, a, attemptReleased, err)
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
		return true, closeDeliveredBatch(env, root, a)
	}
	if err == nil {
		err = errCode("unconfirmed", "batch delivery: %s", receipt.Status)
	}
	if receipt.Status == StatusRejected {
		return false, closeConsumedBatch(root, a, attemptReleased, err)
	}
	return true, err
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
	return closeConsumedBatch(root, a, attemptDelivered, nil)
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

// settleUnfinishedHookClaim closes an open, unpinned claim as ambiguous. Read
// under the inbox lock, such a claim belongs to a hook that died between its
// output and its close.
func settleUnfinishedHookClaim(it *mailboxPendingItem) error {
	if !it.entry.Attempt.open() || it.entry.AttemptAddress != "" {
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
