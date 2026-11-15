package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

type fiberMailboxLink struct {
	Fiber string `json:"fiber"`
	Host  string `json:"host"`
}

// The inbox key supplies the destination; session aliases and refreshed
// retention metadata do not change a retry's semantic identity.
// Wake is owner-derived routing, dependent on worker liveness.
func fiberRequestIdentity(r Request) string {
	r.Address = ""
	r.Wake = false
	signal, _ := json.Marshal(r.ThreadSignal)
	return requestHash(r) + string(signal)
}

func requestExpired(request Request, now time.Time) bool {
	stamps := []string{request.RetainedAt}
	if request.ThreadSignal != nil {
		stamps = append(stamps, request.ThreadSignal.Stamp)
	}
	for _, stamp := range stamps {
		if stamp == "" {
			continue
		}
		retainedAt, err := time.Parse(time.RFC3339Nano, stamp)
		if err == nil && now.Sub(retainedAt) > mailboxRetention {
			return true
		}
	}
	return false
}

// Worker transitions alone publish authority. Delivery and hook subscriptions
// cannot change it. Identity includes the execution and conversation identity.
type FiberReceiver struct {
	Address
	Identity   string `json:"identity"`
	Generation uint64 `json:"generation"`
}

// TransitionFiberReceiver runs synchronously in the owner's serialized worker
// transition. Re-adoption of an unchanged worker preserves its durable epoch.
// A removed or not-yet-addressable worker uses address "-".
func TransitionFiberReceiver(env *sysenv.Env, fiber, host, identity, address string) (uint64, error) {
	return transitionFiberReceiver(env, fiber, host, identity, address, true)
}

// RevokeExistingFiberReceiver revokes the receiver of a fiber that already has
// a mailbox, and reports whether it had one. A fiber without a mailbox has no
// receiver to fence, so no state is created for it.
func RevokeExistingFiberReceiver(env *sysenv.Env, fiber, host string) (bool, error) {
	epoch, err := transitionFiberReceiver(env, fiber, host, "", "-", false)
	return epoch != 0, err
}

