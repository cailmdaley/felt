package shuttlecli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// The real deploy script and lock helper talk to a fake SSH host, build tool,
// API and supervisor. Every path and process belongs to this temporary fleet.
type deployFleet struct {
	root, repo, remote, origin, home, bin, events, state, gate, sha string
	env                                                             []string
}

// Fleet fixtures launch whole shell trees. Bound their process fanout
// alongside the package's parallel, short-deadline hook tests. A fleet spends
// most of its time waiting on its processes (under one core each), so half
// the test's processors keeps the rest of the package fed. A fleet waiting
// for a slot still holds one of go test's -parallel slots.
var deployFleetSlots = make(chan struct{}, max(2, runtime.GOMAXPROCS(0)/2))

func newDeployFleet(t *testing.T) *deployFleet {
	t.Helper()
	deployFleetSlots <- struct{}{}
	t.Cleanup(func() { <-deployFleetSlots })
	f := &deployFleet{root: filepath.Join(t.TempDir(), "fleet's space")}
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
	// Fake tools are shared content-addressed copies (sysenvtest.LinkScript):
	// macOS assesses each new executable on its first exec, and every fleet
	// writes the same ones.
	link := func(path, body string) {
		t.Helper()
		sysenvtest.LinkScript(t, path, body)
	}
	for _, relative := range []string{"bin/shuttle-deploy", "go.mod", "scripts/deploy-lock/main.go", "scripts/deploy-run.sh"} {
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
	write(filepath.Join(f.repo, "package.json"), `{"name":"felt"}`)
	write(filepath.Join(f.repo, "daemon/mix.exs"), "# fixture\n")
	write(filepath.Join(f.repo, "ui/package-lock.json"), "{}\n")
	write(filepath.Join(f.repo, "bin/shuttle-launch"), `#!/bin/sh
if (: >&3) 2>/dev/null || (: >&4) 2>/dev/null; then echo launcher-inherited-deploy-lock >&2; exit 92; fi
bash -c 'trap -p TERM' > "$FLEET_ROOT/launcher-term-trap"
if [ "${ACTIVATION_GATE:-0}" = 1 ]; then touch "$FLEET_ROOT/activation-entered"; while [ ! -f "$FLEET_ROOT/activation-go" ]; do sleep .02; done; fi
sha=$(git -C "${TEST_RELEASE%/bin/*}" rev-parse HEAD)
printf '{"git_short_sha":"%.7s","git_sha":"%s","release_path":"%s","booted_at":"2099-01-01T00:00:00Z","incarnation":"fixture-incarnation","contract":{"ok":true},"reconciliation_hold":null,"ready":true}\n' "$sha" "$sha" "$TEST_RELEASE" > "$STATE"
echo cycle >> "$EVENTS"
if [ "${BOOTING_LAUNCHER:-0}" = 1 ]; then sed 's/"ready":true/"ready":false/' "$STATE" > "$STATE.next"; mv "$STATE.next" "$STATE"; fi
if [ "${BACKGROUND_LAUNCHER:-0}" = 1 ]; then
 nohup sleep 300 >/dev/null 2>&1 &
 echo $! > "$FLEET_ROOT/background.pid"
fi
`)
	realBash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.home, ".bash_profile"), "umask 027\nexport LOGIN_PROFILE_LOADED=yes\n")
	link(filepath.Join(f.bin, "bash"), "#!/bin/sh\ncase \"$1\" in\n-lc) shift; LOGIN_CODE=$1; export LOGIN_CODE; shift; exec '"+realBash+"' --noprofile -l -c '. \"$HOME/.bash_profile\"; eval \"$LOGIN_CODE\"' \"$@\";;\nesac\nexec '"+realBash+"' \"$@\"\n")
	realRm, err := exec.LookPath("rm")
	if err != nil {
		t.Fatal(err)
	}
	link(filepath.Join(f.bin, "rm"), `#!/bin/sh
if [ "${CHECK_CLEANUP_ORDER:-0}" = 1 ]; then
 case "$*" in *"/.shuttle/deploy/tools/lock."*)
 pid=$(sed -n 's/.*; pid=\([0-9]*\);.*/\1/p' "$HOME/.shuttle/deploy.lock")
 if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo cleanup-before-helper-exit >&2; exit 41; fi;;
 esac
fi
exec `+shellQuote(realRm)+` "$@"
`)
	// The fake host never takes shipped Linux artifacts: a deploy host that is
	// Linux x86_64 with a container runtime would otherwise run an extra local
	// build transaction under the same host lock before every deploy.
	realUname, err := exec.LookPath("uname")
	if err != nil {
		t.Fatal(err)
	}
	link(filepath.Join(f.bin, "uname"), "#!/bin/sh\nif [ \"$*\" = -sm ]; then echo \"$('"+realUname+"' -s) fixture\"; else exec '"+realUname+"' \"$@\"; fi\n")
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	link(filepath.Join(f.bin, "go"), "#!/bin/sh\nif [ \"${FAIL_LOCK_BUILD:-0}\" = 1 ] && [ \"${TEST_REMOTE:-0}\" = 1 ]; then echo 'bootstrap-stderr-token' >&2; exit 42; fi\nif [ \"$1\" = build ]; then\n [ \"$GOMAXPROCS\" = 2 ] && [ \"$GOFLAGS\" = -p=2 ] || { echo 'uncapped lock bootstrap' >&2; exit 31; }\n [ \"$2\" = -C ] || { echo 'lock helper builds outside its module' >&2; exit 33; }\n case \"$3\" in \"$HOME\"/.shuttle/deploy/tools/*) ;; *) echo 'lock executable depends on tmp mount' >&2; exit 32;; esac\n grep -q '^toolchain ' \"$3/go.mod\" || { echo 'lock helper has no pinned toolchain' >&2; exit 34; }\nfi\n"+lockBuildCache(realGo)+"exec '"+realGo+"' \"$@\"\n")
	realSleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	link(filepath.Join(f.bin, "sleep"), "#!/bin/sh\nif [ \"${CHECK_POLL:-0}\" = 1 ] && [ -f \"$FLEET_ROOT/readiness-observed\" ]; then\n echo \"poll-interval $1\" >> \"$EVENTS\"\n sed 's/\"ready\":false/\"ready\":true/' \"$STATE\" > \"$STATE.next\"; mv \"$STATE.next\" \"$STATE\"\nelse exec '"+realSleep+"' \"$@\"; fi\n")
	cache, err := exec.Command(realGo, "env", "GOCACHE").Output()
	if err != nil {
		t.Fatal(err)
	}
	f.env = append(f.env, "GOCACHE="+strings.TrimSpace(string(cache)))
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	link(filepath.Join(f.bin, "ssh"), `#!/bin/sh
echo ssh >> "$EVENTS"
echo $$ > "$FLEET_ROOT/ssh.pid"
for option in ConnectTimeout=15 ServerAliveInterval=15 ServerAliveCountMax=3; do
 case "$*" in *"$option"*) ;; *) echo "missing SSH bound: $option" >&2; exit 94;; esac
done
case "$*" in *SHUTTLE_DEPLOY_DONE_*) case "$*" in *BatchMode=yes*) ;; *) echo transaction-ssh-may-prompt >&2; exit 93;; esac;; esac
if [ "${SSH_GATE:-0}" = 1 ]; then touch "$FLEET_ROOT/ssh-entered"; while [ ! -f "$FLEET_ROOT/ssh-go" ]; do sleep .02; done; fi
while :; do case "${1:-}" in -o) shift 2;; -n) shift;; *) break;; esac; done
shift
if [ "${FAIL_SSH_PREFLIGHT:-0}" = 1 ] && [ "$*" = true ]; then echo preflight-ssh-stderr-token >&2; exit 255; fi
# Real SSH joins arguments, then the remote shell parses that command. The
# isolated login shim sources this fixture's profile and preserves stderr.
exec /usr/bin/env -i TEST_REMOTE=1 SHUTTLE_TEST_SSH_HELPER=1 SHUTTLE_TEST_GO_CACHES_PINNED=1 HOME="$HOME" PATH="$PATH" GOCACHE="$GOCACHE" GOTOOLCHAIN=local DEPLOY_LOCK_CACHE="$DEPLOY_LOCK_CACHE" \
 FAKE_BIN="$FAKE_BIN" FLEET_ROOT="$FLEET_ROOT" FLEET_RUN="${FLEET_RUN:-}" EVENTS="$EVENTS" STATE="$STATE" BUILD_GATE="$BUILD_GATE" \
 CHECK_CLEANUP_ORDER="${CHECK_CLEANUP_ORDER:-0}" FAIL_LOCK_BUILD="${FAIL_LOCK_BUILD:-0}" FAIL_BUILD="${FAIL_BUILD:-0}" BACKGROUND_LAUNCHER="${BACKGROUND_LAUNCHER:-0}" RELEASE_BUSY_ONCE="${RELEASE_BUSY_ONCE:-0}" SHUTTLE_DEPLOY_RELEASE_RETRY_SECONDS="${SHUTTLE_DEPLOY_RELEASE_RETRY_SECONDS:-5}" \
 ACTIVATION_GATE="${ACTIVATION_GATE:-0}" CHECK_REAL_PRUNE="${CHECK_REAL_PRUNE:-0}" CHECK_OLD_PRUNE="${CHECK_OLD_PRUNE:-0}" PI_CHECKOUT="${PI_CHECKOUT:-}" BOOTING_LAUNCHER="${BOOTING_LAUNCHER:-0}" CHECK_POLL="${CHECK_POLL:-0}" `+shellQuote(testBinary)+` -test.run=^TestDeploySSHHelperProcess$ -- "$*"
`)
	link(filepath.Join(f.bin, "make"), `#!/bin/sh
case "$1" in
 build)
  echo "umask $(umask)" >> "$EVENTS"
  echo "build $(git rev-parse HEAD) $*" >> "$EVENTS"
  touch "$FLEET_ROOT/build-entered"
  while [ ! -f "$BUILD_GATE" ]; do sleep .02; done
  [ "${FAIL_BUILD:-0}" != 1 ] || exit 13
  generation=$(mktemp -d "$PWD/bin/rel.generation-XXXXXXXX")
  ln -s "${generation##*/}" bin/rel-built
  if [ "${2:-}" = SKIP_UI=1 ]; then
    [ -f ui/dist/index.html ] || exit 17
  else
    mkdir -p ui/dist
    echo '<html>pinned bundle</html>' > ui/dist/index.html
  fi
  ln -f "$FAKE_BIN/shuttle" ./shuttle
  ;;
 ui) mkdir -p ui/dist; echo bundle > ui/dist/index.html ;;
 cli-install) : ;;
 *) exit 19 ;;
esac
`)
	link(filepath.Join(f.bin, "rsync"), `#!/bin/sh
previous=
for arg in "$@"; do source="$previous"; previous="$arg"; done
dest="${previous#*:}"
printf 'rsync %s %s\n' "$source" "$dest" >> "$EVENTS"
if [ -d "$source" ]; then mkdir -p "$dest"; cp -R "$source/." "$dest/"
else mkdir -p "$(dirname "$dest")"; cp "$source" "$dest"; fi
`)
	link(filepath.Join(f.bin, "build-wrapper"), "#!/bin/sh\necho wrapper >> \"$EVENTS\"\nexec \"$@\"\n")
	link(filepath.Join(f.bin, "felt"), `#!/bin/sh
case "$*" in
 'setup receipt --json') printf '{\n  "bundles": [],\n  "status": "healthy"\n}\n';;
 *) exit 0;;
esac
`)
	link(filepath.Join(f.bin, "shuttle"), `#!/bin/sh
case "$1 $2" in
 'host --json') printf '{"data_dir":"%s/.shuttle","listen":"tcp://127.0.0.1:54321"}\n' "$HOME";;
 'host check-owner') exit 0;;
 'daemon loop-present') exit 1;;
 'daemon activate-release') shift 2; TEST_RELEASE="$1"; export TEST_RELEASE; shift 2; exec "$@";;
 'daemon prune-releases')
  if [ "${CHECK_OLD_PRUNE:-0}" = 1 ] && [ -d "$4/.leases" ]; then git -C "$3" worktree remove --force "$4/.leases" || exit 19; fi
  if [ "${CHECK_REAL_PRUNE:-0}" = 1 ]; then
   source="$3"; root="$4"; shift 4
   for tree in "$root"/*; do
    [ -d "$tree" ] || continue
    keep=0; for arg do [ "$arg" != "$tree" ] || keep=1; done
    [ "$keep" = 1 ] || git -C "$source" worktree remove --force "$tree" || exit 21
   done
  fi
  echo prune >> "$EVENTS";;
 'daemon release') echo release >> "$EVENTS";;
 *) echo "unexpected shuttle $*" >&2; exit 20;;
esac
`)
	link(filepath.Join(f.bin, "curl"), `#!/bin/sh
case "$*" in *'/quarantine/release'*)
 case "$*" in *'"expected":{'*'"incarnation": "fixture-incarnation"'*) ;; *) echo missing-expected-incarnation >&2; exit 22;; esac
 if [ "${RELEASE_BUSY_ONCE:-0}" = 1 ] && [ ! -f "$FLEET_ROOT/release-busy" ]; then touch "$FLEET_ROOT/release-busy"; exit 22; fi
 echo release >> "$EVENTS"
 printf '{"ok":true}'
 exit 0;;
esac
if grep -q '"ready":false' "$STATE"; then touch "$FLEET_ROOT/readiness-observed"; fi
cat "$STATE"
`)
	for name, body := range map[string]string{"systemctl": "exit 1", "launchctl": "exit 1", "lsof": "exit 0", "pi": "exit 0"} {
		link(filepath.Join(f.bin, name), "#!/bin/sh\n"+body+"\n")
	}
	link(filepath.Join(f.bin, "pi"), `#!/bin/sh
if [ -n "${PI_CHECKOUT:-}" ]; then
 echo "pi-inspect $(git -C "$PI_CHECKOUT" rev-parse HEAD)" >> "$EVENTS"
 printf '  %s\n    %s\n' "$PI_CHECKOUT" "$PI_CHECKOUT"
fi
`)
	// No listener PID can ever reach xargs/kill; the fake returns an empty list.
	write(f.state, `{"git_short_sha":"0000000","release_path":"/old","ready":true,"booted_at":"2026-01-01T00:00:00Z"}`)
	f.env = append(append(os.Environ(), f.env...), "HOME="+f.home, "PATH="+f.bin+":"+os.Getenv("PATH"), "FAKE_BIN="+f.bin, "FLEET_ROOT="+f.root, "EVENTS="+f.events, "STATE="+f.state, "BUILD_GATE="+f.gate, "DEPLOY_LOCK_CACHE="+filepath.Join(testFenceDir, "deploy-lock"), "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0", "SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1", "SHUTTLE_AGENTS_FILE="+filepath.Join(f.root, "absent"), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
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

// lockBuildCache is the fake go's answer to the deploy's lock-helper build
// (`go build -C <tool dir> -o lock .`): the first build of each distinct
// main.go and go.mod runs the real compiler into DEPLOY_LOCK_CACHE, and every
// later one hard-links that executable into the tool dir. The helper is linked
// with a 1s TERM-to-KILL grace, so a cancelled fleet does not wait out the
// production three seconds. Every fleet builds
// the same source twice (deployer and host), and a fresh build costs a link
// plus macOS's first-exec assessment of the new binary.
func lockBuildCache(realGo string) string {
	return `if [ $# = 6 ] && [ "$1 $2 $4 $5 $6" = "build -C -o lock ." ] && [ -n "${DEPLOY_LOCK_CACHE:-}" ]; then
 built="$DEPLOY_LOCK_CACHE/$(cat "$3/go.mod" "$3/main.go" | cksum | tr ' ' -)"
 if [ ! -f "$built" ]; then
  mkdir -p "$DEPLOY_LOCK_CACHE" && '` + realGo + `' build -C "$3" -ldflags=-X=main.cancelGrace=1s -o "$built.$$" . && mv -f "$built.$$" "$built" || exit 1
 fi
 ln -f "$built" "$3/lock" 2>/dev/null || cp "$built" "$3/lock"
 exit
fi
`
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

// deployWait waits for a deployer started by startArgs. A deployer still
// running after two minutes fails the test with the process table and the
// fleet's logs instead of holding the package to its timeout.
func (f *deployFleet) deployWait(t *testing.T, cmd *exec.Cmd) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Minute):
	}
	ps, _ := exec.Command("ps", "-eo", "pid,ppid,pgid,stat,wchan,args").CombinedOutput()
	var logs strings.Builder
	paths, _ := filepath.Glob(filepath.Join(f.root, "*.log"))
	paths = append(paths, filepath.Join(f.home, ".shuttle/deploy/last-run.log"), f.events)
	for _, path := range paths {
		fmt.Fprintf(&logs, "==> %s\n%s\n", path, fleetRead(path))
	}
	t.Fatalf("deployer %d still running after 2m\n%s\n%s", cmd.Process.Pid, ps, logs.String())
	return nil
}

