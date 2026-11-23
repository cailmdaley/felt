// deploy-relay carries a deploy transaction to a remote daemon's deploy-run
// routes over HTTP, in place of ssh. As the transport under deploy-lock
// --observe it behaves like the ssh command it replaces: the framed bootstrap
// arrives on stdin, heartbeats follow it, the remote output streams to stdout,
// and the exit status is the remote script's.
//
//	deploy-relay create URL                    prints "<id>\t<dir>"
//	deploy-relay put URL RUN NAME FILE         uploads FILE as <dir>/NAME
//	deploy-relay run URL RUN LAUNCH [--attached]
//
// run starts LAUNCH and polls the run's output once a second; each poll is
// the heartbeat the remote script checks. With --attached, stdin first holds
// a length-framed bootstrap, stored as <dir>/bootstrap before the start, and
// its EOF means the observer is gone. Then, and on TERM, INT or HUP, the relay
// asks the daemon to cancel the run; after EOF it reads on until the run exits
// or the host has been unreachable for 15 seconds. Polls fail while the daemon
// restarts itself mid-run; the relay retries until the host has been
// unreachable for the tailnet lease, SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS (300
// by default), after which the run, hearing no polls, cancels itself. A run
// without --attached is a short probe and is given ten minutes.
//
// For https:// targets, the relay honors the same Tailscale dial settings as
// the daemon and shuttle CLI: defaults.tailscale_socket or defaults.https_proxy
// in remotes.json (SHUTTLE_REMOTES_FILE), or on Linux the private default
// $HOME/.local/state/tailscale/tailscaled.sock when its ancestry is owned by
// the current user and not group- or world-writable.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	systemTailscaleSocket      = "system"
	defaultTailscaleSocketPath = ".local/state/tailscale/tailscaled.sock"
)

var (
	// A poll that hangs counts as a failed one; an upload of a release is slow.
	client   = &http.Client{Timeout: 10 * time.Second}
	uploader = &http.Client{Timeout: 30 * time.Minute}

	remoteSocketPattern = regexp.MustCompile(`^/[A-Za-z0-9._/@+-]+$`)
)

type remotesDefaults struct {
	HTTPSProxy      string `json:"https_proxy"`
	TailscaleSocket string `json:"tailscale_socket"`
}

type remotesDoc struct {
	Defaults *remotesDefaults `json:"defaults"`
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

func validateSocketPath(path string) error {
	if !remoteSocketPattern.MatchString(path) {
		return fmt.Errorf("must be an absolute path of letters, digits and . _ / @ + - only")
	}
	if filepath.Clean(path) != path {
		return fmt.Errorf("must be a clean path (no '..', '.', '//' or trailing '/')")
	}
	return nil
}

func parseHTTPSProxy(raw string) (*url.URL, error) {
	rest := strings.TrimSpace(raw)
	if rest == "" {
		return nil, nil
	}
	if i := strings.Index(rest, "://"); i >= 0 {
		s := strings.ToLower(rest[:i])
		if s != "http" && s != "https" {
			return nil, fmt.Errorf("scheme %q is not http or https", rest[:i])
		}
		rest = rest[i+len("://"):]
	}
	if strings.ContainsAny(rest, "/?#") {
		return nil, fmt.Errorf("a proxy address has no path, query, or fragment")
	}
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}
	host, portText, err := net.SplitHostPort(rest)
	if err != nil {
		return nil, fmt.Errorf("want host:port with the port written out")
	}
	if host == "" {
		return nil, fmt.Errorf("no host")
	}
	if portText == "" || strings.TrimLeft(portText, "0123456789") != "" {
		return nil, fmt.Errorf("port %q must be in 1..65535", portText)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("port %q must be in 1..65535", portText)
	}
	return &url.URL{Scheme: "http", Host: net.JoinHostPort(host, strconv.Itoa(port))}, nil
}

func unsafeDirReason(info os.FileInfo, euid int) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if ok && int(st.Uid) != euid && st.Uid != 0 {
		return fmt.Sprintf("owned by uid %d", st.Uid)
	}
	mode := info.Mode()
	if mode.Perm()&0o022 != 0 && mode&os.ModeSticky == 0 {
		return fmt.Sprintf("mode %04o is group- or other-writable without the sticky bit", mode.Perm())
	}
	return ""
}

