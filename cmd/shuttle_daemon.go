package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// The :4000 daemon HTTP client — the felt CLI's window onto the running Shuttle
// daemon. Most `felt shuttle` verbs are pure local-frontmatter writes, but a few
// need the daemon: host identity (so a freshly installed block is born owned with
// the host the poller will compare against), and the soft lifecycle hop for
// standing-role resume/accept (which the daemon re-arms atomically against its
// poll cycle, falling back to a local write when it is down). Ported from
// shuttle-ctl's state_client.go; the daemon contract — endpoint paths, env vars,
// payload shapes — is unchanged so the transitional `shuttle-ctl` -> `felt
// shuttle` shim is transparent to the Elixir daemon that shells these verbs.

const defaultDaemonURL = "http://127.0.0.1:4000"

// daemonURL is the local Shuttle daemon's base URL. No CLI flag by design — the
// daemon is a per-machine service. SHUTTLE_DAEMON_URL overrides it (tests point
// it at an httptest stub).
func daemonURL() string {
	if v := os.Getenv("SHUTTLE_DAEMON_URL"); v != "" {
		return v
	}
	return defaultDaemonURL
}

// shuttleSnapshot is the subset of GET /api/v1/state the felt CLI consumes today.
// Only Host is needed (resolveOwnHost); the daemon emits far more (eligible
// workers, standing roles) that the local-read verbs will decode in a later
// slice.
type shuttleSnapshot struct {
	Host string `json:"host,omitempty"`
}

// fetchLocalHost queries the local daemon for its own_host_id — the authoritative
// identity the poller compares a block's host: against. install/repeat/pin stamp
// it so a block is born owned. Returns an error when the daemon is unreachable;
// callers fall back to SHUTTLE_HOST / os.Hostname().
func fetchLocalHost() (string, error) {
	url := daemonURL() + "/api/v1/state"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("daemon returned %d: %s", resp.StatusCode, string(body))
	}

	var s shuttleSnapshot
	if err := json.Unmarshal(body, &s); err != nil {
		return "", err
	}
	return s.Host, nil
}

// lifecycleStatusError is a non-200 response from POST /api/v1/lifecycle — the
// daemon was reached but rejected the request (a logic error, NOT a transport
// failure). A distinct type so isLifecycleTransportError can tell "daemon down,
// fall back to a local write" from "daemon said no, surface it."
type lifecycleStatusError struct {
	status int
	body   string
}

func (e lifecycleStatusError) Error() string {
	return fmt.Sprintf("daemon returned %d: %s", e.status, e.body)
}

// postLifecycle routes a lifecycle action (resume, accept) to the daemon, which
// applies it atomically against its poll cycle. The action is injected into the
// payload; the daemon's plain-text response is returned on success.
// SHUTTLE_LIFECYCLE_OFFLINE forces the offline path (callers then write the
// document locally).
func postLifecycle(action string, payload map[string]any) (string, error) {
	if os.Getenv("SHUTTLE_LIFECYCLE_OFFLINE") != "" {
		return "", fmt.Errorf("daemon lifecycle disabled by SHUTTLE_LIFECYCLE_OFFLINE")
	}

	payload["action"] = action
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encoding lifecycle request: %w", err)
	}

	url := daemonURL() + "/api/v1/lifecycle"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("reaching daemon at %s: %w", daemonURL(), err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading daemon response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", lifecycleStatusError{
			status: resp.StatusCode,
			body:   strings.TrimSpace(string(respBody)),
		}
	}
	return string(respBody), nil
}

// isLifecycleTransportError reports whether err means "daemon unreachable" (so
// the caller should fall back to a local document write) as opposed to a
// daemon-rejected request (a lifecycleStatusError, which must surface to the
// user).
func isLifecycleTransportError(err error) bool {
	if err == nil {
		return false
	}
	if _, ok := err.(lifecycleStatusError); ok {
		return false
	}
	return strings.Contains(err.Error(), "reaching daemon") ||
		strings.Contains(err.Error(), "SHUTTLE_LIFECYCLE_OFFLINE")
}
