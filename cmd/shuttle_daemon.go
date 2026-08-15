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

// Timeouts for the daemon transport. Three, not one, because they bound
// different things: a read may cross an SSH tunnel to another machine's daemon
// (validate-identity fans out over every configured remote), a dispatch POST
// waits on the daemon's own work, and the lifecycle POST bounds how long
// `resume`/`accept` hang interactively before falling back to a local write.
const (
	daemonReadTimeout      = 15 * time.Second
	daemonPostTimeout      = 10 * time.Second
	daemonLifecycleTimeout = 5 * time.Second
)

// daemonStatusError is a non-2xx response — the daemon was reached but rejected
// the request (a logic error, NOT a transport failure). A distinct type so
// isLifecycleTransportError can tell "daemon down, fall back to a local write"
// from "daemon said no, surface it."
type daemonStatusError struct {
	url    string
	status int
	body   string
}

func (e daemonStatusError) Error() string {
	return fmt.Sprintf("daemon at %s returned %d: %s", e.url, e.status, e.body)
}

// getDaemon and postDaemon are the CLI's only HTTP transport to a Shuttle
// daemon — local or, over a tunnel, a remote one. Every daemon-facing verb goes
// through them, so "reaching daemon at %s" reads the same everywhere and
// isLifecycleTransportError has one error shape to recognize. Callers that want
// JSON unmarshal the returned bytes themselves.
func getDaemon(url string, timeout time.Duration) ([]byte, error) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func postDaemon(url string, payload []byte, timeout time.Duration) ([]byte, error) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func readDaemonResponse(url string, resp *http.Response) ([]byte, error) {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading daemon response from %s: %w", url, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, daemonStatusError{
			url:    url,
			status: resp.StatusCode,
			body:   strings.TrimSpace(string(body)),
		}
	}
	return body, nil
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

	respBody, err := postDaemon(daemonURL()+"/api/v1/lifecycle", body, daemonLifecycleTimeout)
	if err != nil {
		return "", err
	}
	return string(respBody), nil
}

// isLifecycleTransportError reports whether err means "daemon unreachable" (so
// the caller should fall back to a local document write) as opposed to a
// daemon-rejected request (a daemonStatusError, which must surface to the
// user).
func isLifecycleTransportError(err error) bool {
	if err == nil {
		return false
	}
	if _, ok := err.(daemonStatusError); ok {
		return false
	}
	return strings.Contains(err.Error(), "reaching daemon") ||
		strings.Contains(err.Error(), "SHUTTLE_LIFECYCLE_OFFLINE")
}
