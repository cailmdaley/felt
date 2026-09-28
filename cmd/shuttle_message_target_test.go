package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
)

const messageTargetSession = "a2a08d94-7da5-4bb7-b083-933487a19b8f"
const messageTargetFiberUID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func messageTargetDaemon(t *testing.T, sessions []messaging.Session, records []SessionProvenance) *httptest.Server {
	t.Helper()
	peers, err := json.Marshal(messaging.Directory{Sessions: sessions, Gaps: []messaging.Gap{}})
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := json.Marshal(sessionLedgerResponse{Records: records})
	if err != nil {
		t.Fatal(err)
	}
	return daemonStub(t, map[string]http.HandlerFunc{
		"/api/v1/peers":       jsonBody(string(peers)),
		sessionsCompositePath: jsonBody(string(ledger)),
	})
}

func isolateMessageFiberStore(t *testing.T, store string) {
	t.Helper()
	previousDir := changeDir
	changeDir = ""
	t.Cleanup(func() { changeDir = previousDir })
	t.Setenv("FELT_STORES", store)
	t.Setenv("FELT_STORES_FILE", filepath.Join(t.TempDir(), "stores.json"))
	t.Setenv("FELT_AGENTS_FILE", filepath.Join(t.TempDir(), "agents.json"))
	t.Setenv("HOME", t.TempDir())
}

func writeMessageTargetFiber(t *testing.T, block map[string]any) string {
	return writeMessageTargetFiberWithID(t, "work/worker", messageTargetFiberUID, block)
}

func writeMessageTargetFiberWithID(t *testing.T, id, uid string, block map[string]any) string {
	t.Helper()
	store, storage := newStore(t)
	fiber := &felt.Felt{ID: id, UID: uid, Name: id}
	if err := fiber.SetExtraField("shuttle", block); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestResolveMessageTargetCanonicalAddress(t *testing.T) {
	got, err := resolveMessageTarget("shuttle://node/claude-code/native-id")
	if err != nil {
		t.Fatal(err)
	}
	if got != "shuttle://node/claude/native-id" {
		t.Fatalf("resolved address = %q", got)
	}
}

func TestResolveMessageTargetBareSessionFromDiscoveryPrintsResolvedReceipt(t *testing.T) {
	const address = "shuttle://node/claude/session-42"
	server := daemonStub(t, map[string]http.HandlerFunc{
		"/api/v1/peers": jsonBody(`{"sessions":[{"address":"` + address + `","host":"node","harness":"claude","id":"session-42","fiber":"work/worker"}],"gaps":[]}`),
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) {
			var request messaging.Request
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode message: %v", err)
				return
			}
			if request.Address != address {
				t.Errorf("message address = %q, want %q", request.Address, address)
			}
			_ = json.NewEncoder(w).Encode(messaging.Receipt{
				MessageID: request.MessageID,
				Address:   request.Address,
				Status:    messaging.StatusAccepted,
				Transport: "test",
			})
		},
	})
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	messageDir, _ := newStore(t)
	isolateMessageFiberStore(t, "")

	out, err := runCommand(t, messageDir, "shuttle", "message", "session-42", "hello")
	if err != nil {
		t.Fatalf("message: %v\n%s", err, out)
	}
	if !strings.Contains(out, "accepted "+address) {
		t.Fatalf("receipt omitted resolved address: %s", out)
	}
}

func TestResolveMessageTargetBareSessionAmbiguityNamesCandidates(t *testing.T) {
	isolateMessageFiberStore(t, "")
	messageTargetDaemon(t, []messaging.Session{
		{Address: "shuttle://node-a/claude/session-42", Fiber: "work/one"},
		{Address: "shuttle://node-b/codex/session-42", Fiber: "work/two"},
	}, nil)

	_, err := resolveMessageTarget("session-42")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "shuttle://node-a/claude/session-42") ||
		!strings.Contains(err.Error(), "shuttle://node-b/codex/session-42") {
		t.Fatalf("expected ambiguity naming both candidates, got %v", err)
	}
}

func TestResolveMessageTargetBareSessionUsesLedgerAndNormalizesHarness(t *testing.T) {
	isolateMessageFiberStore(t, "")
	messageTargetDaemon(t, nil, []SessionProvenance{{
		Session: messageTargetSession,
		Host:    "ledger-node",
		Harness: "claude-code",
		Fiber:   "work/worker",
	}})

	got, err := resolveMessageTarget(messageTargetSession)
	if err != nil {
		t.Fatal(err)
	}
	if got != "shuttle://ledger-node/claude/"+messageTargetSession {
		t.Fatalf("resolved address = %q", got)
	}
}

func TestResolveMessageTargetAmbiguityCombinesDiscoveryAndLedger(t *testing.T) {
	isolateMessageFiberStore(t, "")
	messageTargetDaemon(t, []messaging.Session{
		{Address: "shuttle://live-node/claude/session-42"},
	}, []SessionProvenance{{
		Session: "session-42",
		Host:    "ledger-node",
		Harness: "codex",
	}})

	_, err := resolveMessageTarget("session-42")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "shuttle://live-node/claude/session-42") ||
		!strings.Contains(err.Error(), "shuttle://ledger-node/codex/session-42") {
		t.Fatalf("expected cross-surface ambiguity, got %v", err)
	}
}

func TestResolveMessageTargetFiberPathSlugAndUID(t *testing.T) {
	block := map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": messageTargetSession},
	}
	store := writeMessageTargetFiber(t, block)
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, []SessionProvenance{{
		Session: messageTargetSession,
		UID:     messageTargetFiberUID,
		Host:    "worker-node",
		Harness: "claude-code",
		Fiber:   "work/worker",
	}})

	for _, target := range []string{"work/worker", "worker", messageTargetFiberUID} {
		t.Run(target, func(t *testing.T) {
			got, err := resolveMessageTarget(target)
			if err != nil {
				t.Fatal(err)
			}
			want := "shuttle://worker-node/claude/" + messageTargetSession
			if got != want {
				t.Fatalf("resolved address = %q, want %q", got, want)
			}
		})
	}
}

