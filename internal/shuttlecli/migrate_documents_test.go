package shuttlecli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func migrationDocumentsFixture(t *testing.T) migrateDocumentsRequest {
	t.Helper()
	_, st := newStore(t)
	var docs []migrateDocument
	for _, id := range []string{"a", "b"} {
		seedShuttleRole(t, st, id, felt.StatusActive, oneshot(), nil)
		f := mustRead(t, st, id)
		raw, err := os.ReadFile(f.Path)
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, []byte("\n## Status\n\nLatest worker edits.\n\n")...)
		if err := os.WriteFile(f.Path, raw, 0644); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, migrateDocument{Path: f.Path, UID: f.UID,
			Before: map[string]any{"status": "active", "horizon": nil, "tempered": nil, "closed-at": nil, "ask": nil, "shuttle.runtime": nil},
			After:  map[string]any{"status": "open", "horizon": "stashed", "tempered": true, "closed-at": "2026-04-10T09:00:00Z", "ask": map[string]any{"text": "Ready?", "at": "2026-04-10T09:00:00Z"}, "shuttle.runtime": map[string]any{"session_uuid": "native-session", "dispatched_at": "2026-04-10T09:00:00Z"}},
		})
	}
	return migrateDocumentsRequest{Mode: "forward", Documents: docs}
}

func migrationDocumentBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestMigrateDocumentsForwardReverseCheckPreserveFreshBody(t *testing.T) {
	t.Parallel()
	req := migrationDocumentsFixture(t)
	before := [][]byte{migrationDocumentBytes(t, req.Documents[0].Path), migrationDocumentBytes(t, req.Documents[1].Path)}
	env := testEnv(t)
	for _, mode := range []string{"check", "forward", "forward", "check", "reverse", "reverse"} {
		req.Mode = mode
		encoded, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		out, _, err := executeIn(t, env, "", "migrate-documents", "--request-json", string(encoded))
		if err != nil {
			t.Fatalf("%s: %v\n%s", mode, err, out)
		}
		var result migrateDocumentsResult
		if err := json.Unmarshal([]byte(out), &result); err != nil || !result.OK {
			t.Fatalf("result %s (%v)", out, err)
		}
		for i, doc := range req.Documents {
			raw := migrationDocumentBytes(t, doc.Path)
			body := raw[bytes.Index(raw, []byte("## Status")):]
			wantBody := before[i][bytes.Index(before[i], []byte("## Status")):]
			if !bytes.Equal(body, wantBody) {
				t.Fatalf("%s replaced body", mode)
			}
			if mode == "forward" {
				f, err := felt.Parse("", raw)
				if err != nil || f.Status != felt.StatusOpen {
					t.Fatalf("forward did not patch status: %+v (%v)", f, err)
				}
			}
			if _, err := prepareMigrateDocument(doc, raw, "check"); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Reverse restores fields, not old text: a worker can edit Status between
	// journal phases without losing its latest handoff surface.
	for _, doc := range req.Documents {
		raw := migrationDocumentBytes(t, doc.Path)
		raw = bytes.ReplaceAll(raw, []byte("Latest worker edits."), []byte("Newer ## Status text; keep this."))
		if err := os.WriteFile(doc.Path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	req.Mode = "forward"
	if result := applyMigrateDocuments(req, felt.WriteFiberFile); !result.OK {
		t.Fatal(result)
	}
	req.Mode = "reverse"
	if result := applyMigrateDocuments(req, felt.WriteFiberFile); !result.OK {
		t.Fatal(result)
	}
	for _, doc := range req.Documents {
		raw := migrationDocumentBytes(t, doc.Path)
		if !bytes.Contains(raw, []byte("Newer ## Status text; keep this.")) {
			t.Fatal("fresh Status lost")
		}
		f, err := felt.Parse("", raw)
		if err != nil || f.Status != felt.StatusActive {
			t.Fatalf("reverse: %+v (%v)", f, err)
		}
		if felt.MappingValueNode(f.ExtraFields["shuttle"], "runtime") != nil || felt.MappingValueNode(f.ExtraFields["shuttle"], "ask") != nil {
			t.Fatal("reverse failed to delete nested fields")
		}
	}
}

func TestMigrateDocumentsPreflightAllBeforeWrites(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"uid", "field-mixture", "unexpected-status"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			req := migrationDocumentsFixture(t)
			switch mode {
			case "uid":
				req.Documents[1].UID = "wrong"
			case "field-mixture":
				raw := migrationDocumentBytes(t, req.Documents[1].Path)
				raw = bytes.Replace(raw, []byte("status: active"), []byte("status: open"), 1)
				if err := os.WriteFile(req.Documents[1].Path, raw, 0644); err != nil {
					t.Fatal(err)
				}
			case "unexpected-status":
				req.Documents[1].Before["status"] = "closed"
			}
			writes := 0
			result := applyMigrateDocuments(req, func(path string, data []byte) error { writes++; return felt.WriteFiberFile(path, data) })
			if result.Reason != "document_conflict" || writes != 0 {
				t.Fatalf("preflight = %+v, writes=%d", result, writes)
			}
		})
	}
}

func TestMigrateDocumentsRejectInvalidRequests(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"relative", "unclean", "symlink-alias", "duplicate", "alias-duplicate", "unknown-field", "field-sets", "bad-mode", "one-document"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			req := migrationDocumentsFixture(t)
			switch mode {
			case "relative":
				req.Documents[0].Path = "relative.md"
			case "unclean":
				req.Documents[0].Path = filepath.Dir(req.Documents[0].Path) + "/./a.md"
			case "symlink-alias", "alias-duplicate":
				alias := filepath.Join(t.TempDir(), "alias.md")
				if err := os.Symlink(req.Documents[0].Path, alias); err != nil {
					t.Fatal(err)
				}
				if mode == "symlink-alias" {
					req.Documents[0].Path = alias
				} else {
					req.Documents[1].Path = alias
				}
			case "duplicate":
				req.Documents[1].Path = req.Documents[0].Path
			case "unknown-field":
				req.Documents[0].Before["body"] = nil
				req.Documents[0].After["body"] = nil
			case "field-sets":
				delete(req.Documents[0].Before, "status")
			case "bad-mode":
				req.Mode = "rollback"
			case "one-document":
				req.Documents = req.Documents[:1]
			}
			writes := 0
			result := applyMigrateDocuments(req, func(string, []byte) error { writes++; return nil })
			if result.Reason != "invalid_request" || writes != 0 {
				t.Fatalf("invalid request = %+v, writes=%d", result, writes)
			}
		})
	}
}