func (f *deployFleet) start(t *testing.T, name string, extra ...string) (*exec.Cmd, string) {
	t.Helper()
	return f.startHost(t, name, "fake", extra...)
}

func (f *deployFleet) startHost(t *testing.T, name, host string, extra ...string) (*exec.Cmd, string) {
	t.Helper()
	return f.startArgs(t, name, host, nil, extra...)
}

func (f *deployFleet) startArgs(t *testing.T, name, host string, args []string, extra ...string) (*exec.Cmd, string) {
	t.Helper()
	logPath := filepath.Join(f.root, name+".log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", append([]string{filepath.Join(f.repo, "bin/shuttle-deploy"), "--hosts", host, "--no-push"}, args...)...)
	cmd.Env = append(append([]string{}, f.env...), extra...)
	cmd.Stdout, cmd.Stderr = log, log
	// Fixture signals never reach the test runner's process group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// The deployer's lifeline cancels its owned helpers; a reaped process
		// group number must not be used as a later cleanup handle.
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
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

func TestDeploySSHParsesJoinedArgumentsAndLoadsLoginProfile(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	snippet := `printf "joined argument's value: %s\\n" "$LOGIN_PROFILE_LOADED"; printf 'login-stderr-token\\n' >&2; exit 37`
	cmd := exec.Command(filepath.Join(f.bin, "ssh"), "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "fake", "bash", "-lc", shellQuote(snippet))
	cmd.Env = f.env
	out, err := cmd.CombinedOutput()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 37 {
		t.Fatalf("remote exit: %v %s", err, out)
	}
	if !strings.Contains(string(out), "joined argument's value: yes") || !strings.Contains(string(out), "login-stderr-token") {
		t.Fatalf("SSH quoting, login profile or stderr lost: %s", out)
	}
}

// The remote shell has its own group and a socket-like stdin pipe. Killing the
// fake SSH client closes that pipe without also signalling the remote machine.
func TestDeploySSHHelperProcess(t *testing.T) {
	if os.Getenv("SHUTTLE_TEST_SSH_HELPER") != "1" {
		return
	}
	finish := func(code int) { os.RemoveAll(testFenceDir); os.Exit(code) }
	r, w, e := os.Pipe()
	if e != nil {
		finish(90)
	}
	remote := exec.Command("bash", "-c", os.Args[len(os.Args)-1])
	remote.Env = append(os.Environ(), "HOME="+filepath.Join(os.Getenv("FLEET_ROOT"), "home"))
	remote.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	remote.Stdin, remote.Stdout, remote.Stderr = r, os.Stdout, os.Stderr
	if e = remote.Start(); e != nil {
		finish(91)
	}
	r.Close()
	// FLEET_RUN names one of several concurrent deployers' remote shells.
	pidFile := "remote.pid"
	if run := os.Getenv("FLEET_RUN"); run != "" {
		pidFile = "remote." + run + ".pid"
	}
	os.WriteFile(filepath.Join(os.Getenv("FLEET_ROOT"), pidFile), []byte(strconv.Itoa(remote.Process.Pid)), 0600)
	go func() { io.Copy(w, os.Stdin); w.Close() }()
	if e = remote.Wait(); e != nil {
		if exit, ok := e.(*exec.ExitError); ok && exit.ExitCode() > 0 {
			finish(exit.ExitCode())
		}
		finish(1)
	}
	finish(0)
}

// Every way a running transaction can lose its deployer or transport cancels
// the whole transaction on the target. Its shells and builds inherit the host
// lock's descriptor, so the lock comes free only once none of them survives to
// build or cycle later.
func TestDeployCancellationStopsWorkAndPreservesLoginUmask(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"ssh", "runner-term", "helper-term", "helper-kill", "deployer-int", "deployer-kill", "local"} {
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			host := "fake"
			if how == "local" {
				host = "local"
			}
			cmd, log := f.startHost(t, "cancel-"+how, host)
			deployAwait(t, "build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
			holder := f.lockHolder(t)
			switch how {
			case "ssh", "runner-term":
				pidFile := "ssh.pid"
				if how == "runner-term" {
					pidFile = "remote.pid"
				}
				pid, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, pidFile))))
				sig := syscall.SIGKILL
				if how == "runner-term" {
					sig = syscall.SIGTERM
				}
				syscall.Kill(pid, sig)
			case "deployer-kill":
				cmd.Process.Kill()
			case "helper-term":
				syscall.Kill(holder, syscall.SIGTERM)
			case "helper-kill":
				syscall.Kill(holder, syscall.SIGKILL)
			case "deployer-int", "local":
				cmd.Process.Signal(syscall.SIGINT)
			}
			if e := f.deployWait(t, cmd); e == nil {
				t.Fatalf("cancel reported success: %s", fleetRead(log))
			}
			deployAwait(t, "cancelled transaction to release the host lock", func() bool { return f.lockFree(t) })
			if !strings.Contains(fleetRead(f.events), "umask 0027") {
				t.Fatalf("login umask changed: %s", fleetRead(f.events))
			}
			if _, e := os.Stat(filepath.Join(f.home, ".shuttle/deploy/runs")); !os.IsNotExist(e) {
				t.Fatalf("run records retained: %v", e)
			}
		})
	}
}

