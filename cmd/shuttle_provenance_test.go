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
