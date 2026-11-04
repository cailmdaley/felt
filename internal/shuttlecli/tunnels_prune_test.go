package shuttlecli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestPruneTunnels_AlreadyAbsent(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			t.Parallel()
			h := newTunnelHost(t, goos, `[]`)
			home := h.installIntoTemp(t, "")
			sup := h.app.systemdSupervisor(home)
			job := "shuttle-tunnel-orphan.service"
			sysenvtest.FakeCommand(t, h.env, "systemctl", `case "$2" in
stop) exit 1;;
show) echo not-found;;
esac
`)
			if goos == "darwin" {
				sup = h.app.launchdSupervisor(home)
				job = "io.shuttle.shuttle-tunnel-orphan.plist"
				sysenvtest.FakeCommand(t, h.env, "launchctl", `case "$1" in
bootout) exit 3;;
print) case "$2" in */*/*) exit 113;; esac;;
esac
`)
			}
			if err := os.MkdirAll(sup.JobDir, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(sup.JobDir, job)
			if err := os.WriteFile(path, []byte("ownership"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := sup.Deactivate(job, sup.JobDir); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Errorf("confirmed absent job file remains: %v", err)
			}
		})
	}
}

func TestPruneTunnels_RetainsOwnershipOnSupervisorFailure(t *testing.T) {
	for _, tc := range []struct{ name, goos, script string }{
		{"launchd-unavailable", "darwin", "exit 1\n"},
		{"systemd-unavailable", "linux", "exit 1\n"},
		{"systemd-disable-failed", "linux", "if [ \"$2\" = disable ]; then exit 1; fi\nexit 0\n"},
		{"launchd-domain-unavailable", "darwin", "case \"$2\" in */*/*) exit 113;; esac\nexit 1\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newTunnelHost(t, tc.goos, `[]`)
			home := h.installIntoTemp(t, "")
			var output bytes.Buffer
			h.env.Stdout = &output
			sup := h.app.systemdSupervisor(home)
			bin, job := "systemctl", "shuttle-tunnel-orphan.service"
			if tc.goos == "darwin" {
				sup = h.app.launchdSupervisor(home)
				bin, job = "launchctl", "io.shuttle.shuttle-tunnel-orphan.plist"
			}
			sysenvtest.FakeCommand(t, h.env, bin, tc.script)
			if err := os.MkdirAll(sup.JobDir, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(sup.JobDir, job)
			if err := os.WriteFile(path, []byte("ownership"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := h.install(nil); err == nil {
				t.Error("prune reported success after a supervisor failure")
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("ownership file lost: %v", err)
			}
			if strings.Contains(output.String(), "removed") {
				t.Error("reported removal")
			}
		})
	}
}
