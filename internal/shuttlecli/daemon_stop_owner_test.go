package shuttlecli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDaemonStopListenerChild(t *testing.T) {
	if os.Getenv("SHUTTLE_STOP_CHILD") != "1" {
		return
	}
	network, address := "tcp", "127.0.0.1:0"
	if socket := os.Getenv("SHUTTLE_STOP_SOCKET"); socket != "" {
		network, address = "unix", socket
	}
	listener, err := net.Listen(network, address)
	if err != nil {
		os.Exit(2)
	}
	fmt.Println(listener.Addr())
	_ = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "alive") }))
	os.Exit(0)
}

func TestStopTargetsEndpointNotSiblingUsingSameRelease(t *testing.T) {
	for _, claimed := range []bool{false, true} {
		t.Run(fmt.Sprintf("claimed=%t", claimed), func(t *testing.T) {
			t.Parallel()
			if !claimed {
				if _, err := exec.LookPath("lsof"); err != nil {
					t.Skip("unclaimed listener recovery requires lsof")
				}
			}
			testStopEndpoint(t, claimed, "tcp")
		})
	}
}

func shortSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "stop-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestStopUnixEndpoint(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("unclaimed listener recovery requires lsof")
	}
	t.Run("live", func(t *testing.T) { testStopEndpoint(t, false, "unix") })
	t.Run("stale", func(t *testing.T) {
		socket := filepath.Join(t.TempDir(), "stale.sock")
		listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		listener.SetUnlinkOnClose(false)
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		env := testEnv(t)
		env.Set("SHUTTLE_LISTEN", "unix://"+socket)
		env.Set("SHUTTLE_DATA_DIR", t.TempDir())
		a := newApp(env)
		settings, err := a.resolveHostSettings()
		if err != nil {
			t.Fatal(err)
		}
		if err := a.stopDaemonEndpoint(settings, ""); err != nil {
			t.Fatal(err)
		}
	})
}

func testStopEndpoint(t *testing.T, claimed bool, network string) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	start := func() (*exec.Cmd, string) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestDaemonStopListenerChild$", "--", filepath.Join(release.Dir, "releases", "1", "start"))
		cmd.Env = append(os.Environ(), "SHUTTLE_STOP_CHILD=1")
		if network == "unix" {
			cmd.Env = append(cmd.Env, "SHUTTLE_STOP_SOCKET="+filepath.Join(shortSocketDir(t), "s"))
		}
		output, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		address, err := bufio.NewReader(output).ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return cmd, strings.TrimSpace(address)
	}
	sibling, siblingAddress := start()
	target, address := start()
	env := testEnv(t)
	env.Set("SHUTTLE_LISTEN", network+"://"+address)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	a := newApp(env)
	if claimed {
		settings, err := a.resolveHostSettings()
		if err != nil {
			t.Fatal(err)
		}
		path, err := a.daemonOwnerPath(settings)
		if err != nil {
			t.Fatal(err)
		}
		birth, err := processBirth(env, target.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(daemonOwner{PID: target.Process.Pid, Birth: birth})
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	settings, err := a.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.stopDaemonEndpoint(settings, ""); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: time.Second}
	get := func(address string) (*http.Response, error) {
		if network == "unix" {
			connection, err := net.DialTimeout("unix", address, time.Second)
			if err != nil {
				return nil, err
			}
			connection.Close()
			return &http.Response{Body: http.NoBody}, nil
		}
		return client.Get("http://" + address)
	}
	response, err := get(siblingAddress)
	if err != nil {
		t.Fatalf("stop killed sibling %d instead of target %d: %v", sibling.Process.Pid, target.Process.Pid, err)
	}
	response.Body.Close()
	response, err = get(address)
	if err == nil {
		response.Body.Close()
		t.Fatalf("target %d is still listening", target.Process.Pid)
	}
	if err := sibling.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("sibling died: %v", err)
	}
}
