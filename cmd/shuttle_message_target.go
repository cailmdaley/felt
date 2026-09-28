package cmd

import (
	"fmt"
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

// resolveMessageTarget turns the user-facing target into one canonical address.
// Explicit addresses are authoritative; bare session IDs prefer live discovery,
// then the ledger; everything else is resolved as a fiber.
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

	var lookupErrors []string
	candidates := make([]messageTargetCandidate, 0)
	live, liveErr := discoveredMessageCandidates(target)
	if liveErr != nil {
		lookupErrors = append(lookupErrors, "session discovery: "+liveErr.Error())
	} else {
		candidates = append(candidates, live...)
	}

	var ledgerRecords []SessionProvenance
	ledger, ledgerErr := fetchSessionLedger()
	if ledgerErr != nil {
		lookupErrors = append(lookupErrors, "session ledger: "+ledgerErr.Error())
	} else {
		ledgerRecords = ledger.Records
		candidates = append(candidates, ledgerMessageCandidates(target, ledgerRecords)...)
	}
	candidates = uniqueMessageCandidates(candidates)
	if len(candidates) > 0 {
		return chooseMessageCandidate(target, candidates)
	}

	fiber, fiberErr := shuttleAddressFiber(target)
	if fiberErr == nil {
		return currentFiberMessageAddress(fiber, ledgerRecords)
	}
	lookupErrors = append(lookupErrors, "fiber lookup: "+fiberErr.Error())
	return "", fmt.Errorf("message target %q did not match a discovered session or fiber (%s)", target, strings.Join(lookupErrors, "; "))
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

func chooseMessageCandidate(target string, candidates []messageTargetCandidate) (string, error) {
	if len(candidates) == 1 {
		return candidates[0].Address, nil
	}
	labels := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		label := candidate.Address
		if candidate.Fiber != "" {
			label += " (fiber " + candidate.Fiber + ")"
		}
		labels = append(labels, label)
	}
	return "", fmt.Errorf("session ID %q is ambiguous; use one of: %s", target, strings.Join(labels, ", "))
}

func currentFiberMessageAddress(f *felt.Felt, records []SessionProvenance) (string, error) {
	fiberName := f.ID
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		return "", fmt.Errorf("reading shuttle block for fiber %q: %w", fiberName, err)
	}
	if !ok {
		return "", fmt.Errorf("fiber %q has no shuttle block", fiberName)
	}
	sessionID := shuttleRuntimeSessionID(f)
	if sessionID == "" {
		return "", fmt.Errorf("fiber %q has no recorded worker session (shuttle.runtime.session_uuid is empty)", fiberName)
	}

	host, harness, err := fiberWorkerIdentity(f, block, sessionID, records)
	if err != nil {
		return "", err
	}
	address, err := messaging.FormatAddress(host, harness, sessionID)
	if err != nil {
		return "", fmt.Errorf("building worker address for fiber %q: %w", fiberName, err)
	}
	return address, nil
}

func fiberWorkerIdentity(f *felt.Felt, block *shuttle.Block, sessionID string, records []SessionProvenance) (string, string, error) {
	fiberName := f.ID
	type workerIdentity struct{ host, harness string }
	matching := make(map[string]workerIdentity)
	allHosts := make(map[string]bool)
	for _, record := range records {
		if record.Session != sessionID || !sessionRecordBelongsToFiber(record, f) {
			continue
		}
		if record.Host != "" {
			allHosts[record.Host] = true
		}
		if record.Host == "" || record.Harness == "" || block.Host != "" && record.Host != block.Host {
			continue
		}
		harness := messaging.NormalizeHarness(record.Harness)
		if messaging.LedgerHarnessName(harness) == "" {
			return "", "", fmt.Errorf("fiber %q session %s has unsupported ledger harness %q", fiberName, sessionID, record.Harness)
		}
		matching[record.Host+"\x00"+harness] = workerIdentity{host: record.Host, harness: harness}
	}

	if len(matching) == 1 {
		for _, identity := range matching {
			return identity.host, identity.harness, nil
		}
	}
	if len(matching) > 1 {
		identities := make([]string, 0, len(matching))
		for _, identity := range matching {
			identities = append(identities, identity.host+"/"+identity.harness)
		}
		sort.Strings(identities)
		return "", "", fmt.Errorf("fiber %q session %s has conflicting host/harness ledger entries: %s", fiberName, sessionID, strings.Join(identities, ", "))
	}
	if block.Host != "" && len(allHosts) > 0 && !allHosts[block.Host] {
		hosts := make([]string, 0, len(allHosts))
		for host := range allHosts {
			hosts = append(hosts, host)
		}
		sort.Strings(hosts)
		return "", "", fmt.Errorf("fiber %q owns host %q but session %s is recorded on %s", fiberName, block.Host, sessionID, strings.Join(hosts, ", "))
	}

	host := block.Host
	if host == "" {
		if len(allHosts) == 1 {
			for recordedHost := range allHosts {
				host = recordedHost
			}
		} else if len(allHosts) > 1 {
			return "", "", fmt.Errorf("fiber %q session %s is recorded on multiple hosts; use an explicit session address", fiberName, sessionID)
		}
	}
	if host == "" {
		return "", "", fmt.Errorf("fiber %q has no shuttle.host owner for worker session %s", fiberName, sessionID)
	}

	harness, err := configuredFiberHarness(block)
	if err != nil {
		return "", "", fmt.Errorf("resolving harness for fiber %q: %w", fiberName, err)
	}
	return host, harness, nil
}

func sessionRecordBelongsToFiber(record SessionProvenance, f *felt.Felt) bool {
	if f.UID != "" && record.UID != "" {
		return record.UID == f.UID
	}
	return record.fiber() == f.ID
}

func configuredFiberHarness(block *shuttle.Block) (string, error) {
	registry, err := shuttle.LoadAgentRegistry()
	if err != nil {
		return "", err
	}
	agentID := block.Agent
	if agentID == "" {
		defaultAgent, err := registry.Default()
		if err != nil {
			return "", err
		}
		agentID = defaultAgent.ID
	}
	agent, _, err := registry.Resolve(agentID, block.Effort, block.Chrome)
	if err != nil {
		return "", err
	}
	if messaging.LedgerHarnessName(agent.CLI) == "" {
		return "", fmt.Errorf("agent %q uses unsupported CLI %q", agentID, agent.CLI)
	}
	return messaging.NormalizeHarness(agent.CLI), nil
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
