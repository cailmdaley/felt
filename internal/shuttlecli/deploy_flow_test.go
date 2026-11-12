package shuttlecli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// A whole remote deployment costs seconds of process launches, so each fleet
// run below proves every property its path can carry at once. The fakes also
// hold some on every run: transaction SSH must be batch-only and bounded, and
// the lock helper must build capped, inside its own module, under the home.

// One remote deployment of a commit the remote checkout has not reached,
// with every successful-path hazard switched on: a login profile that prints
// and reads stdin, main moving after the target resolves, the caller's own
// script edited mid-run, a remote that ships its UI and wraps its build, a
// booting daemon, a busy Poller, a launcher that leaves a background process,
// and a Pi package in the regular checkout.
func TestDeployRemoteTransaction(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleet := fmt.Sprintf(`{"remotes":[{"name":"fake","ssh":"fake","checkout":%q,"build_ui":false,"build_wrap":"build-wrapper"}]}`, f.remote)
	if err := os.WriteFile(filepath.Join(f.root, "remotes.json"), []byte(fleet), 0600); err != nil {
		t.Fatal(err)
	}
	profile := `umask 027
shopt -q login_shell || exit 77
printf 'profile stdout notice'
printf 'profile stderr notice\n' >&2
read -r ignored || :
[ -z "$ignored" ] || exit 78
export LOGIN_PROFILE_LOADED=yes
`
	if err := os.WriteFile(filepath.Join(f.home, ".bash_profile"), []byte(profile), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "new")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	t.Cleanup(func() {
		if pid, err := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "background.pid")))); err == nil {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	})

	cmd, log := f.start(t, "remote", "SSH_GATE=1", "CHECK_CLEANUP_ORDER=1", "BACKGROUND_LAUNCHER=1",
		"RELEASE_BUSY_ONCE=1", "SHUTTLE_DEPLOY_RELEASE_RETRY_SECONDS=0",
		"BOOTING_LAUNCHER=1", "CHECK_POLL=1", "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=30",
		"PI_CHECKOUT="+f.remote)
	deployAwait(t, "target resolved: "+log, func() bool { _, err := os.Stat(filepath.Join(f.root, "ssh-entered")); return err == nil })
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("main moved\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "main moved")
	newer := f.git(t, f.repo, "rev-parse", "HEAD")
	f.git(t, f.repo, "push")
	fleetTouch(t, filepath.Join(f.root, "ssh-go"))
	deployAwait(t, "build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	replacement := strings.Repeat("# replacement bytes\n", 10000) + "printf 'mutated caller executed\\n' >&2; exit 66\n"
	if err := os.WriteFile(filepath.Join(f.repo, "bin/shuttle-deploy"), []byte(replacement), 0755); err != nil {
		t.Fatal(err)
	}
	fleetTouch(t, f.gate)
	if err := f.deployWait(t, cmd); err != nil {
		t.Fatalf("deploy: %v %s", err, fleetRead(log))
	}

	out, events := fleetRead(log), fleetRead(f.events)
	for _, bad := range []string{"mutated caller executed", "cleanup-before-helper-exit"} {
		if strings.Contains(out, bad) {
			t.Fatalf("%s: %s", bad, out)
		}
	}
	if !strings.Contains(events, "build "+f.sha+" build SKIP_UI=1") || strings.Contains(events, newer) || !strings.Contains(fleetRead(f.state), f.sha) {
		t.Fatalf("moving main changed the target: %s", events)
	}
	if ship, wrap, build := strings.Index(events, "rsync "), strings.Index(events, "wrapper\n"), strings.Index(events, "build "+f.sha); ship < 0 || wrap <= ship || build <= wrap {
		t.Fatalf("UI must ship before the wrapped build: %s", events)
	}
	if got := fleetRead(filepath.Join(f.remote+".deploy", f.sha, "ui", "dist", "index.html")); strings.TrimSpace(got) != "bundle" {
		t.Fatalf("wrong shipped bundle: %q", got)
	}
	if strings.Count(events, "cycle\n") != 1 || !strings.Contains(events, "poll-interval 1\n") {
		t.Fatalf("booting daemon not polled at the forwarded interval: %s", events)
	}
	if _, err := os.Stat(filepath.Join(f.root, "release-busy")); err != nil {
		t.Fatalf("busy Poller never answered: %v", err)
	}
	if got := f.git(t, f.remote, "rev-parse", "HEAD"); got != f.sha {
		t.Fatalf("regular checkout not fast-forwarded to the target: %s", got)
	}
	if release, inspect := strings.Index(events, "release\n"), strings.Index(events, "pi-inspect "+f.sha); release < 0 || inspect < release {
		t.Fatalf("Pi inspected before release and checkout refresh: %s", events)
	}
	if pid, err := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "background.pid")))); err != nil || pid <= 0 {
		t.Fatalf("background launcher did not run: %v", err)
	}
	if !f.lockFree(t) {
		t.Fatal("finished deploy's background launcher retained the host lock")
	}
	if entries, err := os.ReadDir(filepath.Join(f.home, ".shuttle/deploy/tools")); err != nil || len(entries) != 0 {
		t.Fatalf("bootstrap workspace leaked: %v %v", entries, err)
	}
}