// lockHolder is the pid of the lock helper holding the host lock, the leader
// of its transaction's process group.
func (f *deployFleet) lockHolder(t *testing.T) int {
	t.Helper()
	info := fleetRead(filepath.Join(f.home, ".shuttle/deploy.lock"))
	var pid, pgid int
	if i := strings.Index(info, "; pid="); i < 0 {
		t.Fatalf("missing holder: %q; events=%s", info, fleetRead(f.events))
	} else if _, e := fmt.Sscanf(info[i:], "; pid=%d; pgid=%d;", &pid, &pgid); e != nil || pid != pgid {
		t.Fatalf("holder %q: pid %d pgid %d %v", info, pid, pgid, e)
	}
	return pid
}

func TestDeploySSHPreflightIsBoundedAndRetainsStderr(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	cmd, log := f.start(t, "ssh-preflight", "FAIL_SSH_PREFLIGHT=1")
	if e := f.deployWait(t, cmd); e == nil {
		t.Fatal("failed SSH preflight succeeded")
	}
	if !strings.Contains(fleetRead(log), "preflight-ssh-stderr-token") {
		t.Fatalf("unbounded preflight or missing native stderr: %s", fleetRead(log))
	}
	if strings.Contains(fleetRead(log), "attached transaction;") {
		t.Fatal("transaction started after failed SSH preflight")
	}
}