func literalSocketProblem(path, top string, euid int) string {
	rel, err := filepath.Rel(top, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return fmt.Sprintf("%s is not under %s", path, top)
	}
	info, err := os.Stat(top)
	if err != nil {
		return fmt.Sprintf("%s: %v", top, err)
	}
	if !info.IsDir() {
		return top + ": not a directory"
	}
	if reason := unsafeDirReason(info, euid); reason != "" {
		return fmt.Sprintf("%s: %s", top, reason)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	current := top
	for i, name := range parts {
		current = filepath.Join(current, name)
		info, err := os.Lstat(current)
		switch {
		case err != nil:
			return fmt.Sprintf("%s: %v", current, err)
		case info.Mode()&os.ModeSymlink != 0:
			return current + " is a symlink"
		case i < len(parts)-1:
			if !info.IsDir() {
				return current + ": not a directory"
			}
			if reason := unsafeDirReason(info, euid); reason != "" {
				return fmt.Sprintf("%s: %s", current, reason)
			}
		case info.Mode()&os.ModeSocket == 0:
			return current + ": not a Unix socket"
		default:
			if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != euid {
				return fmt.Sprintf("%s: owned by uid %d, not this uid %d", current, st.Uid, euid)
			}
		}
	}
	return ""
}

func readRemotesDefaults(path string) (remotesDefaults, error) {
	if path == "" {
		return remotesDefaults{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return remotesDefaults{}, nil
		}
		return remotesDefaults{}, err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] == '[' {
		var list []json.RawMessage
		if len(trimmed) > 0 {
			if err := json.Unmarshal(trimmed, &list); err != nil {
				return remotesDefaults{}, fmt.Errorf("%s: %w", path, err)
			}
		}
		return remotesDefaults{}, nil
	}
	var doc remotesDoc
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return remotesDefaults{}, fmt.Errorf("%s: %w", path, err)
	}
	if doc.Defaults == nil {
		return remotesDefaults{}, nil
	}
	return *doc.Defaults, nil
}

func resolveDialSettings(remotesFile, home, goos string, euid int) (socketPath string, proxyURL *url.URL, warning string, err error) {
	if remotesFile == "" && home != "" {
		remotesFile = filepath.Join(home, ".config", "shuttle", "remotes.json")
	}
	defaults, err := readRemotesDefaults(remotesFile)
	if err != nil {
		return "", nil, "", err
	}
	proxyURL, err = parseHTTPSProxy(defaults.HTTPSProxy)
	if err != nil {
		return "", nil, "", fmt.Errorf("defaults.https_proxy %q: %w", strings.TrimSpace(defaults.HTTPSProxy), err)
	}
	rawSock := strings.TrimSpace(defaults.TailscaleSocket)
	switch rawSock {
	case systemTailscaleSocket:
		return "", proxyURL, "", nil
	case "":
		if proxyURL != nil {
			return "", proxyURL, "", nil
		}
		if goos != "linux" || !filepath.IsAbs(home) {
			return "", nil, "", nil
		}
		candidate := filepath.Join(home, defaultTailscaleSocketPath)
		if validateSocketPath(candidate) != nil {
			return "", nil, "", nil
		}
		if _, err := os.Lstat(candidate); err != nil {
			return "", nil, "", nil
		}
		if reason := literalSocketProblem(candidate, home, euid); reason != "" {
			return "", nil, fmt.Sprintf("default tailscale LocalAPI socket %s refused: %s", candidate, reason), nil
		}
		return candidate, nil, "", nil
	default:
		if err := validateSocketPath(rawSock); err != nil {
			return "", nil, "", fmt.Errorf("defaults.tailscale_socket %q: %w", rawSock, err)
		}
		if proxyURL != nil {
			return "", nil, "", errors.New("defaults.https_proxy and defaults.tailscale_socket are mutually exclusive")
		}
		return rawSock, nil, "", nil
	}
}

func headerHasToken(values []string, want string) bool {
	for _, v := range values {
		for _, tok := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), want) {
				return true
			}
		}
	}
	return false
}