// A host's deployments over time: a new target and a re-run that coalesces
// without cycling. Both keep the true rollback tree, and a dirty regular
// checkout is never moved.
func TestDeployRollbackLifecycle(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	f.env = append(f.env, "CHECK_REAL_PRUNE=1")
	run := func(name string, args ...string) string {
		t.Helper()
		cmd, log := f.startArgs(t, name, "fake", args)
		if err := f.deployWait(t, cmd); err != nil {
			t.Fatalf("%s: %v %s", name, err, fleetRead(log))
		}
		return fleetRead(log)
	}
	run("first")
	first := f.sha
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("next"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "next")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(f.remote, "tracked"), []byte("my edits"), 0600); err != nil {
		t.Fatal(err)
	}
	if log := run("next"); !strings.Contains(log, "checkout freshness: left") {
		t.Fatalf("dirty checkout not advised: %s", log)
	}
	if got := f.git(t, f.remote, "rev-parse", "HEAD"); got != first {
		t.Fatalf("dirty checkout moved: %s", got)
	}
	if log := run("coalesced"); !strings.Contains(log, "coalescing without a daemon cycle") {
		t.Fatalf("re-run did not coalesce: %s", log)
	}
	if n := strings.Count(fleetRead(f.events), "cycle\n"); n != 2 {
		t.Fatalf("cycles = %d, want 2: %s", n, fleetRead(f.events))
	}
	if _, err := os.Stat(filepath.Join(f.remote+".deploy", first)); err != nil {
		t.Fatalf("coalesced deploy pruned the true rollback tree: %v", err)
	}

}

// An explicit revision named by abbreviated commit deploys with push on: a
// commit is not a ref to push, and lease metadata stays where an older
// target's pruner cannot take it for a worktree.
func TestDeployExplicitCommitRevision(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	cmd := exec.Command("bash", filepath.Join(f.repo, "bin/shuttle-deploy"), "--hosts", "fake", "--ref", f.sha[:8])
	cmd.Env = append(f.env, "CHECK_OLD_PRUNE=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("explicit revision: %v %s", err, out)
	}
	if !strings.Contains(fleetRead(f.state), f.sha) {
		t.Fatalf("explicit revision not live: %s", fleetRead(f.state))
	}
	if _, err := os.Stat(filepath.Join(f.remote+".deploy", ".leases")); !os.IsNotExist(err) {
		t.Fatalf("lease metadata exposed to old pruner: %v", err)
	}
}

