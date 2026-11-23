package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestAdoptSessionCreateInstallClaimAndActivate(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	ownHost(t, env, "fir")
	env.Set("REX_SESSION", "session:human-1")
	env.Set("REX_BLOCK", "block:human-2")
	env.Set("CLAUDE_CODE_SESSION_ID", "uuid-1234")

	// Seed a role charter so --role can be verified.
	if err := st.Write(&felt.Felt{ID: "roles/builder", Name: "Builder", Tags: []string{"role"}}); err != nil {
		t.Fatal(err)
	}

	var claimPayload map[string]any
	var statusAtClaim string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/document-changed":
			w.WriteHeader(http.StatusOK)
			return
		case "/api/v1/claim":
			if err := json.NewDecoder(r.Body).Decode(&claimPayload); err != nil {
				t.Errorf("decode claim: %v", err)
			}
			// Verify the fiber is still an open draft when /api/v1/claim is called!
			if f, err := st.Read("work/ambient-task"); err == nil {
				statusAtClaim = f.Status
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"claimed":true,"session_uuid":"uuid-1234"}`))
		default:
			t.Errorf("unexpected daemon path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)

	out, stderr, err := executeIn(t, env, dir,
		"-C", dir,
		"adopt", "work/ambient-task", "Ambient Task",
		"--agent", "claude-opus",
		"--role", "builder",
		"--json",
	)
	if err != nil {
		t.Fatalf("adopt failed: %v (stderr: %s)", err, stderr)
	}
	if statusAtClaim != felt.StatusOpen {
		t.Fatalf("status during /api/v1/claim = %q, want %q (must be draft before claim)", statusAtClaim, felt.StatusOpen)
	}
	if claimPayload["tmux_session"] != "session:human-1" || claimPayload["tmux_pane"] != "block:human-2" {
		t.Fatalf("claim terminal coords = %v", claimPayload)
	}
	if claimPayload["session_uuid"] != "uuid-1234" || claimPayload["agent"] != "claude-opus" {
		t.Fatalf("claim payload = %v", claimPayload)
	}
	if !strings.Contains(out, `"claimed": true`) || !strings.Contains(out, `"status": "active"`) {
		t.Fatalf("adopt output = %s", out)
	}

	got := mustRead(t, st, "work/ambient-task")
	if got.Status != felt.StatusActive {
		t.Fatalf("final status = %q, want active", got.Status)
	}
	if got.Name != "Ambient Task" {
		t.Fatalf("name = %q, want Ambient Task", got.Name)
	}
	if got.Role != "builder" {
		t.Fatalf("role = %q, want builder", got.Role)
	}
	block, ok, err := shuttle.BlockOf(got)
	if err != nil || !ok {
		t.Fatalf("shuttle block = %v, %v, %v", block, ok, err)
	}
	if block.Host != "fir" || block.Agent != "claude-opus" || block.ProjectDir == "" {
		t.Fatalf("unexpected block: %+v", block)
	}
}

func TestAdoptSessionFailsClosedLeavesDraftOnClaimFailure(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	ownHost(t, env, "fir")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/document-changed" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"claimed":false,"reason":"session_not_found"}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)

	_, _, err := executeIn(t, env, dir,
		"-C", dir,
		"adopt", "work/fail-closed", "Fail Closed",
		"--session-uuid", "uuid-fail",
		"--tmux-session", "human-tmux",
		"--tmux-pane", "%3",
	)
	if err == nil || !strings.Contains(err.Error(), "left as open draft") {
		t.Fatalf("expected fail-closed error, got %v", err)
	}

	got := mustRead(t, st, "work/fail-closed")
	if got.Status != felt.StatusOpen {
		t.Fatalf("status after failed claim = %q, want open (must fail closed)", got.Status)
	}
	block, ok, err := shuttle.BlockOf(got)
	if err != nil || !ok || block.Host != "fir" {
		t.Fatalf("expected installed draft block, got %+v, %v, %v", block, ok, err)
	}
}

func TestAdoptSessionExistingFlag(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	ownHost(t, env, "fir")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/document-changed" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"claimed":true}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)

	// Missing fiber with --existing must fail without creating.
	_, _, err := executeIn(t, env, dir,
		"-C", dir,
		"adopt", "work/missing",
		"--existing",
		"--tmux-session", "sess",
		"--session-uuid", "uuid-1",
	)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("expected missing fiber error, got %v", err)
	}

	// Existing fiber with --existing succeeds.
	seedFiber(t, st, "work/already-here", "Already Here", felt.StatusOpen, nil, nil)
	_, stderr, err := executeIn(t, env, dir,
		"-C", dir,
		"adopt", "work/already-here",
		"--existing",
		"--tmux-session", "sess",
		"--session-uuid", "uuid-1",
	)
	if err != nil {
		t.Fatalf("adopt --existing failed: %v (stderr: %s)", err, stderr)
	}
	if got := mustRead(t, st, "work/already-here"); got.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
}
