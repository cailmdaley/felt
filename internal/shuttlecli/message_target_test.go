package shuttlecli

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

// messageTargetFreshHosts are the hosts the test fibers name; the stub ledger
// reports them, and every host in its records, as fresh origins.
var messageTargetFreshHosts = []string{"old-node", "new-node", "worker-node"}

func messageTargetDaemon(t *testing.T, sessions []messaging.Session, records []SessionProvenance) *httptest.Server {
	t.Helper()
	origins := map[string]any{}
	for _, host := range messageTargetFreshHosts {
		origins[host] = map[string]any{"stale": false, "last_error": nil}
	}
	for _, record := range records {
		if record.Host != "" {
			origins[record.Host] = map[string]any{"stale": false, "last_error": nil}
		}
	}
	return messageTargetDaemonWithOrigins(t, sessions, records, origins)
}

func messageTargetDaemonWithOrigins(t *testing.T, sessions []messaging.Session, records []SessionProvenance, origins map[string]any) *httptest.Server {
	t.Helper()
	peers, err := json.Marshal(messaging.Directory{Sessions: sessions, Gaps: []messaging.Gap{}})
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := json.Marshal(sessionLedgerResponse{Records: records, Origins: origins})
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
	t.Setenv("SHUTTLE_STORES", store)
	t.Setenv("SHUTTLE_STORES_FILE", filepath.Join(t.TempDir(), "stores.json"))
	t.Setenv("SHUTTLE_AGENTS_FILE", filepath.Join(t.TempDir(), "agents.json"))
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
	got, err := testApp(t).resolveMessageTarget("shuttle://node/claude-code/native-id")
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

	out, err := runCommand(t, messageDir, "message", "session-42", "hello")
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

	_, err := testApp(t).resolveMessageTarget("session-42")
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

	got, err := testApp(t).resolveMessageTarget(messageTargetSession)
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

	_, err := testApp(t).resolveMessageTarget("session-42")
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
		Kind:    "dispatch",
	}})

	for _, target := range []string{"work/worker", "worker", messageTargetFiberUID} {
		t.Run(target, func(t *testing.T) {
			got, err := testApp(t).resolveMessageTarget(target)
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

	_, err := testApp(t).resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "no session-ledger pairing") {
		t.Fatalf("expected missing ledger evidence error, got %v", err)
	}
}

func TestResolveMessageTargetCodexAppUsesPeerThreadAddress(t *testing.T) {
	const threadID = "11111111-1111-4111-8111-111111111111"
	const transcriptID = "22222222-2222-4222-8222-222222222222"
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "codex-luna",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": threadID},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, []messaging.Session{{
		Address: "shuttle://worker-node/codex/" + threadID,
		Host:    "worker-node", Harness: "codex", ID: threadID,
		Fiber: "work/worker", FiberUID: messageTargetFiberUID, TranscriptID: transcriptID,
	}}, []SessionProvenance{{
		Fiber: "work/worker", UID: messageTargetFiberUID, Session: transcriptID,
		Host: "worker-node", Harness: "codex", At: 2, Kind: "claim",
	}})

	for _, target := range []string{"work/worker", transcriptID, threadID} {
		got, err := testApp(t).resolveMessageTarget(target)
		if err != nil {
			t.Fatalf("resolve %q: %v", target, err)
		}
		if want := "shuttle://worker-node/codex/" + threadID; got != want {
			t.Errorf("resolve %q = %q, want peer-view address %q", target, got, want)
		}
	}
}

func TestResolveMessageTargetCodexAppUsesLedgerThreadID(t *testing.T) {
	const threadID = "11111111-1111-4111-8111-111111111111"
	const transcriptID = "22222222-2222-4222-8222-222222222222"
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "codex-luna",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": threadID},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, []messaging.Session{{
		Address: "shuttle://worker-node/codex/" + threadID,
		Host:    "worker-node", Harness: "codex", ID: threadID,
		Fiber: "work/worker", FiberUID: messageTargetFiberUID, TranscriptID: transcriptID,
	}}, []SessionProvenance{{
		Fiber: "work/worker", UID: messageTargetFiberUID, Session: transcriptID,
		ThreadID: threadID, Host: "worker-node", Harness: "codex", At: 2, Kind: "claim",
	}})

	got, err := testApp(t).resolveMessageTarget("work/worker")
	if err != nil {
		t.Fatal(err)
	}
	if want := "shuttle://worker-node/codex/" + threadID; got != want {
		t.Fatalf("resolved address = %q, want peer-view address %q", got, want)
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

	_, err := testApp(t).resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "no recorded worker session") || !strings.Contains(err.Error(), "session_uuid") {
		t.Fatalf("expected missing worker-session error, got %v", err)
	}
}

