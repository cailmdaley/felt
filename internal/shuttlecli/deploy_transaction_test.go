package shuttlecli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The real deploy script and lock helper talk to a fake SSH host, build tool,
// API and supervisor. Every path and process belongs to this temporary fleet.
type deployFleet struct {
	root, repo, remote, origin, home, bin, events, state, gate, sha string
	env                                                             []string
}

func newDeployFleet(t *testing.T) *deployFleet {
	t.Helper()
	f := &deployFleet{root: t.TempDir()}
	f.repo = filepath.Join(f.root, "repo")
	f.remote = filepath.Join(f.root, "remote")
	f.origin = filepath.Join(f.root, "origin")
	f.home = filepath.Join(f.root, "home")
	f.bin = filepath.Join(f.root, "fakebin")
	f.events = filepath.Join(f.root, "events")
	f.state = filepath.Join(f.root, "version.json")
	f.gate = filepath.Join(f.root, "build-go")
	for _, dir := range []string{f.repo, f.home, f.bin, filepath.Join(f.home, ".shuttle")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, relative := range []string{"bin/shuttle-deploy", "scripts/deploy-lock/main.go"} {
		data, err := os.ReadFile(filepath.Join("../..", relative))
		if err != nil {
			t.Fatal(err)
		}
		write(filepath.Join(f.repo, relative), string(data))
	}
	write(filepath.Join(f.repo, "scripts/ci-status-hook.sh"), `#!/bin/sh
if [ "${CI_GATE:-}" = 1 ]; then
 touch "$FLEET_ROOT/ci-entered"
 while [ ! -f "$FLEET_ROOT/ci-go" ]; do sleep .02; done
fi
`)
	write(filepath.Join(f.repo, "tracked"), "target\n")
	write(filepath.Join(f.repo, "bin/shuttle-launch"), `#!/bin/sh
sha=$(git -C "${TEST_RELEASE%/bin/rel}" rev-parse HEAD)
printf '{"git_short_sha":"%.7s","git_sha":"%s","release_path":"%s","booted_at":"2099-01-01T00:00:00Z","ready":true}\n' "$sha" "$sha" "$TEST_RELEASE" > "$STATE"
echo cycle >> "$EVENTS"
`)
	realBash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.bin, "bash"), "#!/bin/sh\n[ \"$1\" != -lc ] || { shift; exec '"+realBash+"' -c \"$1\"; }\nexec '"+realBash+"' \"$@\"\n")
	write(filepath.Join(f.bin, "ssh"), `#!/bin/sh
shift
exec bash -c "$*"
`)
	write(filepath.Join(f.bin, "make"), `#!/bin/sh
case "$1" in
 build)
  echo "build $(git rev-parse HEAD) $*" >> "$EVENTS"
  touch "$FLEET_ROOT/build-entered"
  while [ ! -f "$BUILD_GATE" ]; do sleep .02; done
  [ "${FAIL_BUILD:-0}" != 1 ] || exit 13
  mkdir -p bin/rel ui/dist
  echo '<html>pinned bundle</html>' > ui/dist/index.html
  cp "$FAKE_BIN/shuttle" ./shuttle
  ;;
 ui) mkdir -p ui/dist; echo bundle > ui/dist/index.html ;;
 cli-install) : ;;
 *) exit 19 ;;
esac
`)
	write(filepath.Join(f.bin, "felt"), `#!/bin/sh
case "$*" in
 'setup receipt --json') printf '{\n  "bundles": [],\n  "status": "healthy"\n}\n';;
 *) exit 0;;
esac
`)
	write(filepath.Join(f.bin, "shuttle"), `#!/bin/sh
case "$1 $2" in
 'host --json') printf '{"data_dir":"%s/.shuttle","listen":"tcp://127.0.0.1:54321"}\n' "$HOME";;
 'host check-owner') exit 0;;
 'daemon loop-present') exit 1;;
 'daemon activate-release') shift 2; TEST_RELEASE="$1"; export TEST_RELEASE; shift 2; exec "$@";;
 'daemon prune-releases') echo prune >> "$EVENTS";;
 'daemon release') echo release >> "$EVENTS";;
 *) echo "unexpected shuttle $*" >&2; exit 20;;
esac
`)
	write(filepath.Join(f.bin, "curl"), `#!/bin/sh
cat "$STATE"
`)
	for name, body := range map[string]string{"systemctl": "exit 1", "launchctl": "exit 1", "lsof": "exit 0", "pi": "exit 0"} {
		write(filepath.Join(f.bin, name), "#!/bin/sh\n"+body+"\n")
	}
	// No listener PID can ever reach xargs/kill; the fake returns an empty list.
	write(f.state, `{"git_short_sha":"0000000","release_path":"/old","ready":true,"booted_at":"2026-01-01T00:00:00Z"}`)
	f.env = append(os.Environ(), "HOME="+f.home, "PATH="+f.bin+":"+os.Getenv("PATH"), "FAKE_BIN="+f.bin, "FLEET_ROOT="+f.root, "EVENTS="+f.events, "STATE="+f.state, "BUILD_GATE="+f.gate, "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0", "SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1", "SHUTTLE_AGENTS_FILE="+filepath.Join(f.root, "absent"), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
	f.git(t, f.repo, "init", "-b", "main")
	f.git(t, f.repo, "add", ".")
	f.git(t, f.repo, "commit", "-m", "target")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	f.git(t, f.root, "init", "--bare", f.origin)
	f.git(t, f.repo, "remote", "add", "origin", f.origin)
	f.git(t, f.repo, "push", "-u", "origin", "main")
	f.git(t, f.root, "clone", "-b", "main", f.origin, f.remote)
	fleet := filepath.Join(f.root, "remotes.json")
	write(fleet, fmt.Sprintf(`{"remotes":[{"name":"fake","ssh":"fake","checkout":%q}]}`, f.remote))
	f.env = append(f.env, "SHUTTLE_REMOTES_FILE="+fleet)
	return f
}

