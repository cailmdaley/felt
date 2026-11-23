package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testTLSServerForHost(t *testing.T, host string, handler http.Handler) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, pool
}

func startFakeLocalAPI(t *testing.T, sockPath, backendAddr string, rejectStatus int, rejectBody string) *sync.Map {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(sockPath), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	seen := &sync.Map{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(clientConn net.Conn) {
				defer clientConn.Close()
				br := bufio.NewReader(clientConn)
				req, err := http.ReadRequest(br)
				if err != nil {
					return
				}
				seen.Store("method", req.Method)
				seen.Store("path", req.URL.Path)
				seen.Store("dial_host", req.Header.Get("Dial-Host"))
				seen.Store("dial_port", req.Header.Get("Dial-Port"))
				seen.Store("sec", req.Header.Get("Sec-Tailscale"))
				if rejectStatus != 0 {
					fmt.Fprintf(clientConn, "HTTP/1.1 %d Error\r\nContent-Length: %d\r\n\r\n%s", rejectStatus, len(rejectBody), rejectBody)
					return
				}
				backend, err := net.Dial("tcp", backendAddr)
				if err != nil {
					msg := "dial failure: " + err.Error()
					fmt.Fprintf(clientConn, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: %d\r\n\r\n%s", len(msg), msg)
					return
				}
				defer backend.Close()
				fmt.Fprint(clientConn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: ts-dial\r\nConnection: Upgrade\r\n\r\n")
				done := make(chan struct{}, 2)
				go func() { io.Copy(backend, br); done <- struct{}{} }()
				go func() { io.Copy(clientConn, backend); done <- struct{}{} }()
				<-done
			}(c)
		}
	}()
	return seen
}

func TestTransportOverLocalAPISocket(t *testing.T) {
	const host = "peer.example.ts.net"
	srv, pool := testTLSServerForHost(t, host, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/v1/deploy/runs" {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "run-1", "dir": "/tmp/run-1"})
			return
		}
		http.NotFound(w, r)
	}))
	tmp := t.TempDir()
	sock := filepath.Join(tmp, "tailscaled.sock")
	seen := startFakeLocalAPI(t, sock, srv.Listener.Addr().String(), 0, "")

	remotesPath := filepath.Join(tmp, "remotes.json")
	if err := os.WriteFile(remotesPath, []byte(fmt.Sprintf(`{"defaults":{"tailscale_socket":%q},"remotes":[]}`, sock)), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "https://" + host
	tr, err := transportForBase(base, remotesPath, tmp, "linux", os.Geteuid())
	if err != nil {
		t.Fatalf("transportForBase: %v", err)
	}
	tr.TLSClientConfig = &tls.Config{RootCAs: pool}
	c := &http.Client{Timeout: 5 * time.Second, Transport: tr}
	body, err := call(c, "POST", base+"/api/v1/deploy/runs", nil, http.StatusCreated)
	if err != nil {
		t.Fatalf("call over localapi: %v", err)
	}
	if !strings.Contains(string(body), `"id":"run-1"`) {
		t.Fatalf("unexpected body: %s", body)
	}
	if got, _ := seen.Load("dial_host"); got != host {
		t.Fatalf("Dial-Host = %v, want %q", got, host)
	}
	if got, _ := seen.Load("dial_port"); got != "443" {
		t.Fatalf("Dial-Port = %v, want 443", got)
	}
	if got, _ := seen.Load("sec"); got != "localapi" {
		t.Fatalf("Sec-Tailscale = %v, want localapi", got)
	}
}

func TestLocalAPINon101ReturnsClearError(t *testing.T) {
	tmp := t.TempDir()
	sock := filepath.Join(tmp, "tailscaled.sock")
	startFakeLocalAPI(t, sock, "", 502, "peer offline")

	remotesPath := filepath.Join(tmp, "remotes.json")
	if err := os.WriteFile(remotesPath, []byte(fmt.Sprintf(`{"defaults":{"tailscale_socket":%q}}`, sock)), 0o600); err != nil {
		t.Fatal(err)
	}
	tr, err := transportForBase("https://peer.example.ts.net", remotesPath, tmp, "linux", os.Geteuid())
	if err != nil {
		t.Fatal(err)
	}
	c := &http.Client{Timeout: 5 * time.Second, Transport: tr}
	_, err = call(c, "POST", "https://peer.example.ts.net/api/v1/deploy/runs", nil, http.StatusCreated)
	if err == nil || !strings.Contains(err.Error(), "HTTP 502: peer offline") {
		t.Fatalf("got err = %v, want HTTP 502: peer offline", err)
	}
}