func TestDeployBootstrapFailureReportsStepAndCleansWorkspace(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "failed-bootstrap", "FAIL_LOCK_BUILD=1")
	if err := f.deployWait(t, cmd); err == nil {
		t.Fatal("bootstrap failure accepted")
	}
	got := fleetRead(log)
	if !strings.Contains(got, "bootstrap-stderr-token") || !strings.Contains(got, "compile lock helper: failed (exit 42)") {
		t.Fatalf("missing failed step/stderr: %s", got)
	}
	entries, err := os.ReadDir(filepath.Join(f.home, ".shuttle/deploy/tools"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("bootstrap workspace leaked: %v", entries)
	}
}

func TestDeployFirstPinnedTreeSeedsRegularCheckoutCaches(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	for _, relative := range []string{"daemon/deps/package/cache", "daemon/_build/prod/cache", "ui/node_modules/package/cache"} {
		path := filepath.Join(f.repo, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("warm"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "deploy_root_cmd") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + shellFunction(t, string(script), "revision_checkout_cmd") + `revision_checkout_cmd "$SOURCE" "$SOURCE.deploy/$TARGET_COMMIT" | bash -eu`
	cmd := exec.Command("bash", "-c", harness)
	cmd.Env = append(f.env, "SOURCE="+f.repo, "TARGET_COMMIT="+f.sha)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("prepare: %v %s", err, out)
	}
	t.Logf("preparation: %s", out)
	for _, relative := range []string{"daemon/deps/package/cache", "daemon/_build/prod/cache", "ui/node_modules/package/cache"} {
		if got := fleetRead(filepath.Join(f.repo+".deploy", f.sha, relative)); got != "warm" {
			t.Fatalf("regular checkout cache %s not seeded: %q", relative, got)
		}
	}
}

func TestDeployRevisionPreparationRepairsInterruptedTrees(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	tree := filepath.Join(f.repo+".deploy", f.sha)
	if err := os.MkdirAll(tree, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "partial"), []byte("interrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "deploy_root_cmd") + shellFunction(t, string(script), "seed_deploy_cache_cmd") + shellFunction(t, string(script), "revision_checkout_cmd") + `revision_checkout_cmd "$SOURCE" | bash -eu`
	run := func() {
		t.Helper()
		cmd := exec.Command("bash", "-c", harness)
		cmd.Env = append(f.env, "SOURCE="+f.repo, "TARGET_COMMIT="+f.sha)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("repair partial tree: %v %s", err, out)
		}
		if got := f.git(t, tree, "rev-parse", "HEAD"); got != f.sha {
			t.Fatalf("wrong repaired tree: %s", got)
		}
	}
	run()
	if err := os.Remove(filepath.Join(tree, ".git")); err != nil {
		t.Fatal(err)
	}
	run()
	if err := os.WriteFile(filepath.Join(tree, "tracked"), []byte("partial checkout"), 0600); err != nil {
		t.Fatal(err)
	}
	run()
	if got := fleetRead(filepath.Join(tree, "tracked")); got != "target\n" {
		t.Fatalf("partial tracked contents survived: %q", got)
	}
	f.git(t, f.repo, "worktree", "lock", tree)
	if err := os.RemoveAll(tree); err != nil {
		t.Fatal(err)
	}
	run()
}

// A remote daemon that never proves a ready boot within the forwarded
// readiness timeout fails the host before quarantine release and pruning.
// scripts/test-shuttle-deploy.sh holds each launch hold to the same refusal.
func TestDeployRemoteVerificationFailureHoldsReleaseAndPruning(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "remote-booting", "BOOTING_LAUNCHER=1", "CHECK_POLL=1", "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0")
	if err := f.deployWait(t, cmd); err == nil || !strings.Contains(fleetRead(log), "is still booting after") {
		t.Fatalf("remote timeout override lost: %v %s", err, fleetRead(log))
	}
	if events := fleetRead(f.events); strings.Contains(events, "poll-interval") || strings.Contains(events, "release\n") || strings.Contains(events, "prune\n") {
		t.Fatalf("unverified deployment waited, released or pruned: %s", events)
	}
}

