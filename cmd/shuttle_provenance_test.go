package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const provenanceSession = "01a02f80-b023-7ed2-8f3d-8f5b7b94ce21"

func TestShuttleSessions_FollowsUIDAndDedupesHistory(t *testing.T) {
	defer saveShuttleGlobals()()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sessionsCompositePath {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"records":[
          {"fiber":"old/name","uid":"01UID","session":"` + provenanceSession + `","host":"candide","harness":"codex","kind":"dispatch","at":1,"transcript":{"availability":"available_remote","host":"candide","source_path":"/remote/codex.jsonl","byte_count":3,"sha256":"abc"}},
          {"fiber":"new/name","uid":"01UID","session":"` + provenanceSession + `","host":"candide","harness":"codex","kind":"resume","at":2,"transcript":{"availability":"available_remote","host":"candide","source_path":"/remote/codex.jsonl","byte_count":3,"sha256":"abc"}},
          {"fiber":"new/name","uid":"01UID","session":"other","host":"cineca","harness":"claude-code","kind":"dispatch","at":3,"transcript":{"availability":"transcript_missing"}},
          {"fiber":"other","uid":"02UID","session":"ignored","host":"candide","harness":"codex","kind":"dispatch","at":4}
        ]}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "new/name", "--json")
	if err != nil {
		t.Fatalf("sessions: %v\n%s", err, out)
	}
	var rows []SessionProvenance
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(rows) != 2 {
		t.Fatalf("expected two distinct host/harness/session rows, got %#v", rows)
	}
	if rows[0].Fiber != "old/name" || rows[1].Fiber != "new/name" {
		t.Fatalf("historical fiber paths/order were not retained: %#v", rows)
	}
	if len(rows[0].Events) != 2 || rows[0].Events[0].Kind != "dispatch" || rows[0].Events[1].Kind != "resume" {
		t.Fatalf("duplicate ledger rows did not preserve ordered lifecycle events: %#v", rows[0].Events)
	}
}

