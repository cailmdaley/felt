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
	listener, err := net.Listen("tcp", "127.0.0.1:0")
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
			testStopEndpoint(t, claimed)
		})
	}
}

func testStopEndpoint(t *testing.T, claimed bool) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	start := func() (*exec.Cmd, string) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestDaemonStopListenerChild$", "--", filepath.Join(release.Dir, "releases", "1", "start"))
		cmd.Env = append(os.Environ(), "SHUTTLE_STOP_CHILD=1")
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
	env.Set("SHUTTLE_LISTEN", "tcp://"+address)
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
	response, err := client.Get("http://" + siblingAddress)
	if err != nil {
		t.Fatalf("stop killed sibling %d instead of target %d: %v", sibling.Process.Pid, target.Process.Pid, err)
	}
	response.Body.Close()
	response, err = client.Get("http://" + address)
	if err == nil {
		response.Body.Close()
		t.Fatalf("target %d is still listening", target.Process.Pid)
	}
	if err := sibling.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("sibling died: %v", err)
	}
}
