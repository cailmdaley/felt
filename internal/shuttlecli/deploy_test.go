package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestShuttleDeployWaitsForFreshReadyVersion(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	wait := shellFunction(t, string(script), "wait_for_sha")
	callsFile := filepath.Join(t.TempDir(), "version-calls")

	harness := `TARGET_SHA=abc123
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=2
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
CALLS_FILE='` + callsFile + `'
version_json() {
  calls=$(cat "$CALLS_FILE" 2>/dev/null || printf '0')
  calls=$((calls + 1))
  printf '%s' "$calls" > "$CALLS_FILE"
  if [ "$calls" -eq 1 ]; then
    printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":false}'
  else
    printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":true}'
  fi
}
sleep() { :; }
` + shellFunction(t, string(script), "version_ready") + wait + `
wait_for_sha ""
printf 'polls=%s\n' "$(cat "$CALLS_FILE")"
`
	cmd := exec.Command("bash", "-c", harness)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wait_for_sha failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "still booting") || !strings.Contains(string(out), "polls=2") {
		t.Fatalf("did not wait through ready:false before success: %s", out)
	}
}

func TestDeployConfigMigrationCopiesWithoutRemovingOrOverwriting(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	migration := shellFunction(t, string(script), "config_migration_cmd")
	home := t.TempDir()
	oldDir := filepath.Join(home, ".config", "felt")
	newDir := filepath.Join(home, ".config", "shuttle")
	if err := os.MkdirAll(oldDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(newDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"host.json":   `{"source":"felt"}`,
		"agents.json": `{"source":"felt"}`,
	} {
		if err := os.WriteFile(filepath.Join(oldDir, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(newDir, "agents.json"), []byte(`{"source":"shuttle"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", "-c", migration+"\nconfig_migration_cmd 0 | bash")
	cmd.Env = append(os.Environ(), "HOME="+home)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("config migration: %v\n%s", err, out)
	}
	for path, want := range map[string]string{
		filepath.Join(oldDir, "host.json"):   `{"source":"felt"}`,
		filepath.Join(oldDir, "agents.json"): `{"source":"felt"}`,
		filepath.Join(newDir, "host.json"):   `{"source":"felt"}`,
		filepath.Join(newDir, "agents.json"): `{"source":"shuttle"}`,
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v; want %q", path, got, err, want)
		}
	}
}

func TestDeployRestartInstallsFreshLauncherAndMarksBeforeKillingLoop(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	helper := shellFunction(t, string(script), "respawn_launcher_restart_cmd")
	root := t.TempDir()
	checkout := filepath.Join(root, "checkout")
	dataDir := filepath.Join(root, "data")
	home := filepath.Join(root, "home")
	fakeBin := filepath.Join(root, "fakebin")
	for _, dir := range []string{filepath.Join(checkout, "bin", "rel", "bin"), filepath.Join(checkout, "bin"), dataDir, filepath.Join(home, ".local", "bin"), fakeBin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(checkout, "bin", "rel", "bin", "shuttled"), []byte("release"), 0o755); err != nil {
		t.Fatal(err)
	}
	freshLauncher, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "bin", "shuttle-launch"), freshLauncher, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".local", "bin", "shuttle"), []byte("#!/bin/sh\nprintf '{\\\"data_dir\\\":\\\"%s\\\"}\\n' \"$SHUTTLE_TEST_DATA_DIR\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(root, "tmux-calls")
	marker := filepath.Join(dataDir, "heartbeat.stopped")
	tmux := "#!/bin/sh\ncase \"$*\" in *kill-session*) [ -f \"$SHUTTLE_TEST_MARKER\" ] && echo marker-before-kill >> \"$SHUTTLE_TEST_CALLS\" ;; esac\nprintf '%s\\n' \"$*\" >> \"$SHUTTLE_TEST_CALLS\"\n"
	if err := os.WriteFile(filepath.Join(fakeBin, "tmux"), []byte(tmux), 0o755); err != nil {
		t.Fatal(err)
	}
	harness := `shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
` + helper + `
respawn_launcher_restart_cmd "$CHECKOUT" | /bin/bash
`
	cmd := exec.Command("/bin/bash", "-c", harness)
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"PATH="+fakeBin+string(os.PathListSeparator)+"/usr/bin:/bin",
		"CHECKOUT="+checkout,
		"SHUTTLE_TEST_DATA_DIR="+dataDir,
		"SHUTTLE_TEST_MARKER="+marker,
		"SHUTTLE_TEST_CALLS="+calls,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("respawn launcher restart failed: %v\n%s", err, out)
	}
	installed, err := os.ReadFile(filepath.Join(home, ".local", "bin", "shuttle-launch"))
	if err != nil || string(installed) != string(freshLauncher) {
		t.Fatalf("installed launcher differs from checkout: err=%v", err)
	}
	repo, err := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
	if err != nil || strings.TrimSpace(string(repo)) != checkout {
		t.Fatalf("deployed checkout state = %q, %v; want %q", repo, err, checkout)
	}
	got, err := os.ReadFile(calls)
	if err != nil {
		t.Fatalf("tmux was not called: %v\n%s", err, out)
	}
	if !strings.Contains(string(got), "marker-before-kill") || !strings.Contains(string(got), filepath.Join(home, ".local", "bin", "shuttle-launch")+"' --loop") {
		t.Fatalf("loop restart did not mark before killing and relaunch through the installed script: %s", got)
	}
}

func TestShuttleDeployReportsBootingAtReadyTimeout(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}

	harness := `TARGET_SHA=abc123
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":false}'; }
sleep() { :; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "wait_for_sha") + `
wait_for_sha ""
`
	cmd := exec.Command("bash", "-c", harness)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("wait_for_sha unexpectedly accepted a booting daemon: %s", out)
	}
	if !strings.Contains(string(out), "still booting") || !strings.Contains(string(out), "ready:true") {
		t.Fatalf("timeout did not explain readiness requirement: %s", out)
	}
}

func shellFunction(t *testing.T, script, name string) string {
	t.Helper()
	start := strings.Index(script, name+"() {")
	if start < 0 {
		t.Fatalf("function %s not found", name)
	}
	end := strings.Index(script[start:], "\n}")
	if end < 0 {
		t.Fatalf("function %s is unterminated", name)
	}
	return script[start:start+end+2] + "\n"
}
