package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// The daemon HTTP client — the shuttle CLI's window onto the running daemon
// daemon. Most `shuttle` verbs are pure local-frontmatter writes; the
// daemon-coupled ones are the read verbs (snapshot, sessions, status --all) and
// the soft lifecycle hop for standing-role resume/accept, which the daemon
// applies serialized with its Poller's state changes, falling back to a local
// write only when no connection to it could be made.

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
func (a *app) daemonURL() (string, error) {
	if v := a.env.Getenv("SHUTTLE_DAEMON_URL"); v != "" {
		return v, nil
	}
	s, err := a.resolveHostSettings()
	if err != nil {
		return "", fmt.Errorf("resolving the daemon listener: %w", err)
	}
	if s.listen.Network == "tcp" {
		return "http://" + s.listen.Address, nil
	}
	return "http://" + daemonSocketHost, nil
}

// daemonEndpoint is daemonURL() plus a path.
func (a *app) daemonEndpoint(path string) (string, error) {
	base, err := a.daemonURL()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(base, "/") + path, nil
}

// daemonHTTPClient is the one constructor for an HTTP client that talks to a
// shuttle daemon. A request to the synthetic host dials the local daemon's
// unix socket; every other host (a remote daemon over its tunnel port) dials
// normally, so one client serves getDaemon's local and remote callers alike.
func (a *app) daemonHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The socket is local; an $HTTP_PROXY must never capture it.
	proxy := a.httpProxy
	transport.Proxy = func(req *http.Request) (*url.URL, error) {
		if req.URL.Host == daemonSocketHost || proxy == nil {
			return nil, nil
		}
		return proxy(req)
	}
	base := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr == daemonSocketHost+":80" {
			s, err := a.resolveHostSettings()
			if err != nil {
				return nil, err
			}
			if s.listen.Network != "unix" {
				return nil, fmt.Errorf("%s names no unix socket (listen is %s)", daemonSocketHost, s.Listen)
			}
			var d net.Dialer
			return d.DialContext(ctx, "unix", s.listen.Address)
		}
		checkOwner, err := a.isSocketClassDaemonTCP(network, addr)
		if err != nil {
			return nil, err
		}
		if checkOwner {
			return dialAndCheckDaemonTCP(ctx, base, network, addr, "/proc", os.Geteuid(), acceptWait)
		}
		return base(ctx, network, addr)
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

func (a *app) isSocketClassDaemonTCP(network, address string) (bool, error) {
	if runtime.GOOS != "linux" || !strings.HasPrefix(network, "tcp") {
		return false, nil
	}
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return false, nil
	}
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return false, nil
	}
	settings, err := a.resolveHostSettings()
	if err != nil {
		return false, err
	}
	if !hostClass(settings.Class).usesSocket() || settings.listen.Network != "tcp" {
		return false, nil
	}
	gotPort, err := strconv.Atoi(portText)
	if err != nil {
		return false, nil
	}
	_, wantPort, err := parseTCPEndpoint(settings.listen.Address)
	return err == nil && gotPort == wantPort, nil
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
// `resume`/`accept` hang interactively (app.daemonLifecycleTimeout).
const (
	daemonReadTimeout = 15 * time.Second
	daemonPostTimeout = 10 * time.Second
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
func (a *app) getDaemon(url string, timeout time.Duration) ([]byte, error) {
	client := a.daemonHTTPClient(timeout)
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func (a *app) postDaemon(url string, payload []byte, timeout time.Duration) ([]byte, error) {
	return a.postDaemonContext(context.Background(), url, payload, timeout)
}

// postDaemonContext is postDaemon under ctx, for a caller that traces the
// request (postLifecycle).
func (a *app) postDaemonContext(ctx context.Context, url string, payload []byte, timeout time.Duration) ([]byte, error) {
	client := a.daemonHTTPClient(timeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("building daemon request to %s: %w", url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

// getDaemonJSON is getDaemon plus a decode into T; label names the decode
// failure for the caller's verb. The transport error is returned unwrapped so
// isLifecycleTransportError still recognizes it.
func getDaemonJSON[T any](a *app, url, label string) (T, error) {
	var out T
	body, err := a.getDaemon(url, daemonReadTimeout)
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

// daemonUnansweredError is a lifecycle request that reached the daemon — a
// connection was made — but got no response: the client timed out or the
// connection dropped. The daemon may still apply the transition, so the caller
// must neither fall back to a local write (which would then refuse, the accept
// having landed) nor report a refusal.
type daemonUnansweredError struct {
	url string
	err error
}

func (e *daemonUnansweredError) Error() string {
	return fmt.Sprintf("daemon at %s %s: %v", e.url, e.what(), e.err)
}

// what says how the answer failed to arrive.
func (e *daemonUnansweredError) what() string {
	var netErr net.Error
	if errors.As(e.err, &netErr) && netErr.Timeout() {
		return "did not answer in time"
	}
	return "dropped the connection before answering"
}

func (e *daemonUnansweredError) Unwrap() error { return e.err }

// postLifecycle hands a lifecycle action (resume, accept) on fiberID to the
// daemon, which runs `shuttle <action> --local` serialized with its
// Poller's state changes. The daemon's plain-text response is returned on
// success. A transport failure after the connection was made is a
// *daemonUnansweredError, not a transport error.
func (a *app) postLifecycle(action, fiberID string) (string, error) {
	body, err := json.Marshal(map[string]string{"action": action, "fiber": fiberID})
	if err != nil {
		return "", fmt.Errorf("encoding lifecycle request: %w", err)
	}

	endpoint, err := a.daemonEndpoint("/api/v1/lifecycle")
	if err != nil {
		return "", err
	}
	var connected atomic.Bool
	ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) { connected.Store(true) },
	})
	respBody, err := a.postDaemonContext(ctx, endpoint, body, a.daemonLifecycleTimeout)
	if err != nil {
		if connected.Load() && isLifecycleTransportError(err) {
			return "", &daemonUnansweredError{url: endpoint, err: err}
		}
		return "", err
	}
	return string(respBody), nil
}

// isLifecycleTransportError reports whether err means "daemon unreachable" (so
// the caller should fall back to a local document write) rather than a daemon
// refusal, an owner-check failure or a request the daemon received but did not
// answer, all of which must surface to the user.
func isLifecycleTransportError(err error) bool {
	if err == nil {
		return false
	}
	var ownerErr *daemonTCPOwnerCheckError
	if errors.As(err, &ownerErr) {
		return false
	}
	var unanswered *daemonUnansweredError
	if errors.As(err, &unanswered) {
		return false
	}
	if _, ok := err.(daemonStatusError); ok {
		return false
	}
	return strings.Contains(err.Error(), "reaching daemon")
}
