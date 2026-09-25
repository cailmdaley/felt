package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The daemon HTTP client — the felt CLI's window onto the running shuttle
// daemon. Most `felt shuttle` verbs are pure local-frontmatter writes, but a few
// need the daemon: host identity (so a freshly installed block is born owned with
// the host the poller will compare against), and the soft lifecycle hop for
// standing-role resume/accept (which the daemon re-arms atomically against its
// poll cycle, falling back to a local write when it is down). Ported from
// shuttle-ctl's state_client.go; the daemon contract — endpoint paths, env vars,
// payload shapes — is unchanged so the transitional `shuttle-ctl` -> `felt
// shuttle` shim is transparent to the Elixir daemon that shells these verbs.

// daemonURL is the local shuttle daemon's base URL. No CLI flag by design — the
// daemon is a per-machine service. SHUTTLE_DAEMON_URL overrides it outright
// (tests point it at an httptest stub); otherwise it follows the listener the
// daemon binds (resolveHostSettings): http://127.0.0.1:<port> for a TCP
// listener, and the synthetic http://shuttle.invalid for a unix socket, which
// daemonHTTPClient dials through the socket.
//
// A host file or listener setting that does not resolve is an error naming
// its source, never a URL: a malformed operator file must not read as "daemon
// unreachable", which callers answer with a local fallback.
func daemonURL() (string, error) {
	if v := os.Getenv("SHUTTLE_DAEMON_URL"); v != "" {
		return v, nil
	}
	s, err := resolveHostSettings()
	if err != nil {
		return "", fmt.Errorf("resolving the daemon listener: %w", err)
	}
	if s.listen.Network == "tcp" {
		return "http://" + s.listen.Address, nil
	}
	return "http://" + daemonSocketHost, nil
}

// daemonEndpoint is daemonURL() plus a path.
func daemonEndpoint(path string) (string, error) {
	base, err := daemonURL()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(base, "/") + path, nil
}

// daemonHTTPClient is the one constructor for an HTTP client that talks to a
// shuttle daemon. A request to the synthetic host dials the local daemon's
// unix socket; every other host (a remote daemon over its tunnel port) dials
// normally, so one client serves getDaemon's local and remote callers alike.
func daemonHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The socket is local; an $HTTP_PROXY must never capture it.
	proxy := transport.Proxy
	transport.Proxy = func(req *http.Request) (*url.URL, error) {
		if req.URL.Host == daemonSocketHost || proxy == nil {
			return nil, nil
		}
		return proxy(req)
	}
	base := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != daemonSocketHost+":80" {
			return base(ctx, network, addr)
		}
		s, err := resolveHostSettings()
		if err != nil {
			return nil, err
		}
		if s.listen.Network != "unix" {
			return nil, fmt.Errorf("%s names no unix socket (listen is %s)", daemonSocketHost, s.Listen)
		}
		var d net.Dialer
		return d.DialContext(ctx, "unix", s.listen.Address)
	}
	// The daemon's CORS plug admits only loopback authorities, so the synthetic
	// host must not reach it: the request carries `Host: localhost` on the wire.
	// The daemon never redirects, so a Location header is not a hop to follow:
	// an absolute one would carry the request off the socket onto TCP.
	return &http.Client{
		Timeout:   timeout,
		Transport: socketHostTransport{transport},
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			return fmt.Errorf("daemon redirected to %s; the daemon API never redirects, refusing to follow", req.URL)
		},
	}
}

// socketHostTransport rewrites the wire Host of a request to the synthetic
// socket host to `localhost`, leaving the URL (and so the dial) untouched.
type socketHostTransport struct{ next http.RoundTripper }

func (t socketHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == daemonSocketHost {
		req = req.Clone(req.Context())
		req.Host = "localhost"
	}
	return t.next.RoundTrip(req)
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

// getDaemon and postDaemon are the CLI's only HTTP transport to a shuttle
// daemon — local or, over a tunnel, a remote one. Every daemon-facing verb goes
// through them, so "reaching daemon at %s" reads the same everywhere and
// isLifecycleTransportError has one error shape to recognize. Callers that want
// JSON unmarshal the returned bytes themselves.
func getDaemon(url string, timeout time.Duration) ([]byte, error) {
	client := daemonHTTPClient(timeout)
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func postDaemon(url string, payload []byte, timeout time.Duration) ([]byte, error) {
	client := daemonHTTPClient(timeout)
	resp, err := client.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

// getDaemonJSON is getDaemon plus a decode into T; label names the decode
// failure for the caller's verb. The transport error is returned unwrapped so
// isLifecycleTransportError still recognizes it.
func getDaemonJSON[T any](url, label string) (T, error) {
	var out T
	body, err := getDaemon(url, daemonReadTimeout)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, fmt.Errorf("%s: %w", label, err)
	}
	return out, nil
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

	endpoint, err := daemonEndpoint("/api/v1/lifecycle")
	if err != nil {
		return "", err
	}
	respBody, err := postDaemon(endpoint, body, daemonLifecycleTimeout)
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