func TestResolveDialSettings(t *testing.T) {
	tmp := t.TempDir()
	if err := os.Chmod(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	// Default private socket on Linux is accepted when ancestry is 0700 owned by euid.
	sockDir := filepath.Join(tmp, ".local", "state", "tailscale")
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(tmp, ".local"), filepath.Join(tmp, ".local", "state"), sockDir} {
		if err := os.Chmod(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	defaultSock := filepath.Join(sockDir, "tailscaled.sock")
	ln, err := net.Listen("unix", defaultSock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	sock, proxy, warn, err := resolveDialSettings(filepath.Join(tmp, "missing.json"), tmp, "linux", os.Geteuid())
	if err != nil || warn != "" || proxy != nil || sock != defaultSock {
		t.Fatalf("default linux socket: sock=%q proxy=%v warn=%q err=%v", sock, proxy, warn, err)
	}

	// "system" disables the default socket.
	sysFile := filepath.Join(tmp, "sys.json")
	if err := os.WriteFile(sysFile, []byte(`{"defaults":{"tailscale_socket":"system"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sock, _, _, err = resolveDialSettings(sysFile, tmp, "linux", os.Geteuid())
	if err != nil || sock != "" {
		t.Fatalf("system override: sock=%q err=%v", sock, err)
	}

	// Non-Linux skips default socket silently.
	sock, _, warn, err = resolveDialSettings(filepath.Join(tmp, "missing.json"), tmp, "darwin", os.Geteuid())
	if err != nil || sock != "" || warn != "" {
		t.Fatalf("darwin default: sock=%q warn=%q err=%v", sock, warn, err)
	}

	// Mutual exclusion with https_proxy.
	bothFile := filepath.Join(tmp, "both.json")
	if err := os.WriteFile(bothFile, []byte(`{"defaults":{"tailscale_socket":"/tmp/a.sock","https_proxy":"127.0.0.1:1055"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := resolveDialSettings(bothFile, tmp, "linux", os.Geteuid()); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("expected mutual exclusion error, got %v", err)
	}

	// https:// proxy scheme normalizes to plain http CONNECT proxy; +1055 is rejected.
	proxyFile := filepath.Join(tmp, "proxy.json")
	if err := os.WriteFile(proxyFile, []byte(`{"defaults":{"https_proxy":"https://user:pw@localhost:1055"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sock, proxy, warn, err = resolveDialSettings(proxyFile, tmp, "linux", os.Geteuid())
	if err != nil || sock != "" || warn != "" || proxy == nil || proxy.String() != "http://localhost:1055" {
		t.Fatalf("https proxy: sock=%q proxy=%v warn=%q err=%v", sock, proxy, warn, err)
	}
	badPortFile := filepath.Join(tmp, "badport.json")
	if err := os.WriteFile(badPortFile, []byte(`{"defaults":{"https_proxy":"localhost:+1055"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := resolveDialSettings(badPortFile, tmp, "linux", os.Geteuid()); err == nil {
		t.Fatal("expected +1055 proxy port to be rejected")
	}

	// Malformed remotes.json fails closed.
	badJSON := filepath.Join(tmp, "bad.json")
	if err := os.WriteFile(badJSON, []byte(`{not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := resolveDialSettings(badJSON, tmp, "linux", os.Geteuid()); err == nil {
		t.Fatal("expected malformed remotes.json to fail")
	}

	// http:// base ignores remotes.json dial settings.
	if _, err := transportForBase("http://127.0.0.1:4000", badJSON, tmp, "linux", os.Geteuid()); err != nil {
		t.Fatalf("http base should ignore remotes.json: %v", err)
	}

	// Group-writable directory refuses default socket.
	if err := os.Chmod(sockDir, 0o770); err != nil {
		t.Fatal(err)
	}
	sock, _, warn, err = resolveDialSettings(filepath.Join(tmp, "missing.json"), tmp, "linux", os.Geteuid())
	if err != nil || sock != "" || !strings.Contains(warn, "refused") {
		t.Fatalf("group-writable parent: sock=%q warn=%q err=%v", sock, warn, err)
	}
	if err := os.Chmod(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Symlink in ancestry refuses default socket.
	symHome := t.TempDir()
	if err := os.Chmod(symHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(symHome, ".local", "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(symHome, ".local"), filepath.Join(symHome, ".local", "state")} {
		if err := os.Chmod(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(sockDir, filepath.Join(symHome, ".local", "state", "tailscale")); err != nil {
		t.Fatal(err)
	}
	sock, _, warn, err = resolveDialSettings(filepath.Join(symHome, "missing.json"), symHome, "linux", os.Geteuid())
	if err != nil || sock != "" || !strings.Contains(warn, "symlink") {
		t.Fatalf("symlink ancestry: sock=%q warn=%q err=%v", sock, warn, err)
	}
}

func TestDialLocalAPIPreservesBufferedBytesAfter101(t *testing.T) {
	tmp := t.TempDir()
	sock := filepath.Join(tmp, "buf.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = http.ReadRequest(bufio.NewReader(c))
		// Write 101 headers and upgraded payload in one write so bufio.Reader buffers both.
		_, _ = io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: ts-dial\r\nConnection: upgrade\r\n\r\nhello-tunnel")
	}()
	conn, err := dialLocalAPI(t.Context(), sock, "peer.example.ts.net:443")
	if err != nil {
		t.Fatalf("dialLocalAPI: %v", err)
	}
	defer conn.Close()
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read upgraded conn: %v", err)
	}
	if string(got) != "hello-tunnel" {
		t.Fatalf("got %q, want %q", got, "hello-tunnel")
	}
}