// One host lock, one holder and a queue of waiters, each leaving the queue a
// different way. A waiter for the same target coalesces after the holder
// without a second build or cycle; it names the holder while it waits and
// cannot overwrite the holder's log. Rollback waiters whose deployer is killed,
// or whose observer stops answering its heartbeat, never acquire the lock.
func TestDeployHostLockQueue(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	defer fleetTouch(t, f.gate)
	old := f.sha
	if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new target\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.repo, "commit", "-am", "new target")
	f.git(t, f.repo, "push")
	f.sha = f.git(t, f.repo, "rev-parse", "HEAD")
	waiting := func(log string) func() bool {
		return func() bool { return strings.Contains(fleetRead(log), "deploy-lock: waiting for") }
	}

	holder, holderLog := f.start(t, "holder")
	deployAwait(t, "holder build: "+holderLog, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	last := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
	before, err := os.Stat(last)
	if err != nil {
		t.Fatal(err)
	}

	// The waiters queue concurrently; each run's remote shell records its pid
	// under its FLEET_RUN name.
	second, secondLog := f.start(t, "second", "FLEET_RUN=second")
	killed, killedLog := f.startArgs(t, "killed", "fake", []string{"--ref", old}, "FLEET_RUN=killed")
	stopped, stoppedLog := f.startArgs(t, "stopped", "fake", []string{"--ref", old}, "FLEET_RUN=stopped", "SHUTTLE_DEPLOY_HEARTBEAT_LEASE_SECONDS=2")
	for _, log := range []string{secondLog, killedLog, stoppedLog} {
		deployAwait(t, "waiting: "+log, waiting(log))
	}
	if log := fleetRead(secondLog); !strings.Contains(log, "deployer=") || !strings.Contains(log, "target="+f.sha) {
		t.Fatalf("holder not named: %s", log)
	}
	if after, err := os.Stat(last); err != nil || !os.SameFile(before, after) || !strings.Contains(fleetRead(last), "build/install CLIs") {
		t.Fatalf("waiting attempt overwrote the holder's diagnostics: %v", err)
	}

	killed.Process.Kill()
	if err := f.deployWait(t, killed); err == nil {
		t.Fatal("killed waiter succeeded")
	}

	var observer int
	for _, line := range strings.Split(fleetRead(stoppedLog), "\n") {
		if _, err := fmt.Sscanf(line, "deploy-lock: transaction pgid=%d", &observer); err == nil {
			break
		}
	}
	remote, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "remote.stopped.pid"))))
	if observer <= 0 || remote <= 0 {
		t.Fatalf("missing observer %d or remote %d identity", observer, remote)
	}
	defer syscall.Kill(observer, syscall.SIGKILL)
	if err := syscall.Kill(observer, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	deployAwait(t, "killed waiter cancelled: "+killedLog, func() bool { return strings.Contains(fleetRead(killedLog), "observer EOF") })
	deployAwait(t, "stopped observer's waiter to expire its heartbeat lease", func() bool { return syscall.Kill(remote, 0) != nil })
	syscall.Kill(observer, syscall.SIGCONT)
	if err := f.deployWait(t, stopped); err == nil {
		t.Fatalf("stopped observer reported success: %s", fleetRead(stoppedLog))
	}

	fleetTouch(t, f.gate)
	for name, cmd := range map[string]*exec.Cmd{holderLog: holder, secondLog: second} {
		if err := f.deployWait(t, cmd); err != nil {
			t.Fatalf("%v: %s", err, fleetRead(name))
		}
	}
	events := fleetRead(f.events)
	if strings.Count(events, "build ") != 1 || strings.Count(events, "cycle\n") != 1 || strings.Count(events, "release\n") != 2 {
		t.Fatalf("queued deploy events: %s", events)
	}
	if !strings.Contains(fleetRead(secondLog), "coalescing without a daemon cycle") {
		t.Fatalf("coalescing not reported: %s", fleetRead(secondLog))
	}
	if !strings.Contains(fleetRead(f.state), f.sha) {
		t.Fatalf("abandoned waiter rolled back: %s", fleetRead(f.state))
	}
}

func (f *deployFleet) lockFree(t *testing.T) bool {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(f.home, ".shuttle/deploy.lock"), os.O_RDWR, 0600)
	if err != nil {
		return false
	}
	defer file.Close()
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}
