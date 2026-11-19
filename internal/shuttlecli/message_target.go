package shuttlecli

import (
	"fmt"
	"github.com/cailmdaley/felt/internal/harness"
	"maps"
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

// resolveMessageTarget canonicalizes an explicit address and resolves a bare
// session id through live discovery and the session ledger. A fiber is no
// session: a Shuttle fiber's messages go through its owner, and a target
// that names a fiber here is refused. If both a session and a fiber match, it
// refuses to choose.
func (a *app) resolveMessageTarget(target string) (string, error) {
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
	fiberLookup, err := a.lookupShuttleAddressFibers(target)
	if err != nil {
		return "", err
	}

	var lookupErrors []string
	sessionCandidates := make([]messageTargetCandidate, 0)
	var peerSessions []messaging.Session
	directory, liveErr := a.fetchPeerDirectory("", "")
	if liveErr != nil {
		lookupErrors = append(lookupErrors, "session discovery: "+liveErr.Error())
	} else {
		peerSessions = directory.Sessions
		sessionCandidates = append(sessionCandidates, discoveredMessageCandidates(target, peerSessions)...)
	}

	var unmappedLedger []string
	ledger, ledgerErr := a.fetchSessionLedger()
	if ledgerErr != nil {
		lookupErrors = append(lookupErrors, "session ledger: "+ledgerErr.Error())
	} else {
		ledgerCandidates, unresolved := ledgerMessageCandidates(target, ledger.Records, peerSessions)
		sessionCandidates = append(sessionCandidates, ledgerCandidates...)
		unmappedLedger = unresolved
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
		f := fiberLookup.Fibers[0]
		block, ok, _ := shuttle.BlockOf(f)
		switch {
		case !ok:
			return "", fmt.Errorf("fiber %q has no shuttle block, so it has no inbox", f.ID)
		case block.Host == "":
			return "", fmt.Errorf("fiber %q has no shuttle.host, so no owner holds its inbox", f.ID)
		default:
			return "", fmt.Errorf("fiber %q takes messages through its owner, not --local", f.ID)
		}
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
		if record.ThreadID == "" && record.Session == sessionID && harness.Normalize(record.Harness) == "codex" {
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
			harness.Normalize(address.Harness) == "codex" &&
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

// fiberWorkerAddress builds the address of the ledger's worker. A live peer
// registered for the fiber with that native id, or with that transcript id,
// supplies it directly. A CLI hook peer also establishes that the ledger's
// session id is addressable without a separate thread id. App workers still
// require their native thread mapping.
func fiberWorkerAddress(f *felt.Felt, worker *SessionProvenance, harness, runtimeID string, peers []messaging.Session) (string, error) {
	nativeID := worker.ThreadID
	if nativeID == "" && worker.Session == runtimeID {
		nativeID = runtimeID
	}
	block, _, blockErr := shuttle.BlockOf(f)
	cliCodex := harness == "codex" && blockErr == nil && block != nil
	addresses := map[string]bool{}
	for _, session := range peers {
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.Host != worker.Host || address.Harness != harness || !peerSessionMatchesFiber(session, f.ID, f.UID) {
			continue
		}
		cliHook := cliCodex && session.State == "hook" && address.ID == worker.Session
		if !(nativeID != "" && address.ID == nativeID) && session.TranscriptID != worker.Session && !cliHook {
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

// newestFiberWorkerRecord is the fiber's newest dispatch, resume or claim row;
// rows tied at the newest time must agree on one session.
func newestFiberWorkerRecord(f *felt.Felt, records []SessionProvenance) (*SessionProvenance, error) {
	latestAt := int64(-1 << 63)
	latest := map[string]SessionProvenance{}
	for _, row := range records {
		if !sessionRecordBelongsToFiber(row, f) || row.Session == "" ||
			!workerBindingKind(row.Kind) {
			continue
		}
		binding, err := currentSessionBinding(messaging.Address{Host: row.Host, Harness: harness.Normalize(row.Harness), ID: row.nativeSessionID()}, records)
		if err != nil {
			return nil, err
		}
		if binding != nil && !sessionRecordBelongsToFiber(*binding, f) {
			continue
		}
		key := row.Session + "\x00" + row.ThreadID + "\x00" + row.Host + "\x00" + harness.Normalize(row.Harness)
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
			candidates = append(candidates, fmt.Sprintf("%s on %s/%s", row.Session, row.Host, harness.Normalize(row.Harness)))
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

// ownerFeedFibers finds a constitution its owner reports by exact path or UID
// when this host's stores do not hold it: a thread created on another host is
// addressable before Git carries its document here.
func (a *app) ownerFeedFibers(target string) ([]*felt.Felt, error) {
	feed, err := a.fetchStatusFeed()
	if err != nil {
		return nil, err
	}
	var fibers []*felt.Felt
	for _, entry := range feed.Fibers {
		if entry.Fiber["slug"] != target && entry.Fiber["uid"] != target && entry.Fiber["id"] != target {
			continue
		}
		f, err := statusDocument(entry.Fiber)
		if err != nil {
			continue
		}
		if block, ok, err := shuttle.BlockOf(f); err != nil || !ok || block.Host != entry.Origin {
			continue
		}
		fibers = append(fibers, f)
	}
	return fibers, nil
}