func dialLocalAPI(ctx context.Context, socketPath, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(host, "\r\n") || strings.ContainsAny(port, "\r\n") {
		return nil, fmt.Errorf("invalid dial target %q", addr)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("localapi connect %s: %w", socketPath, err)
	}
	if deadline, ok := dialCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(dialCtx, func() {
		_ = conn.SetDeadline(time.Now())
	})
	defer stop()

	reqText := fmt.Sprintf(
		"POST /localapi/v0/dial HTTP/1.1\r\n"+
			"Host: local-tailscaled.sock\r\n"+
			"Upgrade: ts-dial\r\n"+
			"Connection: upgrade\r\n"+
			"Dial-Host: %s\r\n"+
			"Dial-Port: %s\r\n"+
			"Sec-Tailscale: localapi\r\n"+
			"Content-Length: 0\r\n\r\n",
		host, port,
	)
	if _, err := io.WriteString(conn, reqText); err != nil {
		conn.Close()
		return nil, fmt.Errorf("localapi write: %w", err)
	}
	br := bufio.NewReader(conn)
	dummyReq, _ := http.NewRequest("POST", "http://local-tailscaled.sock/localapi/v0/dial", nil)
	resp, err := http.ReadResponse(br, dummyReq)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("localapi read response: %w", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols ||
		!headerHasToken(resp.Header.Values("Upgrade"), "ts-dial") ||
		!headerHasToken(resp.Header.Values("Connection"), "upgrade") {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		conn.Close()
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = resp.Status
		}
		return nil, fmt.Errorf("localapi dial %s: HTTP %d: %s", addr, resp.StatusCode, detail)
	}
	if !stop() && dialCtx.Err() != nil {
		conn.Close()
		return nil, dialCtx.Err()
	}
	_ = conn.SetDeadline(time.Time{})
	if br.Buffered() > 0 {
		return &bufferedConn{Conn: conn, r: br}, nil
	}
	return conn, nil
}

func transportForBase(base, remotesFile, home, goos string, euid int) (*http.Transport, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if !strings.EqualFold(u.Scheme, "https") {
		return tr, nil
	}
	sock, proxyURL, warning, err := resolveDialSettings(remotesFile, home, goos, euid)
	if err != nil {
		return nil, err
	}
	if warning != "" {
		fmt.Fprintln(os.Stderr, "deploy-relay: warning:", warning)
	}
	tr.Proxy = nil
	if sock != "" {
		tr.DialContext = func(ctx context.Context, _, addr string) (net.Conn, error) {
			return dialLocalAPI(ctx, sock, addr)
		}
	} else if proxyURL != nil {
		tr.Proxy = http.ProxyURL(proxyURL)
	}
	return tr, nil
}

func initClients(base string) error {
	tr, err := transportForBase(base, os.Getenv("SHUTTLE_REMOTES_FILE"), os.Getenv("HOME"), runtime.GOOS, os.Geteuid())
	if err != nil {
		return err
	}
	client = &http.Client{Timeout: 10 * time.Second, Transport: tr}
	uploader = &http.Client{Timeout: 30 * time.Minute, Transport: tr}
	return nil
}

// call makes one request and fails unless its status is one of ok.
func call(c *http.Client, method, url string, body io.Reader, ok ...int) ([]byte, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	for _, code := range ok {
		if resp.StatusCode == code {
			return data, nil
		}
	}
	if resp.StatusCode == http.StatusNotFound && !bytes.Contains(data, []byte("deploy run")) {
		return nil, fmt.Errorf("%s answered 404: its daemon predates deploys over the tailnet", resp.Request.URL.Host)
	}
	return nil, fmt.Errorf("%s %s: HTTP %d: %s", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode, strings.TrimSpace(string(data)))
}

func create(base string) error {
	body, err := call(client, "POST", base+"/api/v1/deploy/runs", nil, http.StatusCreated)
	if err != nil {
		return err
	}
	var run struct{ ID, Dir string }
	if err = json.Unmarshal(body, &run); err != nil || run.ID == "" || run.Dir == "" {
		return fmt.Errorf("unexpected create response: %s", body)
	}
	fmt.Printf("%s\t%s\n", run.ID, run.Dir)
	return nil
}

func put(base, run, name string, body io.Reader) error {
	_, err := call(uploader, "PUT", base+"/api/v1/deploy/runs/"+run+"/files/"+name, body, http.StatusNoContent)
	return err
}