func TestResolveMessageTargetFiberRequiresLedgerEvidence(t *testing.T) {
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, nil)

	_, err := resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "no session-ledger pairing") {
		t.Fatalf("expected missing ledger evidence error, got %v", err)
	}
}

func TestResolveMessageTargetFiberWithoutRuntimeSessionIsClear(t *testing.T) {
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, nil)

	_, err := resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "no recorded worker session") || !strings.Contains(err.Error(), "session_uuid") {
		t.Fatalf("expected missing worker-session error, got %v", err)
	}
}

func TestResolveMessageTargetNotFound(t *testing.T) {
	messageTargetDaemon(t, nil, nil)
	isolateMessageFiberStore(t, "")
	_, err := resolveMessageTarget("unknown-target")
	if err == nil || !strings.Contains(err.Error(), "unknown-target") || !strings.Contains(err.Error(), "did not match") {
		t.Fatalf("expected not-found error, got %v", err)
	}
}

func TestResolveMessageTargetCanUseLedgerWhenDiscoveryFails(t *testing.T) {
	isolateMessageFiberStore(t, "")
	ledger, err := json.Marshal(sessionLedgerResponse{Records: []SessionProvenance{{
		Session: messageTargetSession,
		Host:    "ledger-node",
		Harness: "codex",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	server := daemonStub(t, map[string]http.HandlerFunc{
		"/api/v1/peers": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "old daemon", http.StatusNotFound)
		},
		sessionsCompositePath: jsonBody(string(ledger)),
	})
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	got, err := resolveMessageTarget(messageTargetSession)
	if err != nil {
		t.Fatal(err)
	}
	if got != "shuttle://ledger-node/codex/"+messageTargetSession {
		t.Fatalf("resolved address = %q", got)
	}
}

func TestResolveMessageTargetRejectsFiberSlugAcrossStores(t *testing.T) {
	writeBareFiber := func() string {
		store, storage := newStore(t)
		if err := storage.Write(&felt.Felt{ID: "review", Name: "Review"}); err != nil {
			t.Fatal(err)
		}
		return store
	}
	first, second := writeBareFiber(), writeBareFiber()
	isolateMessageFiberStore(t, first+","+second)
	messageTargetDaemon(t, nil, nil)

	_, err := resolveMessageTarget("review")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), filepath.Base(first)) || !strings.Contains(err.Error(), filepath.Base(second)) {
		t.Fatalf("expected both store candidates %q and %q, got %q", first, second, err)
	}
}

func TestResolveMessageTargetRefusesGuessedFiberSlug(t *testing.T) {
	store, storage := newStore(t)
	if err := storage.Write(&felt.Felt{ID: "worker", Name: "Worker"}); err != nil {
		t.Fatal(err)
	}
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, nil)

	_, err := resolveMessageTarget("proj/typo/worker")
	if err == nil || !strings.Contains(err.Error(), "guessed") || !strings.Contains(err.Error(), "worker") {
		t.Fatalf("expected guessed fiber refusal, got %v", err)
	}
}

func TestResolveMessageTargetRejectsStaleRuntimeAgainstNewestLedger(t *testing.T) {
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "old-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": "old-session"},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, []SessionProvenance{
		{
			Fiber: "work/worker", UID: messageTargetFiberUID, Session: "old-session",
			Host: "old-node", Harness: "claude-code", At: 1, Kind: "dispatch",
		},
		{
			Fiber: "work/worker", UID: messageTargetFiberUID, Session: "new-session",
			Host: "new-node", Harness: "codex", At: 2, Kind: "resume",
		},
	})

	_, err := resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "old-session") ||
		!strings.Contains(err.Error(), "new-session") || !strings.Contains(err.Error(), "sync the store") ||
		!strings.Contains(err.Error(), "explicit shuttle:// address") {
		t.Fatalf("expected stale-runtime refusal naming both sessions and remedies, got %v", err)
	}
}

func TestResolveMessageTargetFiberFailsClosedWhenLedgerUnavailable(t *testing.T) {
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(t, store)
	server := daemonStub(t, map[string]http.HandlerFunc{
		"/api/v1/peers": jsonBody(`{"sessions":[],"gaps":[]}`),
		sessionsCompositePath: func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "ledger unavailable", http.StatusServiceUnavailable)
		},
	})
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	_, err := resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "session ledger is unavailable") ||
		!strings.Contains(err.Error(), "ledger unavailable") {
		t.Fatalf("expected ledger-unavailable refusal, got %v", err)
	}
}

func TestResolveMessageTargetRejectsBareIDThatNamesSessionAndFiber(t *testing.T) {
	store := writeMessageTargetFiberWithID(t, "session-42", messageTargetFiberUID, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, []messaging.Session{{
		Address: "shuttle://session-node/claude/session-42",
		ID:      "session-42",
		Fiber:   "session-42",
	}}, []SessionProvenance{{
		Fiber: "session-42", UID: messageTargetFiberUID, Session: messageTargetSession,
		Host: "worker-node", Harness: "claude-code", At: 1, Kind: "dispatch",
	}})

	_, err := resolveMessageTarget("session-42")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "shuttle://session-node/claude/session-42") ||
		!strings.Contains(err.Error(), "fiber session-42") {
		t.Fatalf("expected session/fiber collision refusal, got %v", err)
	}
}
