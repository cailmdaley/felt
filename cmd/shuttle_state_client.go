package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// The decoded shapes of the daemon's state endpoints — the structured half of the
// :4000 HTTP client whose primitives (daemonURL, the lifecycle hop) live in
// shuttle_daemon.go. Most `felt shuttle` verbs are pure local-frontmatter writes;
// these types back the daemon-coupled READ verbs: snapshot (raw passthrough) and
// status --all / --remote (composite render). Own-host identity resolution
// (resolveOwnHost, shuttle_host.go) no longer round-trips through here — it
// reads SHUTTLE_HOST / ~/.shuttle/host / os.Hostname() locally.
//
// Cross-host visibility goes through the local daemon's composite endpoint: the
// daemon's RemoteRegistry already polls each configured remote over its
// SSH-tunnel-mapped port and caches snapshots with freshness, so the CLI just
// renders that one response — remote configuration never leaks into felt. Ported
// from shuttle-ctl's state_client.go; the wire format (endpoint paths, JSON keys)
// is unchanged so the transitional `shuttle-ctl` -> `felt shuttle` shim is
// transparent to the Elixir daemon.

// SnapshotEntry mirrors a single row from `Shuttle.Poller.build_snapshot/1`'s
// `eligible` list. Fields the CLI does not render today are still decoded so we can
// surface them later without a wire-format change.
type SnapshotEntry struct {
	FiberID        string `json:"fiber_id"`
	FeltStore      string `json:"felt_store,omitempty"`
	TmuxSession    string `json:"tmux_session,omitempty"`
	Agent          string `json:"agent,omitempty"`
	State          string `json:"state,omitempty"`
	RunID          string `json:"run_id,omitempty"`
	StartedAt      int64  `json:"started_at,omitempty"`
	LastActivityAt int64  `json:"last_activity_at,omitempty"`
	RuntimeSeconds int64  `json:"runtime_seconds,omitempty"`
}

// StandingRoleEntry mirrors `Poller.standing_role_snapshots/2` rows. Standing-role
// entries don't carry `agent` (it lives in the fiber frontmatter only); the
// cross-host render shows `(default)` in that column.
type StandingRoleEntry struct {
	FiberID    string         `json:"fiber_id"`
	State      string         `json:"state,omitempty"`
	RunID      string         `json:"run_id,omitempty"`
	NextDueAt  *int64         `json:"next_due_at,omitempty"`
	LastRunAt  *int64         `json:"last_run_at,omitempty"`
	Schedule   map[string]any `json:"schedule,omitempty"`
	Validation []any          `json:"validation_errors,omitempty"`
	Extra      map[string]any `json:"-"`
}

// RetryEntry mirrors `Poller.build_snapshot/1`'s `retrying` rows.
type RetryEntry struct {
	FiberID string `json:"fiber_id"`
	Attempt int    `json:"attempt,omitempty"`
	DueInMS int64  `json:"due_in_ms,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Snapshot is the daemon's per-host runtime state (GET /api/v1/state). Used by
// the raw snapshot passthrough and the cross-host composite render; own-host
// identity resolution (resolveOwnHost) does not consume this type.
type Snapshot struct {
	PollAt        int64               `json:"poll_at,omitempty"`
	Host          string              `json:"host,omitempty"`
	FeltStores    []string            `json:"felt_stores,omitempty"`
	Eligible      []SnapshotEntry     `json:"eligible,omitempty"`
	Retrying      []RetryEntry        `json:"retrying,omitempty"`
	StandingRoles []StandingRoleEntry `json:"standing_roles,omitempty"`
	ClaimedCount  int                 `json:"claimed_count,omitempty"`
}

// RemoteRecovery is the laptop daemon's per-origin self-healing state. Healthy is
// the steady state; non-healthy values describe the current recovery cascade or
// backoff window.
type RemoteRecovery struct {
	State       string `json:"state,omitempty"`
	Attempt     int    `json:"attempt,omitempty"`
	LastError   string `json:"last_error,omitempty"`
	LastAction  string `json:"last_action,omitempty"`
	NextRetryAt string `json:"next_retry_at,omitempty"`
}

// RemoteSnapshot is one entry in the composite endpoint's `remotes` map: a remote
// daemon's snapshot plus freshness metadata maintained by the laptop's
// `Shuttle.RemoteRegistry`.
type RemoteSnapshot struct {
	Snapshot     *Snapshot       `json:"snapshot"`
	LastPolledAt string          `json:"last_polled_at,omitempty"`
	Stale        bool            `json:"stale"`
	LastError    string          `json:"last_error,omitempty"`
	Recovery     *RemoteRecovery `json:"recovery,omitempty"`
}

// CompositeState is the response shape of GET /api/v1/state/composite.
type CompositeState struct {
	Local   *Snapshot                  `json:"local"`
	Remotes map[string]*RemoteSnapshot `json:"remotes"`
}

// fetchComposite calls GET /api/v1/state/composite on the local daemon and decodes
// the response.
func fetchComposite() (*CompositeState, error) {
	return fetchCompositeFrom(daemonURL() + "/api/v1/state/composite")
}

// fetchCompositeFrom calls the given composite URL and decodes it. Returns a
// wrapped error on transport failure or non-200 status, including the daemon URL so
// the user knows which daemon they're trying to reach (tests point it at an
// httptest stub).
func fetchCompositeFrom(url string) (*CompositeState, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w (start the daemon with `make start` or set SHUTTLE_DAEMON_URL)", daemonURL(), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading daemon response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("daemon returned %d: %s", resp.StatusCode, string(body))
	}

	var out CompositeState
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parsing daemon response: %w", err)
	}
	return &out, nil
}
