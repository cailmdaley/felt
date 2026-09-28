package cmd

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
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
	live, liveErr := discoveredMessageCandidates(target)
	if liveErr != nil {
		lookupErrors = append(lookupErrors, "session discovery: "+liveErr.Error())
	} else {
		sessionCandidates = append(sessionCandidates, live...)
	}

	var ledgerRecords []SessionProvenance
	ledger, ledgerErr := fetchSessionLedger()
	if ledgerErr != nil {
		lookupErrors = append(lookupErrors, "session ledger: "+ledgerErr.Error())
	} else {
		ledgerRecords = ledger.Records
		sessionCandidates = append(sessionCandidates, ledgerMessageCandidates(target, ledgerRecords)...)
	}

	if sessionShaped {
		var err error
		fiberLookup, err = lookupShuttleAddressFibers(target)
		if err != nil {
			return "", err
		}
	}
	sessionCandidates = uniqueMessageCandidates(sessionCandidates)
	matchCount := len(sessionCandidates) + len(fiberLookup.Fibers) + len(fiberLookup.Guesses)
	if len(fiberLookup.Guesses) > 0 || matchCount > 1 {
		return "", messageTargetAmbiguity(target, sessionCandidates, fiberLookup)
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
		return currentFiberMessageAddress(fiberLookup.Fibers[0], ledgerRecords)
	}
	if len(lookupErrors) > 0 {
		return "", fmt.Errorf("message target %q did not resolve (%s)", target, strings.Join(lookupErrors, "; "))
	}
	return "", fmt.Errorf("message target %q did not match a discovered session or exact fiber", target)
}

func messageTargetAmbiguity(target string, sessions []messageTargetCandidate, fibers addressFiberLookup) error {
	labels := make([]string, 0, len(sessions)+len(fibers.Fibers)+len(fibers.Guesses))
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
	sort.Strings(labels)
	return fmt.Errorf("message target %q is ambiguous or guessed; candidates: %s", target, strings.Join(labels, ", "))
}

func discoveredMessageCandidates(sessionID string) ([]messageTargetCandidate, error) {
	endpoint, err := daemonEndpoint("/api/v1/peers")
	if err != nil {
		return nil, err
	}
	directory, err := getDaemonJSON[messaging.Directory](endpoint, "parsing peer directory")
	if err != nil {
		return nil, err
	}
	candidates := make([]messageTargetCandidate, 0)
	for _, session := range directory.Sessions {
		address, err := messaging.ParseAddress(session.Address)
		if err != nil || address.ID != sessionID {
			continue
		}
		canonical, err := messaging.FormatAddress(address.Host, address.Harness, address.ID)
		if err != nil {
			continue
		}
		candidates = append(candidates, messageTargetCandidate{Address: canonical, Fiber: session.Fiber})
	}
	return uniqueMessageCandidates(candidates), nil
}

func ledgerMessageCandidates(sessionID string, records []SessionProvenance) []messageTargetCandidate {
	candidates := make([]messageTargetCandidate, 0)
	for _, record := range records {
		if record.Session == "" || record.Session != sessionID {
			continue
		}
		address, err := messaging.FormatAddress(record.Host, record.Harness, record.Session)
		if err != nil {
			continue
		}
		candidates = append(candidates, messageTargetCandidate{Address: address, Fiber: record.fiber()})
	}
	return uniqueMessageCandidates(candidates)
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

func currentFiberMessageAddress(f *felt.Felt, records []SessionProvenance) (string, error) {
	fiberName := f.ID
	if _, ok, err := f.ShuttleBlock(); err != nil {
		return "", fmt.Errorf("reading shuttle block for fiber %q: %w", fiberName, err)
	} else if !ok {
		return "", fmt.Errorf("fiber %q has no shuttle block", fiberName)
	}
	sessionID := shuttleRuntimeSessionID(f)
	if sessionID == "" {
		return "", fmt.Errorf("fiber %q has no recorded worker session (shuttle.runtime.session_uuid is empty)", fiberName)
	}

	newestRun, err := newestFiberLedgerRecord(f, records, func(row SessionProvenance) bool {
		return row.Kind == "dispatch" || row.Kind == "resume"
	})
	if err != nil {
		return "", err
	}
	if newestRun != nil && newestRun.Session != sessionID {
		return "", fmt.Errorf(
			"fiber %q is stale: local shuttle.runtime.session_uuid %q disagrees with the newest ledger dispatch/resume session %q on host %q; sync the store or pass an explicit shuttle:// address",
			fiberName, sessionID, newestRun.Session, newestRun.Host,
		)
	}

	current, err := newestFiberLedgerRecord(f, records, func(row SessionProvenance) bool {
		return row.Session == sessionID
	})
	if err != nil {
		return "", err
	}
	if current == nil {
		return "", fmt.Errorf("fiber %q session %q has no session-ledger pairing; sync the store or pass an explicit shuttle:// address", fiberName, sessionID)
	}
	if current.Host == "" || current.Harness == "" {
		return "", fmt.Errorf("fiber %q session %q has an incomplete session-ledger pairing (host or harness missing)", fiberName, sessionID)
	}
	harness := messaging.NormalizeHarness(current.Harness)
	if messaging.LedgerHarnessName(harness) == "" {
		return "", fmt.Errorf("fiber %q session %q has unsupported ledger harness %q", fiberName, sessionID, current.Harness)
	}
	address, err := messaging.FormatAddress(current.Host, harness, sessionID)
	if err != nil {
		return "", fmt.Errorf("building worker address for fiber %q: %w", fiberName, err)
	}
	return address, nil
}

func newestFiberLedgerRecord(f *felt.Felt, records []SessionProvenance, include func(SessionProvenance) bool) (*SessionProvenance, error) {
	latestAt := int64(-1 << 63)
	latest := map[string]SessionProvenance{}
	for _, row := range records {
		if !sessionRecordBelongsToFiber(row, f) || row.Session == "" || !include(row) {
			continue
		}
		key := row.Session + "\x00" + row.Host + "\x00" + messaging.NormalizeHarness(row.Harness)
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
	if runtime, ok := block["runtime"].(map[string]any); ok {
		if sessionID, ok := runtime["session_uuid"].(string); ok && strings.TrimSpace(sessionID) != "" {
			return strings.TrimSpace(sessionID)
		}
	}
	// Read old flat runtime blocks while all new dispatches use runtime:.
	if sessionID, ok := block["session_uuid"].(string); ok {
		return strings.TrimSpace(sessionID)
	}
	return ""
}