func TestMigrateDocumentsHoldsBothCanonicalLocksDuringWrites(t *testing.T) {
	t.Parallel()
	req := migrationDocumentsFixture(t)
	// Reverse input order must not affect lock/write ordering.
	req.Documents[0], req.Documents[1] = req.Documents[1], req.Documents[0]
	var paths []string
	result := applyMigrateDocuments(req, func(path string, data []byte) error {
		paths = append(paths, path)
		for _, doc := range req.Documents {
			lock, err := os.OpenFile(doc.Path+".lock", os.O_RDWR, 0644)
			if err != nil {
				t.Fatal(err)
			}
			err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
			if err == nil {
				_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
			}
			lock.Close()
			if !errors.Is(err, syscall.EWOULDBLOCK) {
				t.Fatalf("both locks must be held before any write: %s (%v)", doc.Path, err)
			}
		}
		return felt.WriteFiberFile(path, data)
	})
	if !result.OK || len(paths) != 2 || paths[0] >= paths[1] {
		t.Fatalf("sorted locked writes = %v (%+v)", paths, result)
	}
}

func TestMigrateDocumentsCLIRejectsMalformedJSON(t *testing.T) {
	t.Parallel()
	for _, request := range []string{"", "{", "{} {}", `{"mode":"check","documents":[],"surprise":true}`} {
		env := testEnv(t)
		out, _, err := executeIn(t, env, "", "migrate-documents", "--request-json", request)
		var result migrateDocumentsResult
		if err == nil || json.Unmarshal([]byte(out), &result) != nil || result.OK || result.Reason != "invalid_request" {
			t.Fatalf("malformed request %q: %s (%v)", request, out, err)
		}
	}
}

func TestMigrateDocumentsPartialWriteAndObservableConflict(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"write-error", "editor-conflict"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			req := migrationDocumentsFixture(t)
			calls := 0
			result := applyMigrateDocuments(req, func(path string, data []byte) error {
				calls++
				if calls == 2 {
					return errors.New("injected disk failure")
				}
				if err := felt.WriteFiberFile(path, data); err != nil {
					return err
				}
				if mode == "editor-conflict" {
					other := req.Documents[1].Path
					raw := migrationDocumentBytes(t, other)
					return os.WriteFile(other, append(raw, []byte("External editor work.\n")...), 0644)
				}
				return nil
			})
			want := "write_failed"
			if mode == "editor-conflict" {
				want = "document_conflict"
			}
			if result.Reason != want {
				t.Fatalf("result = %+v", result)
			}
			// First document remains forward; replay can reconcile a mixed document
			// pair without replacing either body's fresh edits.
			f, err := felt.Parse("", migrationDocumentBytes(t, req.Documents[0].Path))
			if err != nil || f.Status != felt.StatusOpen {
				t.Fatalf("first write rolled back: %+v (%v)", f, err)
			}
			if result := applyMigrateDocuments(req, felt.WriteFiberFile); !result.OK {
				t.Fatalf("mixed-state replay: %+v", result)
			}
			if mode == "editor-conflict" && !strings.Contains(string(migrationDocumentBytes(t, req.Documents[1].Path)), "External editor work.") {
				t.Fatal("replay lost editor work")
			}
		})
	}
}