func TestShuttleTranscript_RemoteVerifiesAndCachesExactBytes(t *testing.T) {
	defer saveShuttleGlobals()()
	body := []byte("{\"type\":\"response_item\"}\n")
	digest := sha256.Sum256(body)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[{"session":"` + provenanceSession + `","host":"candide"}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_remote","host":"candide","harness":"codex","source_path":"/remote/codex.jsonl","byte_count":` + strconv.Itoa(len(body)) + `,"sha256":"` + hex.EncodeToString(digest[:]) + `"}`))
		case "/api/v1/transcript/raw":
			w.Header().Set("X-Transcript-Byte-Count", "25")
			w.Header().Set("X-Transcript-SHA256", hex.EncodeToString(digest[:]))
			_, _ = w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	cache := t.TempDir()
	t.Setenv("FELT_TRANSCRIPT_CACHE_DIR", cache)
	out, err := runCommand(t, t.TempDir(), "shuttle", "transcript", provenanceSession)
	if err != nil {
		t.Fatalf("transcript: %v\n%s", err, out)
	}
	path := strings.TrimSpace(out)
	if filepath.Dir(path) != cache {
		t.Fatalf("cache path = %q, want under %q", path, cache)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("cache changed transcript bytes: %q", got)
	}
}

func TestShuttleTranscript_RemoteAcceptsEmptyFileWithoutSourcePath(t *testing.T) {
	defer saveShuttleGlobals()()
	digest := sha256.Sum256(nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[{"session":"` + provenanceSession + `","host":"candide"}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_remote","host":"candide","byte_count":0,"sha256":"` + hex.EncodeToString(digest[:]) + `"}`))
		case "/api/v1/transcript/raw":
			w.Header().Set("X-Transcript-Byte-Count", "0")
			w.Header().Set("X-Transcript-SHA256", hex.EncodeToString(digest[:]))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	t.Setenv("FELT_TRANSCRIPT_CACHE_DIR", t.TempDir())
	out, err := runCommand(t, t.TempDir(), "shuttle", "transcript", provenanceSession)
	if err != nil {
		t.Fatalf("empty transcript: %v\n%s", err, out)
	}
	info, err := os.Stat(strings.TrimSpace(out))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 {
		t.Fatalf("cached empty transcript has %d bytes", info.Size())
	}
}

func TestShuttleTranscript_RawSnapshotReceiptWinsWhenLiveFileGrew(t *testing.T) {
	defer saveShuttleGlobals()()
	old := []byte("old\n")
	current := []byte("old\nnew\n")
	oldDigest := sha256.Sum256(old)
	currentDigest := sha256.Sum256(current)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[{"session":"` + provenanceSession + `","host":"candide"}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_remote","host":"candide","source_path":"/remote/live.jsonl","byte_count":` + strconv.Itoa(len(old)) + `,"sha256":"` + hex.EncodeToString(oldDigest[:]) + `"}`))
		case "/api/v1/transcript/raw":
			w.Header().Set("X-Transcript-Byte-Count", strconv.Itoa(len(current)))
			w.Header().Set("X-Transcript-SHA256", hex.EncodeToString(currentDigest[:]))
			_, _ = w.Write(current)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	t.Setenv("FELT_TRANSCRIPT_CACHE_DIR", t.TempDir())
	out, err := runCommand(t, t.TempDir(), "shuttle", "transcript", provenanceSession)
	if err != nil {
		t.Fatalf("growing transcript: %v\n%s", err, out)
	}
	got, err := os.ReadFile(strings.TrimSpace(out))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(current) {
		t.Fatalf("cached bytes = %q, want current raw snapshot %q", got, current)
	}
}

func TestShuttleTranscript_RejectsNonUUIDBeforeHTTP(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	if _, err := runCommand(t, t.TempDir(), "shuttle", "transcript", "not-a-session"); err == nil || !strings.Contains(err.Error(), "invalid session ID") {
		t.Fatalf("expected UUID validation error, got %v", err)
	}
}

func TestShuttleTranscript_HashMismatchPreservesExistingCache(t *testing.T) {
	defer saveShuttleGlobals()()
	good := []byte("previous verified transcript\n")
	bad := []byte("truncated transfer\n")
	goodDigest := sha256.Sum256(good)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[{"session":"` + provenanceSession + `","host":"candide"}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_remote","host":"candide","source_path":"/remote/codex.jsonl","byte_count":` + strconv.Itoa(len(good)) + `,"sha256":"` + hex.EncodeToString(goodDigest[:]) + `"}`))
		case "/api/v1/transcript/raw":
			_, _ = w.Write(bad)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	cache := t.TempDir()
	t.Setenv("FELT_TRANSCRIPT_CACHE_DIR", cache)
	_, destination, err := transcriptCachePath(provenanceSession)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, good, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := runCommand(t, t.TempDir(), "shuttle", "transcript", provenanceSession); err == nil || !strings.Contains(err.Error(), "byte count") {
		t.Fatalf("expected verified transfer failure, got %v", err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(good) {
		t.Fatalf("failed transfer replaced verified cache: %q", got)
	}
	matches, err := filepath.Glob(filepath.Join(cache, ".transcript-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("failed transfer left temporary files: %v", matches)
	}
}

func TestShuttleTranscript_LocalJSONCarriesBothPaths(t *testing.T) {
	defer saveShuttleGlobals()()
	native := "/Users/cail/.codex/sessions/rollout.jsonl"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[{"session":"` + provenanceSession + `","host":"local"}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_local","host":"local","harness":"codex","source_path":"` + native + `","byte_count":12,"sha256":"abc"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "transcript", provenanceSession, "--json")
	if err != nil {
		t.Fatalf("transcript --json: %v\n%s", err, out)
	}
	var result transcriptCommandResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.SourcePath != native || result.LocalPath != native {
		t.Fatalf("local JSON paths = source %q local %q, want %q", result.SourcePath, result.LocalPath, native)
	}
}

func TestIdentityPendingAppendsAlongsideHistoricalSessions(t *testing.T) {
	f := shuttleFeltWithBlock(t, map[string]any{
		"kind":    "oneshot",
		"runtime": map[string]any{"dispatched_at": "2026-08-23T18:00:00Z"},
	})
	rows := []SessionProvenance{{Session: provenanceSession, UID: "01UID"}}
	got := addIdentityPending("new/name", "01UID", rows, f)
	if len(got) != 2 || got[1].Transcript.Availability != "identity_pending" {
		t.Fatalf("pending dispatch should append to historical rows: %#v", got)
	}
	if !runtimeDispatched(f) {
		t.Fatal("dispatched_at without session_uuid should be pending")
	}
	if err := f.SetShuttleRuntimeField("session_uuid", provenanceSession); err != nil {
		t.Fatal(err)
	}
	if runtimeDispatched(f) {
		t.Fatal("captured session_uuid must clear identity_pending")
	}
}

func TestCompositeFiberRuntimePendingRequiresMissingSession(t *testing.T) {
	defer saveShuttleGlobals()()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/fibers/composite" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"fibers":[{"fiber":{"id":"01UID","slug":"remote/name","shuttle":{"runtime":{"dispatched_at":"2026-08-23T18:00:00Z"}}}}]}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	if !compositeFiberRuntimePending("remote/name") {
		t.Fatal("remote dispatched_at without session_uuid should be pending")
	}
}

func TestApplyOriginFreshnessDoesNotChangeAvailability(t *testing.T) {
	rows := []SessionProvenance{{
		Host: "cineca",
		Transcript: TranscriptReceipt{
			Availability: "available_remote",
		},
	}}
	got := applyOriginFreshness(rows, map[string]any{"cineca": map[string]any{"stale": true}})
	if !got[0].Stale || got[0].Transcript.Availability != "available_remote" {
		t.Fatalf("origin freshness and transcript availability were conflated: %#v", got[0])
	}
}

func resetSessionsFlags() func() {
	return func() {
		sessionsCommitSHA, sessionsMaterialize, sessionsDir = "", false, ""
	}
}

// One daemon fake serving all four composite/transcript surfaces, so reverse
// lookup and materialization can be exercised end to end.
func provenanceDaemon(t *testing.T, transcriptBody []byte) *httptest.Server {
	t.Helper()
	digest := sha256.Sum256(transcriptBody)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[
              {"fiber":"old/name","uid":"01UID","session":"` + provenanceSession + `","host":"candide","harness":"codex","kind":"dispatch","at":1},
              {"fiber":"new/name","uid":"01UID","session":"` + provenanceSession + `","host":"candide","harness":"codex","kind":"resume","at":2}
            ]}`))
		case "/api/v1/commits/composite":
			_, _ = w.Write([]byte(`{"records":[{"sha":"79def80abc123","session":"` + provenanceSession + `","kind":"commit","at":5}]}`))
		case "/api/v1/fibers/composite":
			_, _ = w.Write([]byte(`{"fibers":[{"fiber":{"id":"01UID","slug":"new/name","status":"closed","tempered":true}}]}`))
		case transcriptPath:
			_, _ = w.Write([]byte(`{"session":"` + provenanceSession + `","availability":"available_remote","host":"candide","harness":"codex","source_path":"/remote/codex.jsonl","byte_count":` + strconv.Itoa(len(transcriptBody)) + `,"sha256":"` + hex.EncodeToString(digest[:]) + `"}`))
		case "/api/v1/transcript/raw":
			w.Header().Set("X-Transcript-Byte-Count", strconv.Itoa(len(transcriptBody)))
			w.Header().Set("X-Transcript-SHA256", hex.EncodeToString(digest[:]))
			_, _ = w.Write(transcriptBody)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestShuttleSessions_ReverseLookupBySessionUUID(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	server := provenanceDaemon(t, []byte("x\n"))
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", provenanceSession, "--json")
	if err != nil {
		t.Fatalf("reverse lookup: %v\n%s", err, out)
	}
	var result struct {
		Owner    sessionOwner        `json:"owner"`
		Sessions []SessionProvenance `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if result.Owner.Fiber != "new/name" || result.Owner.UID != "01UID" {
		t.Fatalf("owner = %#v, want most-recent fiber new/name", result.Owner)
	}
	if result.Owner.Status != "closed" || !result.Owner.Tempered {
		t.Fatalf("disposition not resolved: %#v", result.Owner)
	}
	if len(result.Sessions) != 1 || len(result.Sessions[0].Events) != 2 {
		t.Fatalf("owning fiber's session rows missing: %#v", result.Sessions)
	}
}

func TestShuttleSessions_ReverseLookupByCommit(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	server := provenanceDaemon(t, []byte("x\n"))
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "--commit", "79def80", "--json")
	if err != nil {
		t.Fatalf("commit lookup: %v\n%s", err, out)
	}
	var result struct {
		Owner sessionOwner `json:"owner"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Owner.Session != provenanceSession || result.Owner.Fiber != "new/name" {
		t.Fatalf("commit did not resolve through the ledgers: %#v", result.Owner)
	}
}

func TestShuttleSessions_UnrecordedCommitIsHonest(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	server := provenanceDaemon(t, []byte("x\n"))
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	_, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "--commit", "deadbeef")
	if err == nil || !strings.Contains(err.Error(), "not recorded") {
		t.Fatalf("want honest not-recorded error, got %v", err)
	}
}

func TestShuttleSessions_MaterializeWritesManifestAndTranscripts(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	body := []byte("{\"type\":\"response_item\"}\n")
	server := provenanceDaemon(t, body)
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	t.Setenv("FELT_TRANSCRIPT_CACHE_DIR", t.TempDir())
	dir := t.TempDir()
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "new/name", "--materialize", "--dir", dir, "--json")
	if err != nil {
		t.Fatalf("materialize: %v\n%s", err, out)
	}
	var result struct {
		Manifest string `json:"manifest"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Manifest != filepath.Join(dir, "manifest.json") {
		t.Fatalf("manifest path = %q", result.Manifest)
	}
	raw, err := os.ReadFile(result.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	var manifest transcriptManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Fiber != "new/name" || manifest.UID != "01UID" || len(manifest.Sessions) != 1 {
		t.Fatalf("manifest = %#v", manifest)
	}
	item := manifest.Sessions[0]
	if item.Availability != "available_remote" || item.LocalPath == "" || len(item.Events) != 2 {
		t.Fatalf("manifest item incomplete: %#v", item)
	}
	got, err := os.ReadFile(item.LocalPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("materialized transcript bytes changed: %q", got)
	}
}

func TestShuttleSessions_ReverseLookupKeysOnLedgerUIDNotPath(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	// Fiber-less ledger rows: path round-tripping would match the first
	// fiber-less row (01OTHER); keying on the ledger's own UID must not.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sessionsCompositePath:
			_, _ = w.Write([]byte(`{"records":[
              {"uid":"01OTHER","session":"aaaaaaaa-0000-4000-8000-000000000000","host":"h","harness":"codex","kind":"dispatch","at":1,"transcript":{"availability":"transcript_missing"}},
              {"uid":"01UID","session":"` + provenanceSession + `","host":"h","harness":"codex","kind":"dispatch","at":2,"transcript":{"availability":"transcript_missing"}}
            ]}`))
		case "/api/v1/fibers/composite":
			_, _ = w.Write([]byte(`{"fibers":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", provenanceSession, "--json")
	if err != nil {
		t.Fatalf("reverse lookup: %v\n%s", err, out)
	}
	var result struct {
		Owner    sessionOwner        `json:"owner"`
		Sessions []SessionProvenance `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Owner.UID != "01UID" {
		t.Fatalf("owner = %#v", result.Owner)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].UID != "01UID" || result.Sessions[0].Session != provenanceSession {
		t.Fatalf("listed a different fiber's sessions: %#v", result.Sessions)
	}
}

func TestShuttleSessions_AmbiguousCommitPrefixErrors(t *testing.T) {
	defer saveShuttleGlobals()()
	defer resetSessionsFlags()()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/commits/composite" {
			_, _ = w.Write([]byte(`{"records":[
              {"sha":"79def80aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","session":"s1"},
              {"sha":"79def80bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","session":"s2"}
            ]}`))
			return
		}
		if r.URL.Path == sessionsCompositePath {
			_, _ = w.Write([]byte(`{"records":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	_, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "--commit", "79def80")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("want ambiguous-prefix error, got %v", err)
	}
}

func TestMaterialize_LocalWithoutPathIsAnErrorNotAbsence(t *testing.T) {
	rows := []SessionProvenance{{
		Session:    provenanceSession,
		Transcript: TranscriptReceipt{Availability: "available_local"},
	}}
	dir := t.TempDir()
	path, err := materializeFiberTranscripts("f", "01UID", rows, dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest transcriptManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	item := manifest.Sessions[0]
	if item.Error == "" || item.LocalPath != "" || item.Availability != "available_local" {
		t.Fatalf("pathless local transcript must carry an explicit error: %#v", item)
	}
}

// The temporal columns are the answer to "which session did the work last
// night?": a handoff line folds onto its dispatch row rather than opening a
// second one, the transcript's mtime becomes the end, and a session with no
// handoff line reads as unmarked rather than as a clean exit.
func TestShuttleSessions_TemporalColumnsAndHandoffMarker(t *testing.T) {
	defer saveShuttleGlobals()()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sessionsCompositePath {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"records":[
          {"fiber":"work/one","uid":"01UID","session":"` + provenanceSession + `","host":"candide","harness":"codex","kind":"dispatch","at":1000,"transcript":{"availability":"available_local","source_path":"/local/a.jsonl","byte_count":2048,"modified_at":9000}},
          {"fiber":"work/one","uid":"01UID","session":"` + provenanceSession + `","host":"candide","kind":"handoff","at":8000},
          {"fiber":"work/one","uid":"01UID","session":"died","host":"candide","harness":"codex","kind":"dispatch","at":2000,"transcript":{"availability":"transcript_missing"}}
        ]}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "work/one", "--json")
	if err != nil {
		t.Fatalf("sessions: %v\n%s", err, out)
	}
	var rows []SessionProvenance
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(rows) != 2 {
		t.Fatalf("the handoff line should fold onto its session's row, got %#v", rows)
	}
	handed, died := rows[0], rows[1]
	if handed.Session != provenanceSession {
		handed, died = rows[1], rows[0]
	}
	if handed.StartedAt != 1000 {
		t.Errorf("started_at should be the first recorded moment, got %d", handed.StartedAt)
	}
	if handed.EndedAt != 9000 {
		t.Errorf("ended_at should prefer the transcript's last write, got %d", handed.EndedAt)
	}
	if handed.HandedOffAt != 8000 {
		t.Errorf("handed_off_at should come from the ledger's handoff line, got %d", handed.HandedOffAt)
	}
	if died.HandedOffAt != 0 || died.EndedAt != 0 {
		t.Errorf("a session with no handoff and no transcript must claim neither, got %#v", died)
	}

	// --json is a root persistent flag; cobra only sets it on parse, so clear it
	// before asking the same command for its text table.
	jsonOutput = false
	sessionsRecent = 0
	table, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "work/one")
	if err != nil {
		t.Fatalf("sessions (table): %v\n%s", err, table)
	}
	for _, header := range []string{"START", "END", "SIZE", "EXIT"} {
		if !strings.Contains(table, header) {
			t.Errorf("table is missing the %s column:\n%s", header, table)
		}
	}
	if strings.Count(table, "handoff") != 1 {
		t.Errorf("exactly the handed-off row should be marked:\n%s", table)
	}
	if !strings.Contains(table, "2K") {
		t.Errorf("transcript size is not shown:\n%s", table)
	}
}

// --recent is the store-wide view: newest first, across fibers, with no fiber
// argument to give.
func TestShuttleSessions_RecentAcrossStore(t *testing.T) {
	defer saveShuttleGlobals()()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sessionsCompositePath {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"records":[
          {"fiber":"work/old","uid":"01UID","session":"aaa","host":"candide","harness":"codex","kind":"dispatch","at":1000,"transcript":{"availability":"transcript_missing"}},
          {"fiber":"work/new","uid":"02UID","session":"bbb","host":"cineca","harness":"claude-code","kind":"dispatch","at":5000,"transcript":{"availability":"transcript_missing"}},
          {"fiber":"work/mid","uid":"03UID","session":"ccc","host":"candide","harness":"codex","kind":"dispatch","at":3000,"transcript":{"availability":"transcript_missing"}}
        ]}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, t.TempDir(), "shuttle", "sessions", "--recent=2", "--json")
	if err != nil {
		t.Fatalf("sessions --recent: %v\n%s", err, out)
	}
	var rows []SessionProvenance
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(rows) != 2 {
		t.Fatalf("--recent 2 should bound the listing, got %d rows", len(rows))
	}
	if rows[0].Session != "bbb" || rows[1].Session != "ccc" {
		t.Fatalf("expected newest-first across fibers, got %s then %s", rows[0].Session, rows[1].Session)
	}
}

// A transcript the daemon called available_local is on this host by
// definition, so the CLI can stat it itself when the daemon's receipt predates
// modified_at. A remote one is left alone.
func TestLocalTranscriptModifiedAt_FillsOnlyLocalReceipts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("writing transcript: %v", err)
	}
	local := localTranscriptModifiedAt(SessionProvenance{
		Transcript: TranscriptReceipt{Availability: "available_local", SourcePath: path},
	})
	if local.Transcript.ModifiedAt == 0 {
		t.Errorf("a local transcript's mtime should be filled in from this host")
	}
	remote := localTranscriptModifiedAt(SessionProvenance{
		Transcript: TranscriptReceipt{Availability: "available_remote", SourcePath: path},
	})
	if remote.Transcript.ModifiedAt != 0 {
		t.Errorf("a remote transcript must not be stat'd locally, got %d", remote.Transcript.ModifiedAt)
	}
}