func TestDeployRemotePreflightRejectsUnpublishedAndImplicitRollback(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"unpublished", "behind"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			fleetTouch(t, f.gate)
			if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("newer"), 0600); err != nil {
				t.Fatal(err)
			}
			f.git(t, f.repo, "commit", "-am", "newer")
			if kind == "behind" {
				f.git(t, f.repo, "push")
				f.git(t, f.repo, "reset", "--hard", f.sha)
			}
			cmd, log := f.startHost(t, kind, "local,fake")
			if err := f.deployWait(t, cmd); err == nil {
				t.Fatalf("unsafe default deploy accepted: %s", fleetRead(log))
			}
			if got := fleetRead(f.events); got != "" {
				t.Fatalf("preflight touched a host: %s\n%s", got, fleetRead(log))
			}
		})
	}
}

func TestDeployFailureNamesHostAndStep(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "failed", "FAIL_BUILD=1")
	if err := f.deployWait(t, cmd); err == nil {
		t.Fatalf("failed build reported success: %s", fleetRead(log))
	}
	if got := fleetRead(log); !strings.Contains(got, "fake: build/install CLIs: failed") || !strings.Contains(got, "failed: fake") {
		t.Fatalf("failure lacks host/step: %s", got)
	}
	if got := fleetRead(f.events); strings.Contains(got, "cycle") || strings.Contains(got, "release") {
		t.Fatalf("failed build changed daemon: %s", got)
	}
}

