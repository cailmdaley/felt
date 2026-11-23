package shuttlecli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakeRunDaemon serves the daemon's deploy-run routes from directories under
// root, running each launch script the way the daemon does: `bash launch` in
// the run directory, output to out, exit status to status. For `down` after
// the fleet's first daemon cycle it answers 503, as a daemon replacing itself
// is briefly unreachable.
func fakeRunDaemon(t *testing.T, root string, env []string, events string, down time.Duration) *httptest.Server {
	var mu sync.Mutex
	runs, cycled := 0, time.Time{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if cycled.IsZero() && strings.Contains(fleetRead(events), "cycle\n") {
			cycled = time.Now()
		}
		unavailable := !cycled.IsZero() && time.Since(cycled) < down
		mu.Unlock()
		if unavailable {
			http.Error(w, "booting", http.StatusServiceUnavailable)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/deploy/runs"), "/")
		if r.Method == "POST" && r.URL.Path == "/api/v1/deploy/runs" {
			mu.Lock()
			runs++
			id := fmt.Sprintf("%024d", runs)
			mu.Unlock()
			dir := filepath.Join(root, id)
			os.MkdirAll(dir, 0700)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": id, "dir": dir})
			return
		}
		if len(parts) < 2 {
			http.NotFound(w, r)
			return
		}
		dir := filepath.Join(root, parts[1])
		if _, err := os.Stat(dir); err != nil {
			http.Error(w, "no deploy run", http.StatusNotFound)
			return
		}
		switch {
		case r.Method == "PUT" && len(parts) == 4 && parts[2] == "files":
			data, _ := io.ReadAll(r.Body)
			os.WriteFile(filepath.Join(dir, parts[3]), data, 0600)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == "POST" && len(parts) == 3 && parts[2] == "start":
			data, _ := io.ReadAll(r.Body)
			os.WriteFile(filepath.Join(dir, "launch"), data, 0600)
			out, _ := os.Create(filepath.Join(dir, "out"))
			cmd := exec.Command("bash", "launch")
			cmd.Dir, cmd.Env, cmd.Stdout, cmd.Stderr = dir, env, out, out
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := cmd.Start(); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			go func() {
				code := 0
				if err := cmd.Wait(); err != nil {
					code = cmd.ProcessState.ExitCode()
				}
				out.Close()
				os.WriteFile(filepath.Join(dir, "status.tmp"), []byte(strconv.Itoa(code)), 0600)
				os.Rename(filepath.Join(dir, "status.tmp"), filepath.Join(dir, "status"))
			}()
			w.WriteHeader(http.StatusAccepted)
		case r.Method == "GET" && len(parts) == 3 && parts[2] == "output":
			os.WriteFile(filepath.Join(dir, "beat"), []byte(time.Now().String()), 0600)
			status, statusErr := os.ReadFile(filepath.Join(dir, "status"))
			data, _ := os.ReadFile(filepath.Join(dir, "out"))
			offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
			if offset > len(data) {
				offset = len(data)
			}
			if statusErr == nil {
				w.Header().Set("x-deploy-status", strings.TrimSpace(string(status)))
			}
			w.Write(data[offset:])
		case r.Method == "POST" && len(parts) == 3 && parts[2] == "cancel":
			os.WriteFile(filepath.Join(dir, "cancel"), nil, 0600)
			os.WriteFile(filepath.Join(root, "cancelled"), nil, 0600)
			w.WriteHeader(http.StatusAccepted)
		case r.Method == "DELETE" && len(parts) == 2:
			if _, err := os.Stat(filepath.Join(dir, "status")); err != nil {
				http.Error(w, "still running", http.StatusConflict)
				return
			}
			os.RemoveAll(dir)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newTailnetFleet is a fleet whose one remote has a url served by a
// fakeRunDaemon, at a target that carries the deploy-run routes.
func newTailnetFleet(t *testing.T, down time.Duration) (*deployFleet, string) {
	f := newDeployFleet(t)
	controller := filepath.Join(f.repo, "daemon/lib/shuttle_web/controllers/deploy_run_controller.ex")
	os.MkdirAll(filepath.Dir(controller), 0700)
	if err := os.WriteFile(controller, []byte("# routes\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "add", ".")
	f.git(t, f.repo, "commit", "-m", "routes")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	env := append(append([]string{}, f.env...), "TEST_REMOTE=1", "SHUTTLE_TEST_GO_CACHES_PINNED=1", "GOTOOLCHAIN=local")
	runs := filepath.Join(f.root, "runs")
	srv := fakeRunDaemon(t, runs, env, f.events, down)
	fleet := fmt.Sprintf(`{"remotes":[{"name":"fake","ssh":"fake","url":%q,"checkout":%q,"build_ui":false}]}`, srv.URL+"/", f.remote)
	if err := os.WriteFile(filepath.Join(f.root, "remotes.json"), []byte(fleet), 0600); err != nil {
		t.Fatal(err)
	}
	return f, runs
}

// A remote with a url deploys through its daemon's deploy-run routes: no ssh
// connection is opened, the stage (here the shipped UI) arrives as one tar,
// and the transaction keeps going while its daemon is unreachable across the
// cycle it causes.
func TestDeployTailnetTransport(t *testing.T) {
	t.Parallel()
	// The outage outlasts the transaction's 60-second ssh heartbeat lease
	// scaled down here to 2s, and stays inside the tailnet lease.
	f, _ := newTailnetFleet(t, 4*time.Second)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "tailnet", "SHUTTLE_DEPLOY_HEARTBEAT_LEASE_SECONDS=2", "SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS=30")
	if err := f.deployWait(t, cmd); err != nil {
		t.Fatalf("deploy: %v %s", err, fleetRead(log))
	}
	out, events := fleetRead(log), fleetRead(f.events)
	if strings.Contains(events, "ssh\n") || strings.Contains(events, "rsync ") {
		t.Fatalf("a tailnet remote used ssh: %s", events)
	}
	for _, want := range []string{"over the tailnet", "answering again after"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q: %s", want, out)
		}
	}
	if !strings.Contains(events, "build "+f.sha+" build SKIP_UI=1") || strings.Count(events, "cycle\n") != 1 {
		t.Fatalf("remote did not build and cycle once: %s", events)
	}
	if got := fleetRead(filepath.Join(f.remote+".deploy", f.sha, "ui", "dist", "index.html")); strings.TrimSpace(got) != "bundle" {
		t.Fatalf("staged bundle not published: %q", got)
	}
	if !f.lockFree(t) {
		t.Fatal("finished tailnet deploy retained the host lock")
	}
}

// A deployer that goes away mid-build cancels its tailnet run at once: the
// relay asks the daemon to cancel, the launch script closes deploy-run's
// stdin, and the host lock comes free without waiting out the tailnet lease.
func TestDeployTailnetCancelsWithItsDeployer(t *testing.T) {
	t.Parallel()
	f, runs := newTailnetFleet(t, 0)
	cmd, log := f.start(t, "tailnet-cancel", "SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS=600")
	deployAwait(t, "build: "+log, func() bool { _, err := os.Stat(filepath.Join(f.root, "build-entered")); return err == nil })
	syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	f.deployWait(t, cmd)
	deployAwait(t, "cancel: "+log, func() bool { _, err := os.Stat(filepath.Join(runs, "cancelled")); return err == nil })
	deployAwait(t, "lock free: "+log, func() bool { return f.lockFree(t) })
	if strings.Contains(fleetRead(f.events), "cycle\n") {
		t.Fatalf("cancelled deploy cycled the daemon: %s", fleetRead(f.events))
	}
}

// A tailnet deploy against an https:// remote whose host does not resolve in
// OS DNS dials through defaults.tailscale_socket via LocalAPI /localapi/v0/dial
// rather than failing on host DNS lookup.
func TestDeployTailnetDialsLocalAPISocket(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	controller := filepath.Join(f.repo, "daemon/lib/shuttle_web/controllers/deploy_run_controller.ex")
	os.MkdirAll(filepath.Dir(controller), 0o700)
	if err := os.WriteFile(controller, []byte("# routes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "add", ".")
	f.git(t, f.repo, "commit", "-m", "routes")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	sock := filepath.Join(t.TempDir(), "tailscaled.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var gotHost, gotPort string
	var mu sync.Mutex
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				req, err := http.ReadRequest(bufio.NewReader(conn))
				if err != nil {
					return
				}
				mu.Lock()
				gotHost = req.Header.Get("Dial-Host")
				gotPort = req.Header.Get("Dial-Port")
				mu.Unlock()
				msg := "simulated peer unreachable"
				fmt.Fprintf(conn, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: %d\r\n\r\n%s", len(msg), msg)
			}(c)
		}
	}()
	fleet := fmt.Sprintf(`{"defaults":{"tailscale_socket":%q},"remotes":[{"name":"fake","ssh":"fake","url":"https://fake.tailnet.invalid","checkout":%q,"build_ui":false}]}`, sock, f.remote)
	if err := os.WriteFile(filepath.Join(f.root, "remotes.json"), []byte(fleet), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd, log := f.start(t, "tailnet-localapi")
	if err := f.deployWait(t, cmd); err == nil {
		t.Fatalf("expected failure from 502 fake localapi, got nil: %s", fleetRead(log))
	}
	out := fleetRead(log)
	if !strings.Contains(out, "HTTP 502: simulated peer unreachable") {
		t.Fatalf("expected LocalAPI 502 in log, got:\n%s", out)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotHost != "fake.tailnet.invalid" || gotPort != "443" {
		t.Fatalf("LocalAPI saw Dial-Host=%q Dial-Port=%q, want fake.tailnet.invalid:443", gotHost, gotPort)
	}
}