func TestResolveMessageTargetNotFound(t *testing.T) {
	messageTargetDaemon(t, nil, nil)
	isolateMessageFiberStore(t, "")
	_, err := testApp(t).resolveMessageTarget("unknown-target")
	if err == nil || !strings.Contains(err.Error(), "unknown-target") || !strings.Contains(err.Error(), "did not match") {
		t.Fatalf("expected not-found error, got %v", err)
	}
}

func TestResolveMessageTargetCanUseLedgerWhenDiscoveryFails(t *testing.T) {
	isolateMessageFiberStore(t, "")
	ledger, err := json.Marshal(sessionLedgerResponse{Records: []SessionProvenance{{
		Session:  messageTargetSession,
		ThreadID: messageTargetSession,
		Host:     "ledger-node",
		Harness:  "codex",
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

	got, err := testApp(t).resolveMessageTarget(messageTargetSession)
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

	_, err := testApp(t).resolveMessageTarget("review")
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

	_, err := testApp(t).resolveMessageTarget("proj/typo/worker")
	if err == nil || !strings.Contains(err.Error(), "guessed") || !strings.Contains(err.Error(), "worker") {
		t.Fatalf("expected guessed fiber refusal, got %v", err)
	}
}

// The owning host's ledger is authoritative over the fiber's git runtime field,
// which lags until that host pushes: a newer ledger worker wins.
func TestResolveMessageTargetPrefersNewestLedgerOverStaleRuntime(t *testing.T) {
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "old-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": "old-session"},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, []messaging.Session{
		{
			Address: "shuttle://old-node/claude/old-session",
			Fiber:   "work/worker", FiberUID: messageTargetFiberUID,
		},
	}, []SessionProvenance{
		{
			Fiber: "work/worker", UID: messageTargetFiberUID, Session: "old-session",
			Host: "old-node", Harness: "claude-code", At: 1, Kind: "dispatch",
		},
		{
			Fiber: "work/worker", UID: messageTargetFiberUID, Session: "new-session",
			Host: "new-node", Harness: "claude-code", At: 2, Kind: "dispatch",
		},
	})

	address, err := testApp(t).resolveMessageTarget("work/worker")
	if err != nil || address != "shuttle://new-node/claude/new-session" {
		t.Fatalf("expected the ledger's newest worker, got %q, %v", address, err)
	}
}

// The composite ledger is a polled cache: when the feed from the worker's host
// or the fiber's owning host is stale or failing, a newer worker there could be
// missing, so the fiber target is refused rather than sent to an older one.
func TestResolveMessageTargetRefusesWhenOwningLedgerIsNotFresh(t *testing.T) {
	for _, tc := range []struct {
		name   string
		origin map[string]any
		want   string
	}{
		{"stale", map[string]any{"stale": true, "last_error": nil}, "is stale"},
		{"failing", map[string]any{"stale": false, "last_error": "http_status 404"}, "is failing"},
		{"missing", nil, "not part of the composite"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := writeMessageTargetFiber(t, map[string]any{
				"kind":        "oneshot",
				"host":        "new-node",
				"agent":       "claude-opus",
				"project_dir": t.TempDir(),
				"runtime":     map[string]any{"session_uuid": "old-session"},
			})
			isolateMessageFiberStore(t, store)
			origins := map[string]any{"old-node": map[string]any{"stale": false, "last_error": nil}}
			if tc.origin != nil {
				origins["new-node"] = tc.origin
			}
			messageTargetDaemonWithOrigins(t, nil, []SessionProvenance{{
				Fiber: "work/worker", UID: messageTargetFiberUID, Session: "old-session",
				Host: "old-node", Harness: "claude-code", At: 1, Kind: "dispatch",
			}}, origins)

			_, err := testApp(t).resolveMessageTarget("work/worker")
			if err == nil || !strings.Contains(err.Error(), `host "new-node"`) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected refusal for a %s owning-host ledger, got %v", tc.name, err)
			}
		})
	}
}

