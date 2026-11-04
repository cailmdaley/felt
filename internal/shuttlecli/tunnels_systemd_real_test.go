//go:build linux

package shuttlecli

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// This opt-in probe starts a private bus and user manager. It needs a container
// with systemd, dbus and /run/systemd/system, not the operator's user manager.
func TestPruneTunnels_RealPrivateSystemd(t *testing.T) {
	h := newTunnelHost(t, "linux", `[]`)
	if h.env.Getenv("SHUTTLE_TEST_PRIVATE_SYSTEMD") != "1" {
		t.Skip("requires an isolated systemd container")
	}
	home := h.installIntoTemp(t, "")
	runtime := t.TempDir()
	h.env.Set("XDG_RUNTIME_DIR", runtime)
	h.env.Set("DBUS_SESSION_BUS_ADDRESS", "unix:path="+filepath.Join(runtime, "bus"))
	sup := h.app.systemdSupervisor(home)
	if err := os.MkdirAll(sup.JobDir, 0755); err != nil {
		t.Fatal(err)
	}
	h.env.Set("SYSTEMD_UNIT_PATH", sup.JobDir+":/usr/lib/systemd/user:/lib/systemd/user")
	bus := h.env.Command("dbus-daemon", "--session", "--nofork", "--address="+h.env.Getenv("DBUS_SESSION_BUS_ADDRESS"))
	if err := bus.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bus.Process.Kill(); _ = bus.Wait() })
	wait := func(ready func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !ready() {
			if time.Now().After(deadline) {
				t.Fatal("private supervisor did not become ready")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	wait(func() bool { _, err := os.Stat(filepath.Join(runtime, "bus")); return err == nil })
	manager := h.env.Command("/lib/systemd/systemd", "--user")
	if err := manager.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Process.Kill(); _ = manager.Wait() })
	wait(func() bool { return h.env.Command("systemctl", "--user", "show-environment").Run() == nil })
	job := "shuttle-tunnel-private-test.service"
	path := filepath.Join(sup.JobDir, job)
	if err := os.WriteFile(path, []byte("[Unit]\nDescription=Private prune probe\n[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=default.target\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", "--now", job}} {
		if err := h.app.runSupervisor("systemctl", append([]string{"--user"}, args...)...); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.env.Command("systemctl", "--user", "is-active", "--quiet", job).Run(); err != nil {
		t.Fatal(err)
	}
	goodBus := h.env.Getenv("DBUS_SESSION_BUS_ADDRESS")
	h.env.Set("DBUS_SESSION_BUS_ADDRESS", "unix:path="+filepath.Join(runtime, "unreachable"))
	h.env.Set("XDG_RUNTIME_DIR", filepath.Join(runtime, "unreachable-runtime"))
	if err := sup.Deactivate(job, sup.JobDir); err == nil {
		t.Error("unavailable manager reported success")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lost retry evidence: %v", err)
	}
	h.env.Set("DBUS_SESSION_BUS_ADDRESS", goodBus)
	h.env.Set("XDG_RUNTIME_DIR", runtime)
	if err := h.env.Command("systemctl", "--user", "is-active", "--quiet", job).Run(); err != nil {
		t.Fatal("failed prune stopped the private job unexpectedly")
	}
	if err := sup.Deactivate(job, sup.JobDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file remains after successful prune: %v", err)
	}
	if err := h.env.Command("systemctl", "--user", "is-active", "--quiet", job).Run(); err == nil {
		t.Fatal("job remains active")
	}
	if err := sup.Deactivate(job, sup.JobDir); err != nil {
		t.Fatalf("already absent job is not idempotent: %v", err)
	}
	_ = h.env.Command("systemctl", "--user", "exit").Run()
}