func lease() time.Duration {
	if n, err := strconv.Atoi(os.Getenv("SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS")); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 5 * time.Minute
}

func run(base, id, launch string, attached bool) (int, error) {
	runURL := base + "/api/v1/deploy/runs/" + id
	var closed atomic.Bool
	if attached {
		in := bufio.NewReader(os.Stdin)
		line, err := in.ReadString('\n')
		if err != nil {
			return 1, fmt.Errorf("bootstrap frame: %w", err)
		}
		size, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || size < 0 {
			return 1, fmt.Errorf("invalid bootstrap frame %q", line)
		}
		frame := make([]byte, size)
		if _, err = io.ReadFull(in, frame); err != nil {
			return 1, fmt.Errorf("bootstrap frame: %w", err)
		}
		if err = put(base, id, "bootstrap", io.MultiReader(strings.NewReader(line), bytes.NewReader(frame))); err != nil {
			return 1, err
		}
		go func() {
			io.Copy(io.Discard, in)
			closed.Store(true)
		}()
	}
	script, err := os.Open(launch)
	if err != nil {
		return 1, err
	}
	defer script.Close()
	cancel := func() error {
		_, err := call(client, "POST", runURL+"/cancel", nil, http.StatusAccepted)
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	if _, err = call(client, "POST", runURL+"/start", script, http.StatusAccepted); err != nil {
		return 1, err
	}
	go func() {
		<-signals
		cancel()
		os.Exit(143)
	}()

	started, offset, asked := time.Now(), 0, false
	var lost time.Time
	for {
		if closed.Load() && !asked {
			asked = cancel() == nil
		}
		if !attached && time.Since(started) > 10*time.Minute {
			cancel()
			return 1, errors.New("the probe did not finish in ten minutes")
		}
		resp, err := client.Get(runURL + "/output?offset=" + strconv.Itoa(offset))
		var chunk []byte
		if err == nil && resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			return 1, errors.New("the deploy run disappeared from its host")
		}
		if err == nil && resp.StatusCode == http.StatusOK {
			chunk, err = io.ReadAll(resp.Body)
			resp.Body.Close()
		} else if err == nil {
			resp.Body.Close()
			err = fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if err != nil {
			if lost.IsZero() {
				lost = time.Now()
				fmt.Fprintf(os.Stderr, "deploy-relay: %s unreachable (%v); retrying\n", base, err)
			} else if closed.Load() && time.Since(lost) > 15*time.Second || time.Since(lost) > lease() {
				return 1, fmt.Errorf("%s unreachable since %s; the run cancels itself without polls", base, lost.Format(time.TimeOnly))
			}
			time.Sleep(time.Second)
			continue
		}
		if !lost.IsZero() {
			fmt.Fprintf(os.Stderr, "deploy-relay: %s answering again after %s\n", base, time.Since(lost).Round(time.Second))
			lost = time.Time{}
		}
		if _, err = os.Stdout.Write(chunk); err != nil {
			return 1, err
		}
		offset += len(chunk)
		if status := resp.Header.Get("x-deploy-status"); status != "" {
			code, err := strconv.Atoi(status)
			if err != nil {
				return 1, fmt.Errorf("invalid exit status %q", status)
			}
			call(client, "DELETE", runURL, nil, http.StatusNoContent)
			return code, nil
		}
		if len(chunk) == 0 {
			time.Sleep(time.Second)
		}
	}
}

func main() {
	args := os.Args[1:]
	var err error
	code := 0
	switch {
	case len(args) == 2 && args[0] == "create":
		if err = initClients(args[1]); err == nil {
			err = create(args[1])
		}
	case len(args) == 5 && args[0] == "put":
		if err = initClients(args[1]); err == nil {
			var file *os.File
			if file, err = os.Open(args[4]); err == nil {
				err = put(args[1], args[2], args[3], file)
				file.Close()
			}
		}
	case (len(args) == 4 || len(args) == 5 && args[4] == "--attached") && args[0] == "run":
		if err = initClients(args[1]); err == nil {
			code, err = run(args[1], args[2], args[3], len(args) == 5)
		}
	default:
		err = errors.New("usage: deploy-relay create URL | put URL RUN NAME FILE | run URL RUN LAUNCH [--attached]")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "deploy-relay:", err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}
