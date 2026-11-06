package shuttlecli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

func TestShuttleDeployWaitsForFreshReadyVersion(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	wait := "EXPECTED_RELEASE=/expected/release\n" + shellFunction(t, string(script), "version_launch_health") + shellFunction(t, string(script), "wait_for_sha")
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
    printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","release_path":"/expected/release","incarnation":"verified-a","ready":true,"contract":{"ok":true},"reconciliation_hold":null}'
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

func TestShuttleDeployRegistersARefusedLaunchdJobAgain(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	registered := filepath.Join(t.TempDir(), "registered")
	harness := `TARGET_SHA=abc123
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=2
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
REGISTERED='` + registered + `'
launchctl() {
  case "$1" in
    print) [ -e "$REGISTERED" ] || printf '\tlast exit code = 78: EX_CONFIG\n' ;;
    bootstrap) : > "$REGISTERED" ;;
  esac
}
version_json() {
  [ -e "$REGISTERED" ] || return 0
  printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","release_path":"/expected/release","incarnation":"verified-a","ready":true,"contract":{"ok":true},"reconciliation_hold":null,"quarantine":null}'
}
sleep() { :; }
EXPECTED_RELEASE=/expected/release
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "version_launch_health") + shellFunction(t, string(script), "wait_for_sha") + `
wait_for_sha ""
`
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err != nil {
		t.Fatalf("wait_for_sha did not recover a refused job: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "registering its job again") {
		t.Fatalf("recovery was silent: %s", out)
	}
}

func TestDeployLaunchHealthShell(t *testing.T) {
	t.Parallel()
	out, err := exec.Command("bash", "../../scripts/test-shuttle-deploy.sh").CombinedOutput()
	if err != nil {
		t.Fatalf("deploy launch health: %v\n%s", err, out)
	}
}

func TestDeployReleaseCarriesVerifiedIncarnation(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := `VERIFIED_RELEASE_RECEIPT='{"incarnation":"verified-a","release_path":"/generation-a"}'
shell_quote() { printf "'%s'" "$1"; }
daemon_call() { printf '%s' "$1"; }
run_local() { printf '%s\\n' "$1" >&2; printf '{"ok":true}'; }
` + shellFunction(t, string(script), "release_quarantine") + "\nrelease_quarantine ''\n"
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err != nil || !strings.Contains(string(out), `"expected":{"incarnation":"verified-a","release_path":"/generation-a"}`) {
		t.Fatalf("release omitted verified identity: %v %s", err, out)
	}
}

func TestDeployConfigMigrationCopiesWithoutRemovingOrOverwriting(t *testing.T) {
	t.Parallel()
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

// runLauncherRestart runs deploy's respawn-launcher restart against fake tmux,
// systemctl and launchctl, so no test can reach a real supervisor. supervisor
// names the one the fakes report installed: "", "systemd" or "launchd".
func runLauncherRestart(t *testing.T, supervisor string, selectedOwner ...string) (home string, freshLauncher []byte, tmuxCalls string, supervisorCalls string) {
	t.Helper()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	helper := shellFunction(t, string(script), "respawn_launcher_restart_cmd")
	root := t.TempDir()
	checkout := filepath.Join(root, "checkout")
	dataDir := filepath.Join(root, "data")
	home = filepath.Join(root, "home")
	fakeBin := filepath.Join(root, "fakebin")
	for _, dir := range []string{filepath.Join(checkout, "bin", "rel", "bin"), filepath.Join(checkout, "bin"), dataDir, filepath.Join(home, ".local", "bin"), fakeBin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(checkout, "bin", "rel", "bin", "shuttled"), []byte("release"), 0o755); err != nil {
		t.Fatal(err)
	}
	selected, _ := filepath.EvalSymlinks(filepath.Join(checkout, "bin", "rel"))
	if err := os.MkdirAll(filepath.Join(home, ".shuttle"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".shuttle", "repo"), []byte(selected+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	freshLauncher, err = os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "bin", "shuttle-launch"), freshLauncher, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".local", "bin", "shuttle"), []byte("#!/bin/sh\ncase \"$*\" in 'daemon loop-present') [ \"$SHUTTLE_TEST_OWNER\" = live-tmux ]; exit $?;; 'host --json') printf '{\"data_dir\":\"%s\"}\\n' \"$SHUTTLE_TEST_DATA_DIR\";; *) exit 1;; esac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(root, "tmux-calls")
	marker := filepath.Join(dataDir, "heartbeat.stopped")
	tmux := "#!/bin/sh\ncase \"$*\" in *kill-session*) [ -f \"$SHUTTLE_TEST_MARKER\" ] && echo marker-before-kill >> \"$SHUTTLE_TEST_CALLS\" ;; esac\nprintf '%s\\n' \"$*\" >> \"$SHUTTLE_TEST_CALLS\"\n"
	if err := os.WriteFile(filepath.Join(fakeBin, "tmux"), []byte(tmux), 0o755); err != nil {
		t.Fatal(err)
	}
	supervisorLog := filepath.Join(root, "supervisor-calls")
	fakes := map[string]string{
		"systemctl": "#!/bin/sh\ncase \"$*\" in *show-environment*|*is-enabled*|*is-active*) [ \"$SHUTTLE_TEST_SUPERVISOR\" = systemd ]; exit $? ;; esac\nprintf 'systemctl %s\\n' \"$*\" >> \"$SHUTTLE_TEST_SUPERVISOR_CALLS\"\ncase \"$*\" in *disable*) echo disabled-before-loop >> \"$SHUTTLE_TEST_CALLS\";; esac\n",
		"launchctl": "#!/bin/sh\ncase \"$1\" in print) [ \"$SHUTTLE_TEST_SUPERVISOR\" = launchd ]; exit $? ;; esac\nprintf 'launchctl %s\\n' \"$*\" >> \"$SHUTTLE_TEST_SUPERVISOR_CALLS\"\n",
	}
	for name, source := range fakes {
		if err := os.WriteFile(filepath.Join(fakeBin, name), []byte(source), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	harness := `shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
` + helper + `
respawn_launcher_restart_cmd "$CHECKOUT" "${SHUTTLE_TEST_OWNER:-}" | /bin/bash
`
	cmd := exec.Command("/bin/bash", "-c", harness)
	owner := ""
	if len(selectedOwner) > 0 {
		owner = selectedOwner[0]
	}
	cmd.Env = append(os.Environ(),
		"SHUTTLE_TEST_OWNER="+owner,
		"HOME="+home,
		"PATH="+fakeBin+string(os.PathListSeparator)+"/usr/bin:/bin",
		"CHECKOUT="+checkout,
		"SHUTTLE_TEST_DATA_DIR="+dataDir,
		"SHUTTLE_TEST_MARKER="+marker,
		"SHUTTLE_TEST_CALLS="+calls,
		"SHUTTLE_TEST_SUPERVISOR="+supervisor,
		"SHUTTLE_TEST_SUPERVISOR_CALLS="+supervisorLog,
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
	wantRelease, _ := filepath.EvalSymlinks(filepath.Join(checkout, "bin", "rel"))
	if err != nil || strings.TrimSpace(string(repo)) != wantRelease {
		t.Fatalf("selected release = %q, %v; want %q", repo, err, wantRelease)
	}
	tmuxLog, _ := os.ReadFile(calls)
	supervisorOut, _ := os.ReadFile(supervisorLog)
	return home, freshLauncher, string(tmuxLog), string(supervisorOut)
}

func TestDeployRestartInstallsFreshLauncherAndMarksBeforeKillingLoop(t *testing.T) {
	t.Parallel()
	home, _, got, supervisorCalls := runLauncherRestart(t, "")
	if got == "" {
		t.Fatal("tmux was not called")
	}
	if !strings.Contains(got, "marker-before-kill") || !strings.Contains(got, filepath.Join(home, ".local", "bin", "shuttle-launch")+"' --loop") {
		t.Fatalf("loop restart did not mark before killing and relaunch through the installed script: %s", got)
	}
	if supervisorCalls != "" {
		t.Fatalf("an unsupervised host touched a supervisor: %s", supervisorCalls)
	}
}

func TestLauncherRestartsThroughAnInstalledSupervisor(t *testing.T) {
	t.Parallel()
	for supervisor, want := range map[string]string{
		"systemd": "systemctl --user restart shuttle-daemon.service",
		"launchd": "launchctl kickstart -k gui/",
	} {
		t.Run(supervisor, func(t *testing.T) {
			t.Parallel()
			_, _, tmuxCalls, supervisorCalls := runLauncherRestart(t, supervisor)
			if tmuxCalls != "" {
				t.Fatalf("a supervised host started a respawn loop: %s", tmuxCalls)
			}
			if !strings.Contains(supervisorCalls, want) {
				t.Fatalf("supervisor calls = %q; want %q", supervisorCalls, want)
			}
		})
	}
}

func TestShuttleDeployReportsBootingAtReadyTimeout(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}

	harness := `TARGET_SHA=abc123
EXPECTED_RELEASE=/expected/release
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":false}'; }
sleep() { :; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "version_launch_health") + shellFunction(t, string(script), "wait_for_sha") + `
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
	end := strings.Index(script[start:], "\n}\n\n")
	if end < 0 {
		if strings.HasSuffix(script[start:], "\n}") {
			end = len(script[start:]) - 2
		} else {
			t.Fatalf("function %s is unterminated", name)
		}
	}
	return script[start:start+end+2] + "\n"
}

func TestDeploySupervisorProbeRequiresReachableManagerAndVerifiedLoop(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	probe := shellFunction(t, string(script), "supervisor_probe_cmd")
	home := t.TempDir()
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	launchDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(launchDir, 0o755); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.service.template")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unitDir, "shuttle-daemon.service"), unit, 0o600); err != nil {
		t.Fatal(err)
	}
	plist, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.plist.template")
	if err != nil {
		t.Fatal(err)
	}
	plist = []byte(strings.ReplaceAll(string(plist), "__LABEL__", defaultDaemonLabel))
	if err := os.WriteFile(filepath.Join(launchDir, defaultDaemonLabel+".plist"), plist, 0o600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	write := func(name, source string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+source), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("systemctl", "exit 1\n")
	write("launchctl", "exit 1\n")
	write("tmux", "[ \"$1\" = list-panes ] && { echo 12345; exit 0; }; exit 1\n")
	localBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBin, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localBin, "shuttle"), []byte("#!/bin/sh\n[ \"$SHUTTLE_TEST_LOOP\" = 1 ]\n"), 0755); err != nil {
		t.Fatal(err)
	}
	run := func(loop string) string {
		t.Helper()
		cmd := exec.Command("/bin/dash", "-c", probe+"supervisor_probe_cmd | /bin/dash")
		cmd.Env = append(os.Environ(), "HOME="+home, "PATH="+bin+":/usr/bin:/bin", "SHUTTLE_TEST_LOOP="+loop)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("probe: %v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run("0"); got != "0" {
		t.Fatalf("unreachable manager or unverified pane probe=%q", got)
	}
	if got := run("1"); got != "tmux" {
		t.Fatalf("verified tmux loop should take precedence: %q", got)
	}
	write("systemctl", "case \"$*\" in *is-active*) exit 3;; *) exit 0;; esac\n")
	write("launchctl", "echo 'pid = 0'\nexit 0\n")
	if got := run("0"); got != "0" {
		t.Fatalf("inactive matching systemd/launchd definitions counted as owner: %q", got)
	}
	write("launchctl", "echo 'pid = 12345'\nexit 0\n")
	if got := run("0"); got != "1" {
		t.Fatalf("loaded launchd job not recognized: %q", got)
	}
	write("launchctl", "exit 1\n")
	write("systemctl", "case \"$*\" in *is-active*) exit 0;; *) exit 0;; esac\n")
	if got := run("1"); got != "tmux" {
		t.Fatalf("live tmux lost to enabled reachable systemd: %q", got)
	}
	if got := run("0"); got != "1" {
		t.Fatalf("reachable systemd service probe=%q", got)
	}
}

func TestDeployRevisionCheckoutPreservesSourceBranchAndEdits(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	source := filepath.Join(root, "source with 'quote")
	origin := filepath.Join(root, "origin")
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	for _, dir := range []string{source, origin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	git(origin, "init", "--bare")
	git(source, "init")
	tracked := filepath.Join(source, "tracked")
	if err := os.WriteFile(tracked, []byte("release\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(source, "add", "tracked")
	git(source, "commit", "-m", "release")
	commit := git(source, "rev-parse", "HEAD")
	git(source, "tag", "v2.0.0-rc.1")
	git(source, "remote", "add", "origin", origin)
	git(source, "push", "origin", "HEAD", "--tags")
	git(source, "switch", "-c", "active-work")
	if err := os.WriteFile(tracked, []byte("my edits\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "deploy_root_cmd") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + shellFunction(t, string(script), "revision_checkout_cmd") + "\nrevision_checkout_cmd \"$SOURCE\" | bash -eu\n"
	run := func() ([]byte, error) {
		cmd := exec.Command("bash", "-c", harness)
		cmd.Env = append(os.Environ(), "SOURCE="+source, "TARGET_COMMIT="+commit)
		return cmd.CombinedOutput()
	}
	if out, err := run(); err != nil {
		t.Fatalf("first preparation: %v\n%s", err, out)
	}
	canonicalSource, err := filepath.EvalSymlinks(source)
	if err != nil {
		t.Fatal(err)
	}
	worktree := canonicalSource + ".deploy/" + commit
	git(source, "config", "--local", "core.excludesfile", filepath.Join(source, ".git", "info", "exclude"))
	if err := os.WriteFile(filepath.Join(source, ".git", "info", "exclude"), []byte("ignored-build-output\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "ignored-build-output"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := run(); err != nil {
		t.Fatalf("repeat preparation: %v\n%s", err, out)
	}
	if got, err := os.ReadFile(filepath.Join(worktree, "ignored-build-output")); err != nil || string(got) != "stale" {
		t.Fatalf("existing build cache was discarded: %q, %v", got, err)
	}
	if got := git(source, "branch", "--show-current"); got != "active-work" {
		t.Fatalf("source branch changed to %q", got)
	}
	if got, _ := os.ReadFile(tracked); string(got) != "my edits\n" {
		t.Fatalf("source edits lost: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(worktree, "tracked")); string(got) != "release\n" {
		t.Fatalf("worktree did not contain release: %q", got)
	}
}

func TestDeployBuildCommandStampsBothCLIs(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	repo, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	output := t.TempDir()
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "build_checkout_cmd") + `
make() {
  [ "$*" != 'cli-install' ] || return 0
  [ "$*" = 'build SKIP_UI=1' ] || return 3
  [ "$SHUTTLE_VERSION" = 2.0.0-rc.1 ] || return 4
  go build -o "$OUTPUT/felt" ./cmd/felt && go build -o "$OUTPUT/shuttle" ./cmd/shuttle
}

eval "$(build_checkout_cmd "$SOURCE" 1)"
`
	cmd := exec.Command("bash", "-c", harness)
	cmd.Env = append(os.Environ(), "SOURCE="+repo, "OUTPUT="+output, "DEPLOY_VERSION=2.0.0-rc.1", "TARGET_COMMIT=abc1234")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build command: %v\n%s", err, out)
	}
	for _, name := range []string{"felt", "shuttle"} {
		out, err := exec.Command(filepath.Join(output, name), "--version").CombinedOutput()
		if err != nil || !strings.Contains(string(out), "2.0.0-rc.1") {
			t.Errorf("%s release version: %v\n%s", name, err, out)
		}
	}
}

func TestDeployRootUsesMainWorktreeFromLinkedCheckout(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	main := filepath.Join(root, "main checkout")
	linked := filepath.Join(root, "linked checkout")
	if err := os.MkdirAll(main, 0o755); err != nil {
		t.Fatal(err)
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(main, "init")
	if err := os.WriteFile(filepath.Join(main, "tracked"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(main, "add", "tracked")
	git(main, "commit", "-m", "initial")
	git(main, "worktree", "add", "-b", "linked-lane", linked)
	command := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "deploy_root_cmd") + `deploy_root_cmd "$LINKED" | bash`
	cmd := exec.Command("bash", "-c", command)
	cmd.Env = append(os.Environ(), "LINKED="+linked)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("deploy root: %v\n%s", err, out)
	}
	want, err := filepath.EvalSymlinks(main)
	if err != nil {
		t.Fatal(err)
	}
	want += ".deploy"
	if got := strings.TrimSpace(string(out)); got != want {
		t.Fatalf("deploy root = %q; want %q", got, want)
	}
}

func TestDeployCacheSeedUsesPreviousLiveTreeAndCopies(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	previous := "1111111111111111111111111111111111111111"
	source, target := filepath.Join(root, previous), filepath.Join(root, "target")
	for relative, value := range map[string]string{
		"daemon/deps/pkg/file": "known good", "daemon/_build/prod/file": "beam",
		"ui/node_modules/.npm-ci-stamp": "stamp", "ui/package-lock.json": "same lock",
	} {
		path := filepath.Join(source, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	decoy := filepath.Join(root, "9999999999999999999999999999999999999999", "daemon/deps/pkg/file")
	if err := os.MkdirAll(filepath.Dir(decoy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(decoy, []byte("mtime decoy"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Join(target, "daemon"), filepath.Join(target, "ui")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(target, "ui/package-lock.json"), []byte("same lock"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := `target=$TARGET; export target
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + `seed_deploy_cache_cmd "$ROOT/1111111111111111111111111111111111111111" | bash -eu`
	cmd := exec.Command("bash", "-c", command)
	cmd.Env = append(os.Environ(), "ROOT="+root, "TARGET="+target)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("cache seed: %v\n%s", err, out)
	}
	for relative, want := range map[string]string{
		"daemon/deps/pkg/file": "known good", "daemon/_build/prod/file": "beam", "ui/node_modules/.npm-ci-stamp": "stamp",
	} {
		for _, dir := range []string{source, target} {
			got, err := os.ReadFile(filepath.Join(dir, relative))
			if err != nil || string(got) != want {
				t.Errorf("%s = %q, %v; want %q", filepath.Join(dir, relative), got, err, want)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(target, "daemon/deps/pkg/file"), []byte("edited target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(source, "daemon/deps/pkg/file")); err != nil || string(got) != "known good" {
		t.Fatalf("seed changed source: %q, %v", got, err)
	}
}

func TestDeployCacheSeedSkipsSymlinkedRoots(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	previous := "1111111111111111111111111111111111111111"
	source, target, external := filepath.Join(root, previous), filepath.Join(root, "target"), filepath.Join(root, "external")
	if err := os.MkdirAll(filepath.Join(source, "daemon"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(external, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(external, "payload"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(source, "daemon/deps")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(target, "daemon"), 0o755); err != nil {
		t.Fatal(err)
	}
	command := `target=$TARGET; export target
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + `seed_deploy_cache_cmd "$ROOT/1111111111111111111111111111111111111111" | bash -eu`
	cmd := exec.Command("bash", "-c", command)
	cmd.Env = append(os.Environ(), "ROOT="+root, "TARGET="+target)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "symlinked cache root") {
		t.Fatalf("symlinked cache not skipped: %v\n%s", err, out)
	}
	if _, err := os.Lstat(filepath.Join(target, "daemon/deps")); !os.IsNotExist(err) {
		t.Fatalf("target received cache symlink: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(external, "payload")); err != nil || string(got) != "keep" {
		t.Fatalf("external cache changed: %q, %v", got, err)
	}
}

func TestDeployCacheSeedFailureFallsBackUnderErrexit(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	previous := "1111111111111111111111111111111111111111"
	source, target := filepath.Join(root, previous, "daemon/deps"), filepath.Join(root, "target")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "payload"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(target, "daemon"), 0o755); err != nil {
		t.Fatal(err)
	}
	fakeBin := filepath.Join(root, "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fakeBin, "cp"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	command := `target=$TARGET; export target
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + `seed_deploy_cache_cmd "$ROOT/1111111111111111111111111111111111111111" | bash -eu; echo cold-build-continues`
	cmd := exec.Command("bash", "-c", command)
	cmd.Env = append(os.Environ(), "ROOT="+root, "TARGET="+target, "PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "cache seeding failed; building cold") || !strings.Contains(string(out), "cold-build-continues") {
		t.Fatalf("seed failure aborted preparation: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(target, "daemon/deps")); !os.IsNotExist(err) {
		t.Fatalf("partial cache survived failure: %v", err)
	}
}

func TestDeployPruneKeepsCurrentPreviousAndPiTrees(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	repo := filepath.Join(base, "repo with spaces")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	repo, err = filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init")
	if err := os.WriteFile(filepath.Join(repo, "tracked"), []byte("0"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "tracked")
	git("commit", "-m", "zero")
	commits := []string{git("rev-parse", "HEAD")}
	for i := 1; i < 7; i++ {
		if err := os.WriteFile(filepath.Join(repo, "tracked"), []byte(strconv.Itoa(i)), 0o600); err != nil {
			t.Fatal(err)
		}
		git("commit", "-am", strconv.Itoa(i))
		commits = append(commits, git("rev-parse", "HEAD"))
	}
	deployRoot := repo + ".deploy"
	paths := make([]string, len(commits))
	if err := os.WriteFile(filepath.Join(repo, ".git/info/exclude"), []byte("build-output\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i, sha := range commits {
		paths[i] = filepath.Join(deployRoot, sha)
		git("worktree", "add", "--detach", paths[i], sha)
		if err := os.WriteFile(filepath.Join(paths[i], "build-output"), []byte("generated"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(paths[1], "untracked"), []byte("dirty"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	leaseDir := filepath.Join(env.Getenv("HOME"), ".shuttle", "deploy", "leases")
	if err := os.MkdirAll(leaseDir, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := os.OpenFile(filepath.Join(leaseDir, commits[5]+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(deployRoot, "stale-not-a-worktree")
	if err := os.MkdirAll(stale, 0700); err != nil {
		t.Fatal(err)
	}
	fakeBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakeBin, "pi"), []byte("#!/bin/sh\nprintf 'local package\\n    %s\\n' \"$PI_TREE\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", filepath.Join(repo, "shuttle"), "../../cmd/shuttle")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	selectedRelease := writeTestDaemonRelease(t, filepath.Join(paths[0], "bin", "rel"))
	if err := newApp(env).selectDaemonRelease(selectedRelease); err != nil {
		t.Fatal(err)
	}
	var observedLock atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observedLock.Store(releaseLockHeld(env.Getenv("HOME")))
		fmt.Fprintf(w, `{"release_path":%q}`, filepath.Join(paths[1], "bin", "rel"))
	}))
	defer server.Close()
	env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
	env.Set("REPO", repo)
	env.Set("PREVIOUS", paths[3])
	env.Set("TARGET_COMMIT", commits[4])
	env.Set("PI_TREE", paths[2])
	env.Set("PATH", fakeBin+":"+env.Getenv("PATH"))
	command := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "deploy_root_cmd") + shellFunction(t, string(script), "prune_deploy_cmd") + `prune_deploy_cmd "$REPO" "$PREVIOUS" | bash -eu`
	cmd := env.Command("bash", "-c", command)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("prune: %v\n%s", err, out)
	}
	if !observedLock.Load() {
		t.Fatal("pruning observed releases without excluding concurrent selections")
	}
	if !strings.Contains(string(out), "retaining leased deploy worktree") {
		t.Fatalf("lease was not reported: %s", out)
	}
	for _, path := range append(paths[:6:6], stale) {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("retained worktree %s missing: %v", path, err)
		}
	}
	for _, path := range paths[6:] {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("obsolete worktree remains: %s (%v)", path, err)
		}
		if strings.Contains(git("worktree", "list", "--porcelain"), path) {
			t.Errorf("removed worktree still registered: %s", path)
		}
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if out, err := env.Command("bash", "-c", command).CombinedOutput(); err != nil {
		t.Fatalf("prune expired lease: %v %s", err, out)
	}
	if _, err := os.Stat(paths[5]); !os.IsNotExist(err) {
		t.Fatalf("released lease still protects tree: %v", err)
	}
}

func TestDeployFinishDoesNotPruneOnHarnessOrReleaseFailure(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                     string
		harnessFailed, releaseOK bool
	}{
		{name: "harness failure", harnessFailed: true, releaseOK: true},
		{name: "release failure", harnessFailed: false, releaseOK: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "prune")
			harness := `release_quarantine() { [ "$RELEASE_OK" = 1 ]; }
run_local() { [ "$1" != prune ] || printf '%s\\n' "$1" >> "$MARKER"; }
remember_previous_cmd() { :; }
refresh_checkout_cmd() { :; }
refresh_harnesses() { [ "$HARNESS_FAILED" = 0 ]; }
ok() { :; }
bad() { :; }
prune_deploy_cmd() { printf prune; }
` + shellFunction(t, string(script), "release_verified_deploy") + shellFunction(t, string(script), "finish_verified_deploy") + `release_verified_deploy && finish_verified_deploy /repo
`
			cmd := exec.Command("bash", "-c", harness)
			release := "0"
			if tc.releaseOK {
				release = "1"
			}
			failed := "0"
			if tc.harnessFailed {
				failed = "1"
			}
			cmd.Env = append(os.Environ(), "DEPLOY_REF=sha", "TARGET_SHA=sha", "TARGET_COMMIT=sha", "RELEASE_OK="+release, "HARNESS_FAILED="+failed, "MARKER="+marker)
			if out, err := cmd.CombinedOutput(); err == nil {
				t.Fatalf("failed deployment accepted: %s", out)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("failure pruned a worktree: %v", err)
			}
		})
	}
}

func TestDeployPrunesAfterRelease(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	events := filepath.Join(t.TempDir(), "events")
	harness := `release_quarantine() { printf 'release\n' >> "$EVENTS"; }
run_local() { [ "$1" != prune ] || printf '%s\n' "$1" >> "$EVENTS"; }
remember_previous_cmd() { :; }
refresh_checkout_cmd() { :; }
refresh_harnesses() { :; }
ok() { :; }
bad() { :; }
prune_deploy_cmd() { printf prune; }
` + shellFunction(t, string(script), "release_verified_deploy") + shellFunction(t, string(script), "finish_verified_deploy") + `release_verified_deploy && finish_verified_deploy /repo`
	cmd := exec.Command("bash", "-c", harness)
	cmd.Env = append(os.Environ(), "DEPLOY_REF=sha", "TARGET_SHA=sha", "TARGET_COMMIT=sha", "EVENTS="+events)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("successful finish: %v\\n%s", err, out)
	}
	got, err := os.ReadFile(events)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "release\nprune\n" {
		t.Fatalf("success events = %q, want release then prune", got)
	}
}

func TestDeployHostBuildsPinnedTreeWithBuiltOrShippedUI(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []struct{ ui, wrap string }{{"0", ""}, {"1", ""}, {"0", "wrapper"}, {"1", "wrapper"}} {
		buildUI, wrap := variant.ui, variant.wrap
		t.Run("build_ui="+buildUI+"/wrap="+wrap, func(t *testing.T) {
			dir := t.TempDir()
			events := filepath.Join(dir, "events")
			harness := `fleet_dir() { printf '%s' "$CHECKOUT"; }
wrapper() { printf 'wrap\n' >> "$EVENTS"; "$@"; }
export -f wrapper
builds_ui() { [ "$BUILD_UI" = 1 ]; }
say() { :; }
ok() { :; }
bad() { echo "$1" >&2; }
previous_deploy() { :; }
revision_checkout_cmd() { printf '%s' 'echo "prepare pinned" >> "$EVENTS"'; }
version_json() { :; }
target_is_live() { return 1; }
make() {
  [ "$SKIP_UI" != 1 ] || [ -f "$PWD/ui/dist/index.html" ] || return 9
  printf 'make %s\n' "$*" >> "$EVENTS"
}
export -f make
config_migration_cmd() { :; }
refresh_harnesses() { :; }
remote_host_cycle() { printf 'cycle\n' >> "$EVENTS"; verify_and_release ''; }
wait_for_sha() { printf 'verified\n' >> "$EVENTS"; }
release_verified_deploy() { printf 'released\n' >> "$EVENTS"; }
finish_verified_deploy() { :; }
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "build_checkout_cmd") + shellFunction(t, string(script), "verify_and_release") + shellFunction(t, string(script), "built_release") + shellFunction(t, string(script), "host_transaction") + `host_transaction`
			for _, path := range []string{filepath.Join(dir, "sha", "ui", "dist"), filepath.Join(dir, "stage", "ui", "dist")} {
				if err := os.MkdirAll(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(dir, "stage", "ui", "dist", "index.html"), []byte("bundle"), 0600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("bash", "-c", harness)
			skip := "0"
			if buildUI == "0" {
				skip = "1"
			}
			cmd.Env = append(os.Environ(), "CHECKOUT="+dir, "SOURCE="+dir, "ROOT="+dir, "TARGET_COMMIT=sha", "MODE=deploy", "STAGE="+filepath.Join(dir, "stage"), "SNAPSHOT=", "EVENTS="+events, "SKIP_UI="+skip, "BUILD_UI="+buildUI, "BUILD_WRAP="+wrap, "DEPLOY_VERSION=")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("remote deploy: %v\n%s", err, out)
			}
			got, err := os.ReadFile(events)
			if err != nil {
				t.Fatal(err)
			}
			want := "prepare pinned\nmake build\nmake cli-install\ncycle\nverified\nreleased\n"
			if buildUI == "0" {
				want = strings.Replace(want, "make build\n", "make build SKIP_UI=1\n", 1)
			}
			if wrap != "" {
				want = strings.Replace(want, "make build", "wrap\nmake build", 1)
			}
			if string(got) != want {
				t.Fatalf("remote events = %q; want %q", got, want)
			}
		})
	}
}

func TestDeployPreviousTreeUsesLiveVersion(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := `version_json() { printf '{"git_short_sha":"abc1234"}'; }
deploy_root_cmd() { printf 'printf /repo.deploy'; }
run_local() { bash -c "$1"; }
git() { [ "$*" = '-C /repo rev-parse --verify abc1234^{commit}' ] || exit 2; printf abc123456789; }
export -f git
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "previous_deploy") + `previous_deploy /repo`
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "/repo.deploy/abc123456789" {
		t.Fatalf("previous live tree = %q, %v", out, err)
	}
}

func TestDeployFailedVersionDoesNotPrune(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := `wait_for_sha() { return 1; }
release_verified_deploy() { echo should-not-release; }
` + shellFunction(t, string(script), "verify_and_release") + `verify_and_release remote`
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err == nil || len(out) != 0 {
		t.Fatalf("failed version check reached cleanup: %q, %v", out, err)
	}
}

func TestDeployVisibleRunnerPreservesStderr(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", "-c", shellFunction(t, string(script), "run_local")+`run_local 'echo operator-diagnostic >&2'`)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "operator-diagnostic") {
		t.Fatalf("stderr was hidden: %v\n%s", err, out)
	}
}

func TestDeployRefRejectsWrongDaemonVersion(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := `TARGET_SHA=abc123
DEPLOY_VERSION=2.0.0-rc.1
EXPECTED_RELEASE=/expected/release
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":true,"release_path":"/expected/release","mix_vsn":"0.1.0","contract":{"ok":true},"reconciliation_hold":null}'; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "version_launch_health") + shellFunction(t, string(script), "wait_for_sha") + "\nwait_for_sha ''\n"
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "expected 2.0.0-rc.1") {
		t.Fatalf("wrong daemon version accepted: %v\n%s", err, out)
	}
}
