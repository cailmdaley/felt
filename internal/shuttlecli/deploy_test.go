package shuttlecli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestShuttleDeployWaitsForFreshReadyVersion(t *testing.T) {
	t.Parallel()
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

// runDeploySupervisorMigration writes each unit into a fake home's systemd
// user directory, runs deploy's supervisor migration against a fake shuttle,
// and returns each `shuttle daemon install` call as SHUTTLE_STORES_FILE plus
// its argv.
func runDeploySupervisorMigration(t *testing.T, release daemonRelease, units map[string][]byte) [][]string {
	t.Helper()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	probe := shellFunction(t, string(script), "supervisor_probe_cmd")
	migration := shellFunction(t, string(script), "config_migration_cmd")
	home := t.TempDir()
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	localBin := filepath.Join(home, ".local", "bin")
	for _, dir := range []string{unitDir, localBin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, unit := range units {
		if err := os.WriteFile(filepath.Join(unitDir, name), unit, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	capture := filepath.Join(t.TempDir(), "install-args")
	fakeShuttle := `#!/bin/sh
[ "$1 $2" = "daemon install" ] || exit 2
{
  printf 'CALL\n'
  printf 'STORES_FILE=%s\n' "$SHUTTLE_STORES_FILE"
  shift 2
  for arg do printf 'ARG=%s\n' "$arg"; done
  printf 'CODEX_HOME=%s\n' "$CODEX_HOME"
} >> "$SHUTTLE_CAPTURE_FILE"
`
	if err := os.WriteFile(filepath.Join(localBin, "shuttle"), []byte(fakeShuttle), 0o755); err != nil {
		t.Fatal(err)
	}
	harness := `shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
` + probe + migration + `
config_migration_cmd 1 "$SHUTTLE_RELEASE" | /bin/bash
`
	cmd := exec.Command("/bin/bash", "-c", harness)
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"PATH=/usr/bin:/bin",
		"SHUTTLE_RELEASE="+release.Dir,
		"SHUTTLE_CAPTURE_FILE="+capture,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("supervisor migration: %v\n%s", err, out)
	}
	captured, err := os.ReadFile(capture)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(captured)), "\n") {
		if line == "CALL" {
			calls = append(calls, nil)
			continue
		}
		calls[len(calls)-1] = append(calls[len(calls)-1], line)
	}
	return calls
}

// installFlag reads one flag's value from a captured install call.
func installFlag(t *testing.T, call []string, name string) string {
	t.Helper()
	for i := 1; i+1 < len(call); i++ {
		if call[i] == "ARG="+name {
			return strings.TrimPrefix(call[i+1], "ARG=")
		}
	}
	t.Fatalf("install call %v lacks %s", call, name)
	return ""
}

func TestDeployMigrationPreservesLegacySupervisorOptionsInNewRender(t *testing.T) {
	t.Parallel()
	legacy, err := os.ReadFile("testdata/legacy-shuttle-daemon.service")
	if err != nil {
		t.Fatal(err)
	}
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	serviceTemplate, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.service.template")
	if err != nil {
		t.Fatal(err)
	}
	calls := runDeploySupervisorMigration(t, release, map[string][]byte{"second.service": legacy})
	if len(calls) != 1 {
		t.Fatalf("install calls = %v; want one", calls)
	}
	call := calls[0]
	flag := func(name string) string { return installFlag(t, call, name) }
	options := supervisorOptions{
		OS: "Linux", Label: flag("--label"), Stores: flag("--stores"), StoresFile: strings.TrimPrefix(call[0], "STORES_FILE="),
		Port: flag("--port"), Log: flag("--log"), Path: flag("--path"), SSHSocket: flag("--ssh-auth-sock"),
		ShuttleBin: "/opt/shuttle",
	}
	if options.Label != "io.shuttle.second" || options.Stores != `/mnt/store one,/mnt/store "two" \archive %data` ||
		options.StoresFile != "/tmp/custom config/stores.json" || options.Port != "4401" ||
		options.Log != "/tmp/custom logs/shuttle.log" || options.Path != "/opt/custom bin:/usr/bin:/opt/felt bin" ||
		options.SSHSocket != "/tmp/ssh agent.sock" {
		t.Fatalf("migrated supervisor options = %+v", options)
	}
	rendered, err := renderSupervisorTemplate("Linux", string(serviceTemplate), options, release)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`Environment="SHUTTLE_STORES=/mnt/store one,/mnt/store \"two\" \\archive %%data"`,
		`Environment="SHUTTLE_STORES_FILE=/tmp/custom config/stores.json"`,
		`Environment="SHUTTLE_PORT=4401"`,
		`Environment="PATH=/opt/custom bin:/usr/bin:/opt/felt bin"`,
		`Environment="SSH_AUTH_SOCK=/tmp/ssh agent.sock"`,
		`Environment="SHUTTLE_LOG=/tmp/custom logs/shuttle.log"`,
		`StandardOutput=append:/tmp/custom logs/shuttle.log`,
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("new supervisor render missing migrated value %q:\n%s", want, rendered)
		}
	}
}