func transitionFiberReceiver(env *sysenv.Env, fiber, host, identity, address string, create bool) (uint64, error) {
	a := Address{Host: host}
	var err error
	if address != "-" {
		a, err = ParseAddress(address)
	}
	if err != nil {
		return 0, err
	}
	if a.Host != host {
		return 0, errCode("wrong_host", "fiber receiver belongs to another host")
	}
	root := mailboxDir(env, "fiber", fiber)
	if create {
		if err := ensureDir(root, 0700); err != nil {
			return 0, err
		}
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if !create && errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return 0, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	path := filepath.Join(root, "destination.json")
	bytes, err := readBounded(path, 16384)
	var old FiberReceiver
	if err == nil {
		if err := json.Unmarshal(bytes, &old); err != nil {
			return 0, err
		}
		if old.Identity == identity && old.Address == a && old.Generation != 0 {
			return old.Generation, linkFiberReceiver(env, fiber, a)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	if old.Generation == ^uint64(0) {
		return 0, errors.New("fiber epoch exhausted")
	}
	next := FiberReceiver{Address: a, Identity: identity, Generation: old.Generation + 1}
	bytes, err = json.Marshal(next)
	if err != nil {
		return 0, err
	}
	if err := mailboxWrite(path, bytes, false); err != nil {
		return 0, err
	}
	return next.Generation, linkFiberReceiver(env, fiber, a)
}

// linkFiberReceiver points the receiver session's hooks at the fiber inbox,
// so a session launched for the fiber finds its entries on its first prompt,
// before it has registered a hook. Offering checks the fiber's receiver
// authority each time, so a link left by a replaced receiver offers nothing.
func linkFiberReceiver(env *sysenv.Env, fiber string, a Address) error {
	if a.Harness == "" {
		return nil
	}
	bytes, err := json.Marshal(fiberMailboxLink{Fiber: fiber, Host: a.Host})
	if err != nil {
		return err
	}
	dir := filepath.Join(mailboxDir(env, a.Harness, a.ID), "fibers")
	if err := ensureDir(dir, 0700); err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(dir, mailboxKey(fiber)+".json"), bytes, false)
}

// ReadFiberReceiver reads the durable worker-owned authority for restart
// recovery. A missing record is distinct from an explicit unknown receiver;
// corrupt or unreadable records are errors, never permission to reset identity.
func ReadFiberReceiver(env *sysenv.Env, fiber string) (*FiberReceiver, error) {
	root := mailboxDir(env, "fiber", fiber)
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	receiver, err := readFiberReceiver(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if receiver.Generation == 0 {
		return nil, errors.New("invalid fiber receiver epoch")
	}
	return &receiver, nil
}

// Called only under the mailbox lock, including during output emission.
func readFiberReceiver(root string) (FiberReceiver, error) {
	bytes, err := readBounded(filepath.Join(root, "destination.json"), 16384)
	var receiver FiberReceiver
	if err == nil {
		err = json.Unmarshal(bytes, &receiver)
	}
	return receiver, err
}

// fiberReceiverMatches is called only while the fiber mailbox lock is held.
// Missing or malformed authority fails closed; registration cannot restore it.
func fiberReceiverMatches(root string, a Address) bool {
	bytes, err := readBounded(filepath.Join(root, "destination.json"), 16384)
	var receiver FiberReceiver
	return err == nil && json.Unmarshal(bytes, &receiver) == nil && receiver.Address == a && receiver.Generation != 0 && receiver.Identity != ""
}

// offerLinkedFiberContext uses the fiber mailbox's own lock and acknowledgment
// boundary. Competing hooks (including a successor's) cannot emit it twice.
func offerLinkedFiberContext(env *sysenv.Env, harness, id, host string, emit func([]Request) error) error {
	dir := filepath.Join(mailboxDir(env, harness, id), "fibers")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	conversation, err := FormatAddress(host, harness, id)
	if err != nil {
		return err
	}
	var validationErrors []error
	for _, entry := range entries {
		bytes, err := readBounded(filepath.Join(dir, entry.Name()), 16384)
		var link fiberMailboxLink
		if err != nil || json.Unmarshal(bytes, &link) != nil || link.Fiber == "" || link.Host != host || entry.Name() != mailboxKey(link.Fiber)+".json" {
			continue
		}
		offered := false
		root := mailboxDir(env, "fiber", link.Fiber)
		err = offerMailboxWithAck(root, conversation, func(r Request) bool {
			return fiberContextHookEligible(root, conversation, r) && fiberReceiverMatches(root, Address{Host: host, Harness: harness, ID: id}) && MailboxAvailable(env, harness, id, host)
		}, func(batch []Request) error {
			offered = true
			return emit(batch)
		}, func(ctx context.Context, r Request) (bool, error) { return currentThreadSignalWithBackoff(ctx, env, r) }, harness)
		if err != nil {
			validationErrors = append(validationErrors, err)
		}
		if offered {
			return errors.Join(validationErrors...)
		}
	}
	return errors.Join(validationErrors...)
}

// fiberContextHookEligible reports whether conversation's hook may take an
// entry: one held by no open batch, and none or ask, or any entry a launch
// another receiver reserved holds in its lease, which the launched session
// takes whole.
func fiberContextHookEligible(root, conversation string, request Request) bool {
	batches, err := readBatchManifests(root)
	if err != nil {
		return false
	}
	for _, b := range batches {
		if slices.Contains(b.Members, request.MessageID) {
			return false
		}
	}
	entry, err := readFiberMailboxEntry(filepath.Join(root, "pending", mailboxKey(request.MessageID)+".json"))
	if err != nil || entry.AttemptAddress != "" {
		return false
	}
	if entry.Wishes.Turn == "none" || entry.Wishes.Turn == "ask" {
		return true
	}
	reservation, err := readLaunchReservation(root)
	return err == nil && reservation.holds(request.MessageID, time.Now()) && reservation.Conversation != conversation
}

// DeliverFiberContext consumes without turn facts. Only force entries initiate
// a wake; ask remains available to the fiber's hook, and none goes to the hook
// or, for a receiver without one, as context.
func DeliverFiberContext(ctx context.Context, env *sysenv.Env, fiber, host, address string, generation uint64) error {
	_, err := Consume(ctx, env, fiber, host, Worker{Address: address, Epoch: generation})
	return err
}

type fiberContextSender func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error)

// freezeLegacyAttempt pins the old transport id and reconstructs the caveat
// variant from the receipt's content hash when the payload is absent.
func freezeLegacyAttempt(env *sysenv.Env, entry mailboxEntry) (mailboxEntry, error) {
	request := entry.Request
	request.ThreadSignal = nil
	payload := attemptRequest(request, entry)
	address := entry.AttemptAddress
	path := filepath.Join(dataDir(env), "messages", mailboxKey(payload.MessageID+"-"+mailboxKey(address)[:16])+".json")
	stored, err := readDedupRecord(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return entry, err
	}
	if err == nil {
		for _, text := range []string{strings.TrimPrefix(request.Text, staleThreadSignalCaveat), withStalenessCaveat(request.Text)} {
			candidate := request
			candidate.Text = text
			candidate = attemptRequest(candidate, entry)
			candidate.Address = address
			if requestHash(candidate) == stored.Hash {
				payload = candidate
				request.Text = text
				break
			}
		}
	}
	entry.Attempt.Payload, entry.Attempt.BaseText = &payload, request.Text
	return entry, nil
}

// attemptRequest is the request a build before batch payloads sent for a
// pinned entry, under the transport id it used.
func attemptRequest(request Request, entry mailboxEntry) Request {
	switch {
	case entry.Attempt != nil && entry.Attempt.Retry > 0:
		request.MessageID += fmt.Sprintf("-retry-%d", entry.Attempt.Retry)
		request.Text = "Possible repeat: an earlier delivery of this message to this session had an unknown outcome.\n\n" + request.Text
	case entry.PossibleRepeat:
		request.Text = "Possible repeat: delivery to a previous worker had an unknown outcome before its session ended.\n\n" + request.Text
	}
	return request
}

func fiberContextSessionEnded(env *sysenv.Env, host, address string) bool {
	a, err := ParseAddress(address)
	return err == nil && a.Host == host && mailboxReceiverEnded(env, a.Harness, a.ID, host)
}

func sendFiberContextAttempt(ctx context.Context, env *sysenv.Env, host string, request Request, address string) (Receipt, error) {
	request.Address = address
	// Keep one stable dedup key for retries to a destination, with an
	// independent key when a rejected or authoritatively ended destination is replaced.
	request.MessageID += "-" + mailboxKey(address)[:16]
	receipt, err := Send(ctx, env, host, request)
	if err != nil {
		return receipt, err
	}
	if receipt.Status != StatusContextAdded && receipt.Status != StatusAccepted {
		submittedCodexWake := receipt.Status == StatusSubmitted && receipt.Transport == "codex-terminal" && request.Wake
		if !submittedCodexWake {
			return receipt, errCode("unconfirmed", "context delivery: %s", receipt.Status)
		}
	}
	return receipt, nil
}

func readFiberMailboxEntry(path string) (mailboxEntry, error) {
	bytes, err := readBounded(path, 512<<10)
	if err != nil {
		return mailboxEntry{}, err
	}
	var entry mailboxEntry
	if err := json.Unmarshal(bytes, &entry); err != nil {
		return mailboxEntry{}, err
	}
	return entry, nil
}

func currentThreadSignal(ctx context.Context, env *sysenv.Env, request Request) (bool, error) {
	if !strings.HasPrefix(request.MessageID, "thread-") {
		return true, nil
	}
	if isUnblockedNotice(request.Text) {
		return true, nil
	}
	check := ThreadSignalCheck{Signal: request.ThreadSignal, MessageID: request.MessageID, Text: request.Text}
	bytes, err := json.Marshal(check)
	if err != nil {
		return false, err
	}
	cmd := env.CommandContext(ctx, "shuttle", "thread-signal-current", string(bytes))
	output, err := cmd.Output()
	if err != nil {
		if isThreadSignalContractSkew(err) {
			return false, threadSignalSkewError{err: fmt.Errorf("checking current thread signal %s: %w", request.MessageID, err)}
		}
		return false, fmt.Errorf("checking current thread signal %s: %w", request.MessageID, err)
	}
	var answer struct {
		Current *bool `json:"current"`
	}
	if err := json.Unmarshal(output, &answer); err != nil {
		return false, fmt.Errorf("decoding current thread signal %s: %w", request.MessageID, err)
	}
	if answer.Current == nil {
		return false, fmt.Errorf("checking current thread signal %s: response has no current field", request.MessageID)
	}
	return *answer.Current, nil
}

type threadSignalSkewError struct{ err error }

func (e threadSignalSkewError) Error() string { return e.err.Error() }
func (e threadSignalSkewError) Unwrap() error { return e.err }

func isThreadSignalContractSkew(err error) bool {
	message := err.Error()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
		message += " " + string(exitErr.Stderr)
	}
	lowerMessage := strings.ToLower(message)
	if strings.Contains(lowerMessage, "unknown command") && strings.Contains(lowerMessage, "thread-signal-current") {
		return true
	}
	if !strings.Contains(lowerMessage, "/api/v1/thread-signals/current") {
		return false
	}
	const status = "returned 404:"
	index := strings.Index(lowerMessage, status)
	if index < 0 {
		return false
	}
	var response struct {
		Errors struct {
			Detail string `json:"detail"`
		} `json:"errors"`
	}
	return json.Unmarshal([]byte(strings.TrimSpace(message[index+len(status):])), &response) == nil && response.Errors.Detail == "Not Found"
}

func hasThreadSignalValidation(request Request) bool {
	return strings.HasPrefix(request.MessageID, "thread-") && !isUnblockedNotice(request.Text)
}

const staleThreadSignalCaveat = "Staleness caveat: this host's shuttle CLI and daemon do not share the thread-signal validation route, so this lifecycle notice could not be checked for currentness.\n\n"

func withStalenessCaveat(text string) string {
	if strings.HasPrefix(text, staleThreadSignalCaveat) {
		return text
	}
	return staleThreadSignalCaveat + text
}

func isUnblockedNotice(text string) bool {
	fields := strings.SplitN(text, " ", 4)
	return len(fields) == 4 && fields[0] == "thread" && fields[1] != "" && fields[2] == "unblocked:"
}
