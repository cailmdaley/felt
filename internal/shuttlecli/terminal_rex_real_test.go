package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Resolve the installed binary before TestMain fences HOME. Resolution performs
// no server request; every call in the test targets its private Unix socket.
var installedTestRexBin, _ = (&app{env: sysenv.OS()}).rexBin()

func TestRexTerminalRealIsolatedServer(t *testing.T) {
	if installedTestRexBin == "" {
		t.Skip("rex is not installed")
	}
	env := testEnv(t)
	// A short path fits the Unix socket limit on macOS.
	dir, err := os.MkdirTemp("/tmp", "rex-go-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	env.Set("SHUTTLE_REX_BIN", installedTestRexBin)
	env.Set("SHUTTLE_REX_SERVER", "unix://"+filepath.Join(dir, "rex.sock"))
	var log bytes.Buffer
	server := env.Command(installedTestRexBin, "server", "run", "--listen", env.Getenv("SHUTTLE_REX_SERVER"), "--state-dir", filepath.Join(dir, "state"), "--max-sessions", "8")
	server.Stdout, server.Stderr = &log, &log
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = server.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- server.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = server.Process.Kill()
			<-done
		}
	}()
	r := &rexTerminal{a: newApp(env)}
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(30 * time.Millisecond) {
		if _, err := r.command("", "whoami", "--json"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("isolated Rex not ready")
		}
	}
	name := "probe-go-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
	request, err := os.ReadFile("../../daemon/test/fixtures/rex/session_create_request.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(request, &spec); err != nil {
		t.Fatal(err)
	}
	spec["label"] = name
	window := spec["initial_windows"].([]any)[0].(map[string]any)
	window["window_label"] = name
	block := window["layout"].(map[string]any)["block"].(map[string]any)
	block["label"] = name
	options := block["options"].(map[string]any)
	options["cwd"] = dir
	options["command"] = []string{"/bin/sh", "-c", "exec sleep 120"}
	payload, _ := json.Marshal(spec)
	out, err := r.command(string(payload), "api", "call", "session.create", "-")
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		SessionID string `json:"session_id"`
		Windows   []struct {
			BlockIDs []string `json:"block_ids"`
		} `json:"initial_windows"`
	}
	if err := json.Unmarshal(out, &created); err != nil || len(created.Windows) != 1 || len(created.Windows[0].BlockIDs) != 1 {
		t.Fatalf("create %s: %v", out, err)
	}
	sid, bid := created.SessionID, created.Windows[0].BlockIDs[0]
	defer r.destroy(sid)
	path := writeRexBindings(t, env, map[string]rexBinding{name: {SessionID: sid, BlockID: bid, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}})
	before, _ := os.ReadFile(path)
	if has, err := r.Has(name); !has || err != nil {
		t.Fatalf("Has %v: %v", has, err)
	}
	if live, err := r.LiveWorkers(); !live[name] || err != nil {
		t.Fatalf("live %v: %v", live, err)
	}
	if _, err := r.command(`{"label":"human display rename"}`, "api", "call", "-s", sid, "session.set_label", "-"); err != nil {
		t.Fatal(err)
	}
	if has, err := r.Has(name); !has || err != nil {
		t.Fatalf("renamed Has %v: %v", has, err)
	}
	env.Set("REX_SESSION", sid)
	env.Set("REX_BLOCK", bid)
	ref, err := r.a.currentTerminal()
	if err != nil || ref.Name != name || ref.NativeSession != sid || ref.NativePane != bid {
		t.Fatalf("ref %+v: %v", ref, err)
	}
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	if has, err := r.Has(name); has || err != nil {
		t.Fatalf("killed Has %v: %v", has, err)
	}
	if live, err := r.LiveWorkers(); len(live) != 0 || err != nil {
		t.Fatalf("killed live %v: %v", live, err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("CLI modified daemon-owned binding index")
	}
}