func TestDeployMigrationRerendersOnlySupervisorsFromOlderTemplates(t *testing.T) {
	t.Parallel()
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	serviceTemplate, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.service.template")
	if err != nil {
		t.Fatal(err)
	}
	options := supervisorOptions{
		Label: defaultDaemonLabel, ShuttleBin: "/opt/shuttle", Stores: "/srv/store",
		StoresFile: "/tmp/cfg/stores.json", Path: "/opt/bin:/usr/bin", Log: "/tmp/logs/shuttle.log",
		SSHSocket: "/tmp/agent.sock",
	}
	current, err := renderSupervisorTemplate("Linux", string(serviceTemplate), options, release)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(current, "TMUX_TMPDIR") {
		t.Fatalf("a current unit with an empty TMUX_TMPDIR must still name it, or deploy re-renders it forever:\n%s", current)
	}
	if !strings.Contains(current, "\nKillMode=process\n") {
		t.Fatalf("a current unit must set KillMode=process, or deploy re-renders it forever:\n%s", current)
	}
	without := func(marker string) string {
		var lines []string
		for _, line := range strings.Split(current, "\n") {
			if !strings.Contains(line, marker) {
				lines = append(lines, line)
			}
		}
		return strings.Join(lines, "\n")
	}
	if calls := runDeploySupervisorMigration(t, release, map[string][]byte{
		"shuttle-daemon.service": []byte(without("KillMode=process")),
	}); len(calls) != 1 {
		t.Fatalf("install calls = %v; want one for the unit without KillMode=process", calls)
	}
	older := strings.Split(without("TMUX_TMPDIR"), "\n")
	tunnel := "[Service]\nExecStart=/usr/bin/ssh -N shuttle-remote\nEnvironment=SSH_AUTH_SOCK=/tmp/agent.sock\n"

	if calls := runDeploySupervisorMigration(t, release, map[string][]byte{
		"shuttle-daemon.service": []byte(current),
		"shuttle-tunnel.service": []byte(tunnel),
	}); len(calls) != 0 {
		t.Fatalf("current and tunnel supervisors were re-rendered: %v", calls)
	}

	calls := runDeploySupervisorMigration(t, release, map[string][]byte{
		"shuttle-daemon.service": []byte(strings.Join(older, "\n")),
		"shuttle-tunnel.service": []byte(tunnel),
	})
	if len(calls) != 1 {
		t.Fatalf("install calls = %v; want one for the pre-TMUX_TMPDIR daemon unit", calls)
	}
	call := calls[0]
	for flag, want := range map[string]string{
		"--label": defaultDaemonLabel, "--stores": "/srv/store", "--path": "/opt/bin:/usr/bin",
		"--log": "/tmp/logs/shuttle.log", "--ssh-auth-sock": "/tmp/agent.sock", "--port": "",
	} {
		if got := installFlag(t, call, flag); got != want {
			t.Errorf("%s = %q; want %q", flag, got, want)
		}
	}
	if call[0] != "STORES_FILE=/tmp/cfg/stores.json" {
		t.Errorf("stores file = %q", call[0])
	}
	for _, arg := range call {
		if strings.HasPrefix(arg, "ARG=--tmux-tmpdir") {
			t.Errorf("migration pinned %s; install must capture TMUX_TMPDIR from the login shell", arg)
		}
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
func runLauncherRestart(t *testing.T, supervisor string) (home string, freshLauncher []byte, tmuxCalls string, supervisorCalls string) {
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
	freshLauncher, err = os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "bin", "shuttle-launch"), freshLauncher, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".local", "bin", "shuttle"), []byte("#!/bin/sh\nprintf '{\"data_dir\":\"%s\"}\\n' \"$SHUTTLE_TEST_DATA_DIR\"\n"), 0o755); err != nil {
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
		"systemctl": "#!/bin/sh\ncase \"$*\" in *is-enabled*|*is-active*) [ \"$SHUTTLE_TEST_SUPERVISOR\" = systemd ]; exit $? ;; esac\nprintf 'systemctl %s\\n' \"$*\" >> \"$SHUTTLE_TEST_SUPERVISOR_CALLS\"\n",
		"launchctl": "#!/bin/sh\ncase \"$1\" in print) [ \"$SHUTTLE_TEST_SUPERVISOR\" = launchd ]; exit $? ;; esac\nprintf 'launchctl %s\\n' \"$*\" >> \"$SHUTTLE_TEST_SUPERVISOR_CALLS\"\n",
	}
	for name, source := range fakes {
		if err := os.WriteFile(filepath.Join(fakeBin, name), []byte(source), 0o755); err != nil {
			t.Fatal(err)
		}
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
	if err != nil || strings.TrimSpace(string(repo)) != checkout {
		t.Fatalf("deployed checkout state = %q, %v; want %q", repo, err, checkout)
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
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "revision_checkout_cmd") + "\nrevision_checkout_cmd \"$SOURCE\" | bash\n"
	run := func() ([]byte, error) {
		cmd := exec.Command("bash", "-c", harness)
		cmd.Env = append(os.Environ(), "SOURCE="+source, "TARGET_COMMIT="+commit)
		return cmd.CombinedOutput()
	}
	for i := 0; i < 2; i++ {
		if out, err := run(); err != nil {
			t.Fatalf("prepare revision: %v\n%s", err, out)
		}
	}
	if got := git(source, "branch", "--show-current"); got != "active-work" {
		t.Fatalf("source branch changed to %q", got)
	}
	if got, _ := os.ReadFile(tracked); string(got) != "my edits\n" {
		t.Fatalf("source edits lost: %q", got)
	}
	worktree := source + ".deploy/" + commit
	if got, _ := os.ReadFile(filepath.Join(worktree, "tracked")); string(got) != "release\n" {
		t.Fatalf("worktree did not contain release: %q", got)
	}
	if err := os.WriteFile(filepath.Join(worktree, "tracked"), []byte("retained edits\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := run(); err == nil || !strings.Contains(string(out), "local edits") {
		t.Fatalf("dirty worktree was not refused: %v\n%s", err, out)
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

func TestDeployRetargetsCurrentSupervisorAndPreservesSettings(t *testing.T) {
	t.Parallel()
	old := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "old"))
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "revision"))
	template, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.service.template")
	if err != nil {
		t.Fatal(err)
	}
	options := supervisorOptions{
		Label: defaultDaemonLabel, ShuttleBin: "/opt/shuttle", Stores: "/srv/store",
		StoresFile: "/tmp/cfg/stores.json", Path: "/opt/bin:/usr/bin", Log: "/tmp/logs/shuttle.log",
		SSHSocket: "/tmp/agent.sock", TmuxTmpdir: "/tmp/tmux operator",
		CodexSocket: "/tmp/codex.sock", CodexHome: "/tmp/codex home",
	}
	rendered, err := renderSupervisorTemplate("Linux", string(template), options, old)
	if err != nil {
		t.Fatal(err)
	}
	calls := runDeploySupervisorMigration(t, release, map[string][]byte{"shuttle-daemon.service": []byte(rendered)})
	if len(calls) != 1 {
		t.Fatalf("current supervisor was not retargeted: %v", calls)
	}
	for name, want := range map[string]string{
		"--stores": options.Stores, "--path": options.Path, "--log": options.Log,
		"--ssh-auth-sock": options.SSHSocket, "--tmux-tmpdir": options.TmuxTmpdir,
		"--codex-socket": options.CodexSocket,
	} {
		if got := installFlag(t, calls[0], name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if calls[0][0] != "STORES_FILE="+options.StoresFile || calls[0][len(calls[0])-1] != "CODEX_HOME="+options.CodexHome {
		t.Fatalf("supervisor environment not retained: %v", calls[0])
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
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":true,"mix_vsn":"0.1.0"}'; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "wait_for_sha") + "\nwait_for_sha ''\n"
	out, err := exec.Command("bash", "-c", harness).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "expected 2.0.0-rc.1") {
		t.Fatalf("wrong daemon version accepted: %v\n%s", err, out)
	}
}