func TestDeployLocalDefaultsToStableRootFromLinkedWorktree(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	main := f.repo
	linked := filepath.Join(f.root, "linked-work")
	f.git(t, main, "worktree", "add", "-b", "work", linked)
	f.repo = linked
	fleetTouch(t, f.gate)
	cmd, log := f.startHost(t, "local-linked", "local")
	if err := f.deployWait(t, cmd); err != nil {
		t.Fatalf("local deploy: %v %s", err, fleetRead(log))
	}
	canonical, err := filepath.EvalSymlinks(main)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(canonical+".deploy", f.sha, "bin", "rel")
	if got := fleetRead(f.state); !strings.Contains(got, want) || strings.Contains(got, linked) {
		t.Fatalf("local release is not the stable pinned root %s: %s", want, got)
	}
	if got := f.git(t, linked, "branch", "--show-current"); got != "work" {
		t.Fatalf("linked branch changed: %s", got)
	}
}

func TestDeployCycleUsesExactlyOneOwner(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	for _, owner := range []string{"tmux", "1", "0", "migrated"} {
		t.Run(owner, func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{filepath.Join(root, "bin", "rel"), filepath.Join(root, "home", ".local", "bin"), filepath.Join(root, "home", ".shuttle")} {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(root, "bin", "shuttle-launch"), []byte("#!/bin/sh\necho restart\n"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "shuttle"), []byte("#!/bin/sh\nshift 4\nexec \"$@\"\n"), 0755); err != nil {
				t.Fatal(err)
			}
			harness := `
supervisor_probe_cmd() { printf 'echo %s' "$OWNER"; }
listen_prelude() { printf 'dd="$HOME/.shuttle"; '; }
daemon_listener_cmd() { printf ':'; }
disable_competing_supervisors_cmd() { :; }
daemon_kill() { printf 'echo listener-kill'; }
respawn_launcher_restart_cmd() { printf 'echo restart'; }
run_local() { bash -c "$1"; }
activation_window() { run_local "$1"; }
bad() { echo "$*" >&2; }
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "built_release") + shellFunction(t, string(script), "remote_host_cycle") + `remote_host_cycle "$ROOT" ''`
			cmd := exec.Command("bash", "-c", harness)
			cmd.Env = append(os.Environ(), "ROOT="+root, "HOME="+filepath.Join(root, "home"), "OWNER="+owner)
			if owner == "migrated" {
				cmd.Env = append(cmd.Env, "SHUTTLE_ACTIVATION_CYCLED=1")
			}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("cycle: %v %s", err, out)
			}
			want := "restart\n"
			if owner == "tmux" {
				want = "listener-kill\n"
			}
			if owner == "0" {
				want = "listener-kill\nrestart\n"
			}
			if owner == "migrated" {
				want = ""
			}
			if string(out) != want {
				t.Fatalf("owner %s cycle=%q, want %q", owner, out, want)
			}
		})
	}
}