// A Codex claim row carries a transcript id, not the addressable thread id;
// without a peer or ledger thread mapping the target is refused, never guessed.
func TestResolveMessageTargetRefusesCodexTranscriptWithoutThread(t *testing.T) {
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
			Fiber: "work/worker", UID: messageTargetFiberUID, Session: "new-transcript",
			Host: "new-node", Harness: "codex", At: 2, Kind: "claim",
		},
	})

	_, err := testApp(t).resolveMessageTarget("work/worker")
	if err == nil || !strings.Contains(err.Error(), "thread id is not yet known") ||
		!strings.Contains(err.Error(), "new-transcript") || !strings.Contains(err.Error(), "explicit shuttle:// address") {
		t.Fatalf("expected Codex transcript refusal, got %v", err)
	}
}

func TestResolveMessageTargetIgnoresEmptyBackfillRow(t *testing.T) {
	const runtimeID = "7b57d3d9-92c8-4d22-b0bd-3a2db1c56ea0"
	store := writeMessageTargetFiber(t, map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
		"runtime":     map[string]any{"session_uuid": runtimeID},
	})
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, []SessionProvenance{
		{Fiber: "work/worker", UID: messageTargetFiberUID, Session: runtimeID, Host: "worker-node", Harness: "claude-code", At: 1, Kind: "dispatch"},
		{Fiber: "work/worker", UID: messageTargetFiberUID, Host: "worker-node", Harness: "codex", At: 2, Kind: "dispatch"},
	})

	got, err := testApp(t).resolveMessageTarget("work/worker")
	if err != nil {
		t.Fatal(err)
	}
	if want := "shuttle://worker-node/claude/" + runtimeID; got != want {
		t.Fatalf("resolved address = %q, want %q", got, want)
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

	_, err := testApp(t).resolveMessageTarget("work/worker")
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

	_, err := testApp(t).resolveMessageTarget("session-42")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "shuttle://session-node/claude/session-42") ||
		!strings.Contains(err.Error(), "fiber session-42") {
		t.Fatalf("expected session/fiber collision refusal, got %v", err)
	}
}

// A bare slug naming several fibers in one store is refused with every full
// path it names, never reported as matching nothing.
func TestResolveMessageTargetAmbiguousSlugListsFullPaths(t *testing.T) {
	store, storage := newStore(t)
	for _, id := range []string{"science/cmbx/data", "science/lensing/data"} {
		if err := storage.Write(&felt.Felt{ID: id, Name: id}); err != nil {
			t.Fatal(err)
		}
	}
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, nil)

	_, err := testApp(t).resolveMessageTarget("data")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "fiber science/cmbx/data") || !strings.Contains(err.Error(), "fiber science/lensing/data") {
		t.Fatalf("expected both full paths, got %v", err)
	}
	if _, err := testApp(t).shuttleAddressFiber("data"); err == nil || !strings.Contains(err.Error(), "science/cmbx/data") || !strings.Contains(err.Error(), "science/lensing/data") {
		t.Fatalf("address fiber lookup did not list candidates: %v", err)
	}
}

// A slug unique in the store resolves like the fiber's full path.
func TestResolveMessageTargetUniqueNestedSlugResolvesLikeFullPath(t *testing.T) {
	block := map[string]any{
		"kind":        "oneshot",
		"host":        "worker-node",
		"agent":       "claude-opus",
		"project_dir": t.TempDir(),
	}
	store := writeMessageTargetFiberWithID(t, "science/cmbx/sims/glass/6x2pt-mocks", messageTargetFiberUID, block)
	isolateMessageFiberStore(t, store)
	messageTargetDaemon(t, nil, []SessionProvenance{{
		Session: messageTargetSession,
		UID:     messageTargetFiberUID,
		Host:    "worker-node",
		Harness: "claude-code",
		Fiber:   "science/cmbx/sims/glass/6x2pt-mocks",
		Kind:    "dispatch",
	}})
	want := "shuttle://worker-node/claude/" + messageTargetSession
	for _, target := range []string{"science/cmbx/sims/glass/6x2pt-mocks", "6x2pt-mocks", "glass/6x2pt-mocks"} {
		got, err := testApp(t).resolveMessageTarget(target)
		if err != nil || got != want {
			t.Fatalf("%s resolved to %q, %v; want %q", target, got, err, want)
		}
	}
}