func (f *deployFleet) git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = f.env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}
func deployAwait(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
func (f *deployFleet) start(t *testing.T, name string, extra ...string) (*exec.Cmd, string) {
	t.Helper()
	logPath := filepath.Join(f.root, name+".log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", filepath.Join(f.repo, "bin/shuttle-deploy"), "--hosts", "fake", "--no-push")
	cmd.Env = append(append([]string{}, f.env...), extra...)
	cmd.Stdout, cmd.Stderr = log, log
	// A private process group lets failure cleanup include the fake remote build.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Wait()
		}
		log.Close()
	})
	return cmd, logPath
}
func fleetRead(path string) string { b, _ := os.ReadFile(path); return string(b) }
func fleetTouch(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDeployConcurrentRunsCoalesceUnderHostLock(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	first, firstLog := f.start(t, "first")
	deployAwait(t, "first build: "+firstLog, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	second, secondLog := f.start(t, "second")
	deployAwait(t, "second waiting: "+secondLog, func() bool { return strings.Contains(fleetRead(secondLog), "deploy-lock: waiting for") })
	if got := strings.Count(fleetRead(f.events), "build "); got != 1 {
		t.Fatalf("overlapping builds=%d", got)
	}
	if log := fleetRead(secondLog); !strings.Contains(log, "deployer=") || !strings.Contains(log, "target="+f.sha) {
		t.Fatalf("holder not named: %s", log)
	}
	fleetTouch(t, f.gate)
	for i, cmd := range []*exec.Cmd{first, second} {
		if err := cmd.Wait(); err != nil {
			t.Fatalf("deploy %d: %v\nfirst: %s\nsecond: %s", i, err, fleetRead(firstLog), fleetRead(secondLog))
		}
	}
	events := fleetRead(f.events)
	if strings.Count(events, "build ") != 1 || strings.Count(events, "cycle\n") != 1 || strings.Count(events, "release\n") != 2 {
		t.Fatalf("concurrent deploy events: %s", events)
	}
	if !strings.Contains(fleetRead(secondLog), "coalescing without a daemon cycle") {
		t.Fatalf("coalescing not reported: %s", fleetRead(secondLog))
	}
}

func TestDeployPinsDefaultRevisionWhenMainMoves(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "moving-main", "CI_GATE=1")
	deployAwait(t, "target resolved", func() bool { _, err := os.Stat(filepath.Join(f.root, "ci-entered")); return err == nil })
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "main moved")
	newer := f.git(t, f.repo, "rev-parse", "HEAD")
	f.git(t, f.repo, "push")
	fleetTouch(t, filepath.Join(f.root, "ci-go"))
	if err := cmd.Wait(); err != nil {
		t.Fatalf("deploy: %v %s", err, fleetRead(log))
	}
	events := fleetRead(f.events)
	if !strings.Contains(events, "build "+f.sha+" build") || strings.Contains(events, newer) {
		t.Fatalf("moving main changed target: %s", events)
	}
	if !strings.Contains(fleetRead(f.state), f.sha) {
		t.Fatalf("wrong daemon: %s", fleetRead(f.state))
	}
	if got := f.git(t, f.remote, "rev-parse", "HEAD"); got != f.sha {
		t.Fatalf("source branch moved: %s", got)
	}
}

func TestDeployFailureNamesHostAndStep(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "failed", "FAIL_BUILD=1")
	if err := cmd.Wait(); err == nil {
		t.Fatalf("failed build reported success: %s", fleetRead(log))
	}
	if got := fleetRead(log); !strings.Contains(got, "fake: build/install CLIs: failed") || !strings.Contains(got, "failed: fake") {
		t.Fatalf("failure lacks host/step: %s", got)
	}
	if got := fleetRead(f.events); strings.Contains(got, "cycle") || strings.Contains(got, "release") {
		t.Fatalf("failed build changed daemon: %s", got)
	}
}
