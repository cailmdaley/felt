package shuttlecli

import (
	"fmt"
	"time"
)

// The decoded shapes of the daemon's state endpoints — the structured half of the
// :4000 HTTP client whose primitives (daemonURL, the lifecycle hop) live in
// shuttle_daemon.go. Most `shuttle` verbs are pure local-frontmatter writes;
// these types back the daemon-coupled READ verbs: snapshot (raw passthrough) and
// status --all / --remote (composite render).
//
// Cross-host visibility goes through the local daemon's composite endpoint: the
// daemon's RemoteRegistry already polls each configured remote over its
// SSH-tunnel-mapped port and caches snapshots with freshness, so the CLI just
// renders that one response.

// SnapshotEntry mirrors a single row from `Shuttle.Poller.build_snapshot/1`'s
// `eligible` list.
type SnapshotEntry struct {
	FiberID     string `json:"fiber_id"`
	TmuxSession string `json:"tmux_session,omitempty"`
	Agent       string `json:"agent,omitempty"`
	State       string `json:"state,omitempty"`
}

// StandingRoleEntry mirrors `Poller.standing_role_snapshots/2` rows. Standing-role
// entries don't carry `agent` (it lives in the fiber frontmatter only); the
// cross-host render shows `(default)` in that column.
type StandingRoleEntry struct {
	FiberID   string `json:"fiber_id"`
	State     string `json:"state,omitempty"`
	NextDueAt *int64 `json:"next_due_at,omitempty"`
	LastRunAt *int64 `json:"last_run_at,omitempty"`
}

// PendingLaunch is a fiber parked by the owning daemon.
type PendingLaunch struct {
	FiberID  string `json:"fiber_id"`
	UID      string `json:"uid"`
	Reason   string `json:"reason"`
	ParkedAt int64  `json:"parked_at"`
}

func (p PendingLaunch) since() string {
	if p.ParkedAt == 0 {
		return ""
	}
	return " since " + time.UnixMilli(p.ParkedAt).UTC().Format(time.RFC3339)
}

// Snapshot is the daemon's per-host runtime state (GET /api/v1/state).
type Snapshot struct {
	BootQuarantine bool                `json:"boot_quarantine"`
	PendingLaunch  []PendingLaunch     `json:"pending_launch"`
	Eligible       []SnapshotEntry     `json:"eligible,omitempty"`
	StandingRoles  []StandingRoleEntry `json:"standing_roles,omitempty"`
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
	Snapshot  *Snapshot       `json:"snapshot"`
	Stale     bool            `json:"stale"`
	LastError string          `json:"last_error,omitempty"`
	Recovery  *RemoteRecovery `json:"recovery,omitempty"`
}

// CompositeState is the response shape of GET /api/v1/state/composite.
type CompositeState struct {
	Local   *Snapshot                  `json:"local"`
	Remotes map[string]*RemoteSnapshot `json:"remotes"`
}

// fetchComposite calls GET /api/v1/state/composite on the local daemon and
// decodes the response. This is the surface where `shuttle status --all`
// discovers the daemon is down, so it adds the how-to-fix hint the shared
// transport has no business carrying.
func (a *app) fetchComposite() (*CompositeState, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/state/composite")
	if err != nil {
		return nil, err
	}
	out, err := a.fetchCompositeFrom(endpoint)
	if err != nil {
		if isLifecycleTransportError(err) {
			return nil, fmt.Errorf("%w (start the daemon with `make start` or set SHUTTLE_DAEMON_URL)", err)
		}
		return nil, err
	}
	return out, nil
}

// fetchCompositeFrom calls the given composite URL and decodes it (tests point
// it at an httptest stub).
func (a *app) fetchCompositeFrom(url string) (*CompositeState, error) {
	out, err := getDaemonJSON[CompositeState](a, url, "parsing daemon response")
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ownerSnapshot returns only a fresh observation of the owning daemon.
func (a *app) ownerSnapshot(c *CompositeState, host string) *Snapshot {
	if c == nil || host == "" {
		return nil
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return nil
	}
	if host == own {
		return c.Local
	}
	r := c.Remotes[host]
	if r == nil || r.Stale {
		return nil
	}
	return r.Snapshot
}

func (s *Snapshot) pending(id, uid string) *PendingLaunch {
	if s == nil {
		return nil
	}
	for i := range s.PendingLaunch {
		p := &s.PendingLaunch[i]
		if uid != "" && p.UID != "" {
			if p.UID == uid {
				return p
			}
			continue
		}
		if p.FiberID == id {
			return p
		}
	}
	return nil
}
