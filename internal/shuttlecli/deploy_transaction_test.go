package shuttlecli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// Fleet fixtures compile helpers and launch whole shell trees. Bound their
// process fanout alongside the package's parallel, short-deadline hook tests.
var deployFleetSlots = make(chan struct{}, 2)

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
	for _, relative := range []string{"bin/shuttle-deploy", "scripts/deploy-lock/main.go", "scripts/deploy-run.sh"} {
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
sha=$(git -C "${TEST_RELEASE%/bin/rel}" rev-parse HEAD)
printf '{"git_short_sha":"%.7s","git_sha":"%s","release_path":"%s","booted_at":"2099-01-01T00:00:00Z","ready":true}\n' "$sha" "$sha" "$TEST_RELEASE" > "$STATE"
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
	write(filepath.Join(f.bin, "bash"), "#!/bin/sh\ncase \"$1\" in\n-lc) shift; LOGIN_CODE=$1; export LOGIN_CODE; shift; exec '"+realBash+"' --noprofile -l -c '. \"$HOME/.bash_profile\"; eval \"$LOGIN_CODE\"' \"$@\";;\nesac\nexec '"+realBash+"' \"$@\"\n")
	realRm, err := exec.LookPath("rm")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.bin, "rm"), `#!/bin/sh
if [ "${CHECK_CLEANUP_ORDER:-0}" = 1 ]; then
 case "$*" in *"/.shuttle/deploy/tools/lock."*)
 pid=$(sed -n 's/.*; pid=\([0-9]*\);.*/\1/p' "$HOME/.shuttle/deploy.lock")
 if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo cleanup-before-helper-exit >&2; exit 41; fi;;
 esac
fi
exec `+shellQuote(realRm)+` "$@"
`)
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.bin, "go"), "#!/bin/sh\nif [ \"${FAIL_LOCK_BUILD:-0}\" = 1 ] && [ \"${TEST_REMOTE:-0}\" = 1 ]; then echo 'bootstrap-stderr-token' >&2; exit 42; fi\nif [ \"${CHECK_LOCK_BUILD:-0}\" = 1 ]; then\n [ \"$1\" = build ] && [ \"$GOMAXPROCS\" = 2 ] && [ \"$GOFLAGS\" = -p=2 ] || { echo 'uncapped lock bootstrap' >&2; exit 31; }\n case \"$3\" in \"$HOME\"/.shuttle/deploy/tools/*/lock) ;; *) echo 'lock executable depends on tmp mount' >&2; exit 32;; esac\nfi\nexec '"+realGo+"' \"$@\"\n")
	realSleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.bin, "sleep"), "#!/bin/sh\nif [ \"${CHECK_POLL:-0}\" = 1 ] && [ -f \"$FLEET_ROOT/readiness-observed\" ]; then\n echo \"poll-interval $1\" >> \"$EVENTS\"\n sed 's/\"ready\":false/\"ready\":true/' \"$STATE\" > \"$STATE.next\"; mv \"$STATE.next\" \"$STATE\"\nelse exec '"+realSleep+"' \"$@\"; fi\n")
	cache, err := exec.Command(realGo, "env", "GOCACHE").Output()
	if err != nil {
		t.Fatal(err)
	}
	f.env = append(f.env, "GOCACHE="+strings.TrimSpace(string(cache)))
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(f.bin, "ssh"), `#!/bin/sh
echo ssh >> "$EVENTS"
echo $$ > "$FLEET_ROOT/ssh.pid"
for option in ConnectTimeout=15 ServerAliveInterval=15 ServerAliveCountMax=3; do
 case "$*" in *"$option"*) ;; *) echo "missing SSH bound: $option" >&2; exit 94;; esac
done
if [ "${SSH_GATE:-0}" = 1 ]; then touch "$FLEET_ROOT/ssh-entered"; while [ ! -f "$FLEET_ROOT/ssh-go" ]; do sleep .02; done; fi
while :; do case "${1:-}" in -o) shift 2;; -n) shift;; *) break;; esac; done
shift
if [ "${FAIL_SSH_PREFLIGHT:-0}" = 1 ] && [ "$*" = true ]; then echo preflight-ssh-stderr-token >&2; exit 255; fi
# Real SSH joins arguments, then the remote shell parses that command. The
# isolated login shim sources this fixture's profile and preserves stderr.
exec /usr/bin/env -i TEST_REMOTE=1 SHUTTLE_TEST_SSH_HELPER=1 SHUTTLE_TEST_GO_CACHES_PINNED=1 HOME="$HOME" PATH="$PATH" GOCACHE="$GOCACHE" GOTOOLCHAIN=local \
 FAKE_BIN="$FAKE_BIN" FLEET_ROOT="$FLEET_ROOT" EVENTS="$EVENTS" STATE="$STATE" BUILD_GATE="$BUILD_GATE" \
 CHECK_CLEANUP_ORDER="${CHECK_CLEANUP_ORDER:-0}" FAIL_LOCK_BUILD="${FAIL_LOCK_BUILD:-0}" FAIL_BUILD="${FAIL_BUILD:-0}" BACKGROUND_LAUNCHER="${BACKGROUND_LAUNCHER:-0}" CHECK_LOCK_BUILD="${CHECK_LOCK_BUILD:-0}" \
 ACTIVATION_GATE="${ACTIVATION_GATE:-0}" CHECK_REAL_PRUNE="${CHECK_REAL_PRUNE:-0}" CHECK_OLD_PRUNE="${CHECK_OLD_PRUNE:-0}" PI_CHECKOUT="${PI_CHECKOUT:-}" BOOTING_LAUNCHER="${BOOTING_LAUNCHER:-0}" CHECK_POLL="${CHECK_POLL:-0}" `+shellQuote(testBinary)+` -test.run=^TestDeploySSHHelperProcess$ -- "$*"
`)
	write(filepath.Join(f.bin, "make"), `#!/bin/sh
case "$1" in
 build)
  echo "umask $(umask)" >> "$EVENTS"
  echo "build $(git rev-parse HEAD) $*" >> "$EVENTS"
  touch "$FLEET_ROOT/build-entered"
  while [ ! -f "$BUILD_GATE" ]; do sleep .02; done
  [ "${FAIL_BUILD:-0}" != 1 ] || exit 13
  mkdir -p bin/rel
  if [ "${2:-}" = SKIP_UI=1 ]; then
    [ -f ui/dist/index.html ] || exit 17
  else
    mkdir -p ui/dist
    echo '<html>pinned bundle</html>' > ui/dist/index.html
  fi
  cp "$FAKE_BIN/shuttle" ./shuttle
  ;;
 ui) mkdir -p ui/dist; echo bundle > ui/dist/index.html ;;
 cli-install) : ;;
 *) exit 19 ;;
esac
`)
	write(filepath.Join(f.bin, "rsync"), `#!/bin/sh
previous=
for arg in "$@"; do source="$previous"; previous="$arg"; done
dest="${previous#*:}"
printf 'rsync %s %s\n' "$source" "$dest" >> "$EVENTS"
if [ -d "$source" ]; then mkdir -p "$dest"; cp -R "$source/." "$dest/"
else mkdir -p "$(dirname "$dest")"; cp "$source" "$dest"; fi
`)
	write(filepath.Join(f.bin, "build-wrapper"), "#!/bin/sh\necho wrapper >> \"$EVENTS\"\nexec \"$@\"\n")
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
	write(filepath.Join(f.bin, "curl"), `#!/bin/sh
if grep -q '"ready":false' "$STATE"; then touch "$FLEET_ROOT/readiness-observed"; fi
cat "$STATE"
`)
	for name, body := range map[string]string{"systemctl": "exit 1", "launchctl": "exit 1", "lsof": "exit 0", "pi": "exit 0"} {
		write(filepath.Join(f.bin, name), "#!/bin/sh\n"+body+"\n")
	}
	write(filepath.Join(f.bin, "pi"), `#!/bin/sh
if [ -n "${PI_CHECKOUT:-}" ]; then
 echo "pi-inspect $(git -C "$PI_CHECKOUT" rev-parse HEAD)" >> "$EVENTS"
 printf '  %s\n    %s\n' "$PI_CHECKOUT" "$PI_CHECKOUT"
fi
`)
	// No listener PID can ever reach xargs/kill; the fake returns an empty list.
	write(f.state, `{"git_short_sha":"0000000","release_path":"/old","ready":true,"booted_at":"2026-01-01T00:00:00Z"}`)
	f.env = append(append(os.Environ(), f.env...), "HOME="+f.home, "PATH="+f.bin+":"+os.Getenv("PATH"), "FAKE_BIN="+f.bin, "FLEET_ROOT="+f.root, "EVENTS="+f.events, "STATE="+f.state, "BUILD_GATE="+f.gate, "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0", "SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1", "SHUTTLE_AGENTS_FILE="+filepath.Join(f.root, "absent"), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
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

func TestDeployCallerScriptIsImmutableDuringCheckoutEdits(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	cmd, log := f.start(t, "caller-edited")
	deployAwait(t, "build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	replacement := strings.Repeat("# replacement bytes\n", 10000) + "printf 'mutated caller executed\\n' >&2; exit 66\n"
	if err := os.WriteFile(filepath.Join(f.repo, "bin/shuttle-deploy"), []byte(replacement), 0755); err != nil {
		t.Fatal(err)
	}
	fleetTouch(t, f.gate)
	if err := cmd.Wait(); err != nil {
		t.Fatalf("caller changed during deployment: %v %s", err, fleetRead(log))
	}
	if strings.Contains(fleetRead(log), "mutated caller executed") {
		t.Fatal("running deploy read changed script bytes")
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
	fleetTouch(t, f.gate)
	deploy, log := f.start(t, "quoted-paths")
	if err := deploy.Wait(); err != nil {
		t.Fatalf("quoted-path deployment: %v %s", err, fleetRead(log))
	}
}

func TestDeployBootstrapCleanupWaitsForHelperExit(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "cleanup-order", "CHECK_CLEANUP_ORDER=1")
	if err := cmd.Wait(); err != nil {
		t.Fatalf("deploy: %v %s", err, fleetRead(log))
	}
	if strings.Contains(fleetRead(log), "cleanup-before-helper-exit") {
		t.Fatalf("NFS executable cleaned before helper exit: %s", fleetRead(log))
	}
	entries, err := os.ReadDir(filepath.Join(f.home, ".shuttle/deploy/tools"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("bootstrap workspace leaked: %v %v", entries, err)
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
	os.WriteFile(filepath.Join(os.Getenv("FLEET_ROOT"), "remote.pid"), []byte(strconv.Itoa(remote.Process.Pid)), 0600)
	go func() { io.Copy(w, os.Stdin); w.Close() }()
	if e = remote.Wait(); e != nil {
		if exit, ok := e.(*exec.ExitError); ok && exit.ExitCode() > 0 {
			finish(exit.ExitCode())
		}
		finish(1)
	}
	finish(0)
}

func TestDeployCancellationStopsWorkAndPreservesLoginUmask(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"ssh", "runner-term", "helper-term", "helper-kill", "deployer-int", "deployer-kill", "deadline", "local"} {
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			host := "fake"
			if how == "local" {
				host = "local"
			}
			var extra []string
			if how == "deadline" {
				extra = []string{"SHUTTLE_DEPLOY_TIMEOUT_SECONDS=30"}
			}
			cmd, log := f.startHost(t, "cancel-"+how, host, extra...)
			deployAwait(t, "build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
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
			case "helper-term", "helper-kill":
				info := fleetRead(filepath.Join(f.home, ".shuttle/deploy.lock"))
				if !strings.Contains(info, "; pid=") {
					t.Fatalf("missing holder in %s: %q; events=%s log=%s", f.home, info, fleetRead(f.events), fleetRead(log))
				}
				start := strings.Index(info, "; pid=") + 6
				end := strings.Index(info[start:], ";")
				pid, _ := strconv.Atoi(info[start : start+end])
				sig := syscall.SIGTERM
				if how == "helper-kill" {
					sig = syscall.SIGKILL
				}
				syscall.Kill(pid, sig)
			case "deployer-int", "local":
				cmd.Process.Signal(syscall.SIGINT)
			}
			if e := cmd.Wait(); e == nil {
				t.Fatalf("cancel reported success: %s", fleetRead(log))
			}
			deployAwait(t, "lock free: "+log, func() bool {
				file, e := os.OpenFile(filepath.Join(f.home, ".shuttle/deploy.lock"), os.O_RDWR, 0600)
				if e != nil {
					return false
				}
				defer file.Close()
				return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
			})
			fleetTouch(t, f.gate)
			next, nextlog := f.startHost(t, "after-"+how, host)
			if e := next.Wait(); e != nil {
				t.Fatalf("next deploy: %v %s", e, fleetRead(nextlog))
			}
			if n := strings.Count(fleetRead(f.events), "cycle\n"); n != 1 {
				t.Fatalf("cancelled deployment later cycled: %d %s", n, fleetRead(f.events))
			}
			if !strings.Contains(fleetRead(f.events), "umask 0027") {
				t.Fatalf("login umask changed: %s", fleetRead(f.events))
			}
			if _, e := os.Stat(filepath.Join(f.home, ".shuttle/deploy/runs")); !os.IsNotExist(e) {
				t.Fatalf("run records retained: %v", e)
			}
		})
	}
}

func TestDeployKilledWaiterNeverAcquiresAfterHolder(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	holder, log := f.start(t, "holder")
	deployAwait(t, "holder build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	if e := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("second target"), 0600); e != nil {
		t.Fatal(e)
	}
	f.git(t, f.repo, "add", "tracked")
	f.git(t, f.repo, "commit", "-m", "second target")
	f.git(t, f.repo, "push", "origin", "main")
	waiter, waitlog := f.start(t, "waiter")
	deployAwait(t, "waiter: "+waitlog, func() bool { return strings.Contains(fleetRead(waitlog), "waiting for") })
	waiter.Process.Kill()
	if e := waiter.Wait(); e == nil {
		t.Fatal("killed waiter succeeded")
	}
	deployAwait(t, "cancelled waiter: "+waitlog, func() bool {
		return strings.Contains(fleetRead(waitlog), "observer EOF")
	})
	fleetTouch(t, f.gate)
	if e := holder.Wait(); e != nil {
		t.Fatalf("holder %v: %s", e, fleetRead(log))
	}
	if builds := strings.Count(fleetRead(f.events), "build "); builds != 1 {
		t.Fatalf("forgotten waiter ran later: %s", fleetRead(f.events))
	}
}

func TestDeploySSHPreflightIsBoundedAndRetainsStderr(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	cmd, log := f.start(t, "ssh-preflight", "FAIL_SSH_PREFLIGHT=1")
	if e := cmd.Wait(); e == nil {
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
	if err := cmd.Wait(); err == nil {
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

func TestDeployCommitRefDoesNotPushAnObjectAsABranch(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd := exec.Command("bash", filepath.Join(f.repo, "bin/shuttle-deploy"), "--hosts", "fake", "--ref", f.sha[:8])
	cmd.Env = f.env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("commit ref deployment: %v %s", err, out)
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

func TestDeployCoalescingRetainsActualRollbackTree(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	f.env = append(f.env, "CHECK_REAL_PRUNE=1")
	run := func(name string) {
		t.Helper()
		cmd, log := f.start(t, name)
		if err := cmd.Wait(); err != nil {
			t.Fatalf("deploy: %v %s", err, fleetRead(log))
		}
	}
	run("first-target")
	previous := f.sha
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("next"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "next")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	run("next-target")
	run("coalesced-target")
	if _, err := os.Stat(filepath.Join(f.remote+".deploy", previous)); err != nil {
		t.Fatalf("coalesced deploy pruned true rollback tree: %v", err)
	}
}

func TestDeployForwardsRemoteReadinessOverrides(t *testing.T) {
	t.Parallel()
	for _, timeout := range []string{"0", "30"} {
		t.Run(timeout, func(t *testing.T) {
			f := newDeployFleet(t)
			fleetTouch(t, f.gate)
			cmd, log := f.start(t, "remote-ready", "BOOTING_LAUNCHER=1", "CHECK_POLL=1", "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS="+timeout, "SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1")
			err := cmd.Wait()
			if timeout == "0" {
				if err == nil || !strings.Contains(fleetRead(log), "is still booting after") || strings.Contains(fleetRead(f.events), "poll-interval") {
					t.Fatalf("remote timeout override lost: %v %s", err, fleetRead(log))
				}
			} else if err != nil || !strings.Contains(fleetRead(f.events), "poll-interval 1\n") {
				t.Fatalf("remote poll override lost: %v %s %s", err, fleetRead(log), fleetRead(f.events))
			}
		})
	}
}

func TestDeployRefreshesCheckoutAfterReleaseBeforePiInspection(t *testing.T) {
	t.Parallel()
	for _, dirty := range []bool{false, true} {
		t.Run(fmt.Sprint(dirty), func(t *testing.T) {
			f := newDeployFleet(t)
			fleetTouch(t, f.gate)
			old := f.sha
			if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new"), 0600); err != nil {
				t.Fatal(err)
			}
			f.git(t, f.repo, "commit", "-am", "new")
			f.git(t, f.repo, "push")
			f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
			extra := []string{"PI_CHECKOUT=" + f.remote}
			if dirty {
				if err := os.WriteFile(filepath.Join(f.remote, "tracked"), []byte("my edits"), 0600); err != nil {
					t.Fatal(err)
				}
				extra = nil
			}
			cmd, log := f.start(t, "fresh-checkout", extra...)
			if err := cmd.Wait(); err != nil {
				t.Fatalf("deploy: %v %s", err, fleetRead(log))
			}
			got := f.git(t, f.remote, "rev-parse", "HEAD")
			if !dirty && got != f.sha {
				t.Fatalf("regular checkout stayed stale: %s", got)
			}
			if dirty && (got != old || !strings.Contains(fleetRead(log), "checkout freshness: left")) {
				t.Fatalf("dirty checkout not preserved/advised: %s %s", got, fleetRead(log))
			}
			if !dirty {
				events := fleetRead(f.events)
				if strings.Index(events, "release\n") > strings.Index(events, "pi-inspect "+f.sha) || !strings.Contains(events, "pi-inspect "+f.sha) {
					t.Fatalf("Pi inspected before release/freshness: %s", events)
				}
			}
		})
	}
}

func TestDeployRollbackDoesNotExposeLeasesToOldPruners(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.startArgs(t, "old-pruner", "fake", []string{"--ref", f.sha}, "CHECK_OLD_PRUNE=1")
	if err := cmd.Wait(); err != nil {
		t.Fatalf("rollback: %v %s", err, fleetRead(log))
	}
	if _, err := os.Stat(filepath.Join(f.remote+".deploy", ".leases")); !os.IsNotExist(err) {
		t.Fatalf("lease metadata exposed to old pruner: %v", err)
	}
}

func TestDeployLockBootstrapIsBoundedAndHomeHosted(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "bounded-bootstrap", "CHECK_LOCK_BUILD=1")
	if err := cmd.Wait(); err != nil {
		t.Fatalf("lock bootstrap: %v %s", err, fleetRead(log))
	}
}

func TestDeployLauncherCannotRetainTransactionLocks(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "background-launcher", "BACKGROUND_LAUNCHER=1")
	if err := cmd.Wait(); err != nil {
		t.Fatalf("deploy: %v %s", err, fleetRead(log))
	}
	lock, err := os.OpenFile(filepath.Join(f.home, ".shuttle", "deploy.lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("finished deploy's background launcher retained host lock: %v", err)
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

func TestDeployRemotePreflightRejectsUnpublishedAndImplicitRollback(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"unpublished", "behind"} {
		t.Run(kind, func(t *testing.T) {
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
			if err := cmd.Wait(); err == nil {
				t.Fatalf("unsafe default deploy accepted: %s", fleetRead(log))
			}
			if got := fleetRead(f.events); got != "" {
				t.Fatalf("preflight touched a host: %s\n%s", got, fleetRead(log))
			}
			if kind == "behind" {
				cmd, log = f.startArgs(t, "explicit-rollback", "fake", []string{"--ref", f.sha})
				if err := cmd.Wait(); err != nil {
					t.Fatalf("explicit rollback refused: %v %s", err, fleetRead(log))
				}
			}
		})
	}
}

func TestDeployPinsDefaultRevisionWhenMainMoves(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd, log := f.start(t, "moving-main", "SSH_GATE=1")
	deployAwait(t, "target resolved", func() bool { _, err := os.Stat(filepath.Join(f.root, "ssh-entered")); return err == nil })
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "main moved")
	newer := f.git(t, f.repo, "rev-parse", "HEAD")
	f.git(t, f.repo, "push")
	fleetTouch(t, filepath.Join(f.root, "ssh-go"))
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

func TestDeployLocalDefaultsToStableRootFromLinkedWorktree(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	main := f.repo
	linked := filepath.Join(f.root, "linked-work")
	f.git(t, main, "worktree", "add", "-b", "work", linked)
	f.repo = linked
	fleetTouch(t, f.gate)
	cmd, log := f.startHost(t, "local-linked", "local")
	if err := cmd.Wait(); err != nil {
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

func TestDeployShipsPinnedUISnapshotBeforeWrappedBuild(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	fleet := fmt.Sprintf(`{"remotes":[{"name":"fake","ssh":"fake","checkout":%q,"build_ui":false,"build_wrap":"build-wrapper"}]}`, f.remote)
	if err := os.WriteFile(filepath.Join(f.root, "remotes.json"), []byte(fleet), 0600); err != nil {
		t.Fatal(err)
	}
	cmd, log := f.start(t, "shipped-ui")
	if err := cmd.Wait(); err != nil {
		t.Fatalf("shipped deploy: %v %s", err, fleetRead(log))
	}
	events := fleetRead(f.events)
	ship, wrap, build := strings.Index(events, "rsync "), strings.Index(events, "wrapper\n"), strings.Index(events, "build "+f.sha+" build SKIP_UI=1")
	if ship < 0 || wrap <= ship || build <= wrap {
		t.Fatalf("UI must ship before the wrapped build: %s", events)
	}
	if got := fleetRead(filepath.Join(f.remote+".deploy", f.sha, "ui", "dist", "index.html")); strings.TrimSpace(got) != "bundle" {
		t.Fatalf("wrong shipped bundle: %q", got)
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
run_on() { bash -c "$2"; }
run_on_visible() { bash -c "$2"; }
run_value() { run_on_visible "$@"; }
activation_window() { run_on_visible "$@"; }
bad() { echo "$*" >&2; }
` + shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "remote_host_cycle") + `remote_host_cycle '' "$ROOT"`
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
