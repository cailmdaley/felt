package shuttlecli

import (
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

type messageTargetCandidate struct {
	Address string
	Fiber   string
}

var ulidSessionIDPattern = regexp.MustCompile(`(?i)^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

// looksLikeNativeSessionID only controls lookup order; every other target can
// still resolve as a native id after the local fiber lookup.
func looksLikeNativeSessionID(target string) bool {
	return sessionUUIDPattern.MatchString(target) || ulidSessionIDPattern.MatchString(target)
}

// resolveMessageTarget canonicalizes explicit addresses, checks both session
// sources for bare ids, and resolves other targets locally before making network
// requests. If both a session and a fiber match, it refuses to choose.
func resolveMessageTarget(target string) (string, error) {
	if strings.HasPrefix(target, "shuttle://") {
		address, err := messaging.ParseAddress(target)
		if err != nil {
			return "", err
		}
		return messaging.FormatAddress(address.Host, address.Harness, address.ID)
	}
	if target == "" {
		return "", fmt.Errorf("message target is empty")
	}

	sessionShaped := looksLikeNativeSessionID(target)
	fiberLookup := addressFiberLookup{}
	if !sessionShaped {
		var err error
		fiberLookup, err = lookupShuttleAddressFibers(target)
		if err != nil {
			return "", err
		}
	}

	var lookupErrors []string
	sessionCandidates := make([]messageTargetCandidate, 0)
	var peerSessions []messaging.Session
	directory, liveErr := fetchPeerDirectory("", "")
	if liveErr != nil {
		lookupErrors = append(lookupErrors, "session discovery: "+liveErr.Error())
	} else {
		peerSessions = directory.Sessions
		sessionCandidates = append(sessionCandidates, discoveredMessageCandidates(target, peerSessions)...)
	}

	var ledgerRecords []SessionProvenance
	var ledgerOrigins map[string]any
	var unmappedLedger []string
	ledger, ledgerErr := fetchSessionLedger()
	if ledgerErr != nil {
		lookupErrors = append(lookupErrors, "session ledger: "+ledgerErr.Error())
	} else {
		ledgerRecords = ledger.Records
		ledgerOrigins = ledger.Origins
		ledgerCandidates, unresolved := ledgerMessageCandidates(target, ledgerRecords, peerSessions)
		sessionCandidates = append(sessionCandidates, ledgerCandidates...)
		unmappedLedger = unresolved
	}

	if sessionShaped {
		var err error
		fiberLookup, err = lookupShuttleAddressFibers(target)
		if err != nil {
			return "", err
		}
	}
	sessionCandidates = uniqueMessageCandidates(sessionCandidates)
	if len(unmappedLedger) > 0 {
		return "", fmt.Errorf("message target %q is ambiguous or has an unmapped Codex transcript candidate; use a peer address or explicit shuttle:// address: %s", target, messageTargetLabels(sessionCandidates, fiberLookup, unmappedLedger))
	}
	matchCount := len(sessionCandidates) + fiberLookup.candidateCount()
	if fiberLookup.refused() || matchCount > 1 {
		return "", fmt.Errorf("message target %q is ambiguous or guessed; candidates: %s", target, messageTargetLabels(sessionCandidates, fiberLookup, nil))
	}
	if len(sessionCandidates) == 1 {
		return sessionCandidates[0].Address, nil
	}
	if len(fiberLookup.Fibers) == 1 {
		if ledgerErr != nil {
			return "", fmt.Errorf("cannot resolve fiber %q: session ledger is unavailable, so its current worker cannot be verified: %w", fiberLookup.Fibers[0].ID, ledgerErr)
		}
		if liveErr != nil {
			return "", fmt.Errorf("cannot resolve fiber %q: session discovery is unavailable, so a session-id collision cannot be ruled out: %w", fiberLookup.Fibers[0].ID, liveErr)
		}
		return currentFiberMessageAddress(fiberLookup.Fibers[0], ledgerRecords, ledgerOrigins, peerSessions)
	}
	if len(lookupErrors) > 0 {
		return "", fmt.Errorf("message target %q did not resolve (%s)", target, strings.Join(lookupErrors, "; "))
	}
	return "", fmt.Errorf("message target %q did not match a discovered session or exact fiber", target)
}

// messageTargetLabels lists every candidate a target could name, sorted, for
// an error that asks the sender to choose.
func messageTargetLabels(sessions []messageTargetCandidate, fibers addressFiberLookup, extra []string) string {
	labels := make([]string, 0, len(sessions)+fibers.candidateCount()+len(extra))
	for _, session := range sessions {
		label := "session " + session.Address
		if session.Fiber != "" {
			label += " (fiber " + session.Fiber + ")"
		}
		labels = append(labels, label)
	}
	for _, fiber := range fibers.candidateLabels() {
		labels = append(labels, "fiber "+fiber)
	}
	labels = append(labels, extra...)
	sort.Strings(labels)
	return strings.Join(labels, ", ")
}

func discoveredMessageCandidates(sessionID string, sessions []messaging.Session) []messageTargetCandidate {
	var candidates []messageTargetCandidate
	for _, session := range sessions {
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.ID != sessionID && session.TranscriptID != sessionID {
			continue
		}
		canonical, err := messaging.FormatAddress(address.Host, address.Harness, address.ID)
		if err != nil {
			continue
		}
		candidates = append(candidates, messageTargetCandidate{Address: canonical, Fiber: session.Fiber})
	}
	return candidates
}

func ledgerMessageCandidates(sessionID string, records []SessionProvenance, sessions []messaging.Session) ([]messageTargetCandidate, []string) {
	var candidates []messageTargetCandidate
	var unmapped []string
	for _, record := range records {
		if record.Session == "" || record.Session != sessionID && record.ThreadID != sessionID {
			continue
		}
		if record.ThreadID == "" && record.Session == sessionID && messaging.NormalizeHarness(record.Harness) == "codex" {
			mapped := peerAddressesForTranscript(record, sessions)
			if len(mapped) > 0 {
				candidates = append(candidates, mapped...)
				continue
			}
			if peerHasNativeCodexAddress(record, sessionID, sessions) {
				continue
			}
			label := fmt.Sprintf("transcript %s for fiber %s has no thread-id mapping", record.Session, record.fiber())
			if possible, err := messaging.FormatAddress(record.Host, record.Harness, record.Session); err == nil {
				label += " (unverified address candidate " + possible + ")"
			}
			unmapped = append(unmapped, label)
			continue
		}
		address, err := messaging.FormatAddress(record.Host, record.Harness, record.nativeSessionID())
		if err != nil {
			continue
		}
		candidates = append(candidates, messageTargetCandidate{Address: address, Fiber: record.fiber()})
	}
	return candidates, unmapped
}

func peerHasNativeCodexAddress(record SessionProvenance, sessionID string, sessions []messaging.Session) bool {
	for _, session := range sessions {
		address, err := messaging.ParseAddress(session.Address)
		if err == nil && address.Host == record.Host && address.ID == sessionID &&
			messaging.NormalizeHarness(address.Harness) == "codex" &&
			peerSessionMatchesFiber(session, record.fiber(), record.UID) {
			return true
		}
	}
	return false
}

func peerAddressesForTranscript(record SessionProvenance, sessions []messaging.Session) []messageTargetCandidate {
	var candidates []messageTargetCandidate
	for _, session := range sessions {
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.Host != record.Host || session.TranscriptID != record.Session ||
			!peerSessionMatchesFiber(session, record.Fiber, record.UID) {
			continue
		}
		canonical, err := messaging.FormatAddress(address.Host, address.Harness, address.ID)
		if err == nil {
			candidates = append(candidates, messageTargetCandidate{Address: canonical, Fiber: session.Fiber})
		}
	}
	return candidates
}

func peerSessionMatchesFiber(session messaging.Session, fiber, uid string) bool {
	if uid != "" && session.FiberUID != "" {
		return uid == session.FiberUID
	}
	return fiber != "" && session.Fiber == fiber
}

func uniqueMessageCandidates(candidates []messageTargetCandidate) []messageTargetCandidate {
	byAddress := make(map[string]messageTargetCandidate, len(candidates))
	for _, candidate := range candidates {
		if previous, ok := byAddress[candidate.Address]; !ok || previous.Fiber == "" && candidate.Fiber != "" {
			byAddress[candidate.Address] = candidate
		}
	}
	unique := make([]messageTargetCandidate, 0, len(byAddress))
	for _, candidate := range byAddress {
		unique = append(unique, candidate)
	}
	sort.Slice(unique, func(i, j int) bool { return unique[i].Address < unique[j].Address })
	return unique
}

// currentFiberMessageAddress resolves a fiber to its current worker. The
// authority is the newest dispatch, resume or claim row in the session ledger:
// the owning host writes it and the composite ledger fetches it live. The
// fiber's git copy of shuttle.runtime.session_uuid lags until that host pushes,
// so a disagreement is reported on stderr rather than refused. Resolution
// fails closed when the ledger has no row for the fiber, when the ledger feed
// from the worker's host or the fiber's owning host is not fresh (a newer
// dispatch there could be missing), when a Codex worker's thread id cannot be
// established, or when the peer mapping is ambiguous.
func currentFiberMessageAddress(f *felt.Felt, records []SessionProvenance, origins map[string]any, peers []messaging.Session) (string, error) {
	fiberName := f.ID
	block, ok, err := shuttle.BlockOf(f)
	if err != nil {
		return "", fmt.Errorf("reading shuttle block for fiber %q: %w", fiberName, err)
	} else if !ok {
		return "", fmt.Errorf("fiber %q has no shuttle block", fiberName)
	}
	runtimeID := shuttleRuntimeSessionID(f)

	worker, err := newestFiberWorkerRecord(f, records)
	if err != nil {
		return "", err
	}
	if worker == nil {
		if runtimeID == "" {
			return "", fmt.Errorf("fiber %q has no recorded worker session (no session-ledger row and shuttle.runtime.session_uuid is empty)", fiberName)
		}
		return "", fmt.Errorf("fiber %q session %q has no session-ledger pairing; pass an explicit shuttle:// address", fiberName, runtimeID)
	}
	if worker.Host == "" || worker.Harness == "" {
		return "", fmt.Errorf("fiber %q session %q has an incomplete session-ledger pairing (host or harness missing)", fiberName, worker.Session)
	}
	for _, host := range []string{worker.Host, block.Host} {
		if problem := ledgerOriginProblem(origins, host); problem != "" {
			return "", fmt.Errorf("cannot resolve fiber %q: the session ledger from host %q is %s, so a newer worker there could be missing; pass an explicit shuttle:// address", fiberName, host, problem)
		}
	}
	harness := messaging.NormalizeHarness(worker.Harness)
	if messaging.LedgerHarnessName(harness) == "" {
		return "", fmt.Errorf("fiber %q session %q has unsupported ledger harness %q", fiberName, worker.Session, worker.Harness)
	}
	if block.Host != "" && worker.Host != block.Host && worker.Kind != "claim" {
		fmt.Fprintf(os.Stderr, "note: fiber %q is owned by host %q but its newest ledger worker is on host %q\n", fiberName, block.Host, worker.Host)
	}

	address, err := fiberWorkerAddress(f, worker, harness, runtimeID, peers)
	if err != nil {
		return "", err
	}
	noteFiberWorkerDisagreements(f, runtimeID, worker, address, peers)
	return address, nil
}

// ledgerOriginProblem describes why the composite ledger's feed from host is
// not trustworthy, or returns "" when it is fresh. An empty host is not checked.
func ledgerOriginProblem(origins map[string]any, host string) string {
	if host == "" {
		return ""
	}
	raw, ok := origins[host]
	if !ok {
		return "not part of the composite"
	}
	origin, ok := raw.(map[string]any)
	if !ok {
		return "unreadable"
	}
	if stale, _ := origin["stale"].(bool); stale {
		return "stale"
	}
	if lastError, present := origin["last_error"]; present && lastError != nil {
		return fmt.Sprintf("failing (%v)", lastError)
	}
	return ""
}

// fiberWorkerAddress builds the address of the ledger's worker. A live peer
// registered for the fiber with that native id, or with that transcript id,
// supplies it directly; otherwise the ledger row does, except that a Codex row
// without a thread id carries only a transcript id, which is not addressable.
func fiberWorkerAddress(f *felt.Felt, worker *SessionProvenance, harness, runtimeID string, peers []messaging.Session) (string, error) {
	nativeID := worker.ThreadID
	if nativeID == "" && worker.Session == runtimeID {
		nativeID = runtimeID
	}
	addresses := map[string]bool{}
	for _, session := range peers {
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.Host != worker.Host || !peerSessionMatchesFiber(session, f.ID, f.UID) {
			continue
		}
		if !(nativeID != "" && address.ID == nativeID) && session.TranscriptID != worker.Session {
			continue
		}
		canonical, err := messaging.FormatAddress(address.Host, address.Harness, address.ID)
		if err == nil {
			addresses[canonical] = true
		}
	}
	if len(addresses) > 1 {
		return "", fmt.Errorf("fiber %q maps to multiple peer addresses for session %q: %s", f.ID, worker.Session, strings.Join(slices.Sorted(maps.Keys(addresses)), ", "))
	}
	for address := range addresses {
		return address, nil
	}
	if nativeID == "" {
		if harness == "codex" {
			return "", fmt.Errorf("fiber %q worker %q on host %q is a Codex transcript whose thread id is not yet known; pass an explicit shuttle:// address", f.ID, worker.Session, worker.Host)
		}
		nativeID = worker.Session
	}
	address, err := messaging.FormatAddress(worker.Host, harness, nativeID)
	if err != nil {
		return "", fmt.Errorf("building worker address for fiber %q: %w", f.ID, err)
	}
	return address, nil
}

// noteFiberWorkerDisagreements tells the sender, on stderr, when the local
// runtime field or other live peers registered for the fiber differ from the
// ledger's worker. Neither changes the recipient.
func noteFiberWorkerDisagreements(f *felt.Felt, runtimeID string, worker *SessionProvenance, address string, peers []messaging.Session) {
	chosen, _ := messaging.ParseAddress(address)
	if runtimeID != "" && runtimeID != worker.Session && runtimeID != worker.ThreadID && runtimeID != chosen.ID {
		fmt.Fprintf(os.Stderr, "note: fiber %q's local shuttle.runtime.session_uuid %q is behind the session ledger; using the ledger's worker %s\n", f.ID, runtimeID, address)
	}
	if others := staleFiberPeerCandidates(f, chosen.ID, worker, peers); len(others) > 0 {
		fmt.Fprintf(os.Stderr, "note: other live sessions registered for fiber %q: %s\n", f.ID, strings.Join(others, ", "))
	}
}

func staleFiberPeerCandidates(f *felt.Felt, runtimeID string, worker *SessionProvenance, peers []messaging.Session) []string {
	addresses := map[string]bool{}
	for _, session := range peers {
		if !peerSessionMatchesFiber(session, f.ID, f.UID) {
			continue
		}
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.ID == runtimeID || address.ID == worker.Session ||
			address.ID == worker.ThreadID || session.TranscriptID == worker.Session {
			continue
		}
		canonical, err := messaging.FormatAddress(address.Host, address.Harness, address.ID)
		if err == nil {
			addresses[canonical] = true
		}
	}
	return slices.Sorted(maps.Keys(addresses))
}

// newestFiberWorkerRecord is the fiber's newest dispatch, resume or claim row;
// rows tied at the newest time must agree on one session.
func newestFiberWorkerRecord(f *felt.Felt, records []SessionProvenance) (*SessionProvenance, error) {
	latestAt := int64(-1 << 63)
	latest := map[string]SessionProvenance{}
	for _, row := range records {
		if !sessionRecordBelongsToFiber(row, f) || row.Session == "" ||
			(row.Kind != "dispatch" && row.Kind != "resume" && row.Kind != "claim") {
			continue
		}
		key := row.Session + "\x00" + row.ThreadID + "\x00" + row.Host + "\x00" + messaging.NormalizeHarness(row.Harness)
		if row.At > latestAt {
			latestAt = row.At
			latest = map[string]SessionProvenance{key: row}
		} else if row.At == latestAt {
			latest[key] = row
		}
	}
	if len(latest) == 0 {
		return nil, nil
	}
	if len(latest) > 1 {
		candidates := make([]string, 0, len(latest))
		for _, row := range latest {
			candidates = append(candidates, fmt.Sprintf("%s on %s/%s", row.Session, row.Host, messaging.NormalizeHarness(row.Harness)))
		}
		sort.Strings(candidates)
		return nil, fmt.Errorf("fiber %q has conflicting newest session-ledger records: %s", f.ID, strings.Join(candidates, ", "))
	}
	for _, row := range latest {
		return &row, nil
	}
	return nil, nil
}

func sessionRecordBelongsToFiber(record SessionProvenance, f *felt.Felt) bool {
	if f.UID != "" && record.UID != "" {
		return record.UID == f.UID
	}
	return record.fiber() == f.ID
}

func shuttleRuntimeSessionID(f *felt.Felt) string {
	node, ok := f.ExtraFields["shuttle"]
	if !ok || node == nil {
		return ""
	}
	var block map[string]any
	if err := node.Decode(&block); err != nil {
		return ""
	}
	runtime, _ := block["runtime"].(map[string]any)
	sessionID, _ := runtime["session_uuid"].(string)
	return strings.TrimSpace(sessionID)
}
