package shuttlecli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// versionBody is a daemon's /api/v1/version answer.
func versionBody(host, version string, level int) http.HandlerFunc {
	return jsonBody(fmt.Sprintf(`{"host":%q,"mix_vsn":%q,"contract_level":%d}`, host, version, level))
}

// receiptBody is a daemon's /api/v1/version answer carrying its receipt of
// the CLIs beside it: skewed when they report cliLevel instead of level.
func receiptBody(host, version string, level, cliLevel int) http.HandlerFunc {
	ok, reason := "true", "null"
	if cliLevel != level {
		ok, reason = "false", fmt.Sprintf(`"expected contract level %d, CLI reports %d"`, level, cliLevel)
	}
	return jsonBody(fmt.Sprintf(`{"host":%q,"mix_vsn":%q,"contract_level":%d,"contract":{"expected":%d,"observed":%d,"ok":%s,"reason":%s}}`,
		host, version, level, level, cliLevel, ok, reason))
}

// A fiber message goes through the local daemon to the fiber's owner. A
// local daemon built for another contract than this CLI, or an owner whose
// receipt says its own CLIs are skewed, would queue it without delivering it,
// so the CLI refuses before sending, names the daemon, and sends nothing. An
// owner at another level than this CLI but level with its own CLIs delivers,
// as does one whose answer carries no receipt.
func TestFiberMessageRefusesADaemonBuiltForAnotherContract(t *testing.T) {
	t.Parallel()
	older := ShuttleContractLevel - 1
	for _, tc := range []struct {
		name       string
		want       string
		localLevel int
		owner      http.HandlerFunc
	}{
		{name: "stale local daemon", localLevel: ShuttleContractLevel - 11, owner: receiptBody("worker-node", "2.0.0", ShuttleContractLevel, ShuttleContractLevel),
			want: fmt.Sprintf("the Shuttle daemon on this host runs 2.0.0 (CLI contract %d) and this shuttle is 2.1.0 (CLI contract %d)", ShuttleContractLevel-11, ShuttleContractLevel)},
		{name: "skewed owner", localLevel: ShuttleContractLevel, owner: receiptBody("worker-node", "2.0.0", older, ShuttleContractLevel),
			want: fmt.Sprintf("worker-node's Shuttle daemon runs 2.0.0 (CLI contract %d) and reports its CLIs skewed (expected contract level %d, CLI reports %d)", older, older, ShuttleContractLevel)},
		{name: "owner level with its own older CLIs", localLevel: ShuttleContractLevel, owner: receiptBody("worker-node", "2.0.0", older, older)},
		{name: "owner without a receipt", localLevel: ShuttleContractLevel, owner: versionBody("worker-node", "1.4.0", 0)},
		{name: "both level", localLevel: ShuttleContractLevel, owner: receiptBody("worker-node", "2.1.0", ShuttleContractLevel, ShuttleContractLevel)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			store := writeMessageTargetFiber(t, map[string]any{
				"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
			})
			isolateMessageFiberStore(env, store)
			deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"delivery":"context","queued":true,"status":"woken"}`)
			daemonStub(t, env, map[string]http.HandlerFunc{
				"/api/v1/version": func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Query().Get("origin") == "worker-node" {
						tc.owner(w, r)
						return
					}
					versionBody("hub", "2.0.0", tc.localLevel)(w, r)
				},
				"/api/v1/deliver": deliver,
			})
			app := newApp(env)
			app.version = "2.1.0"
			stdout, _, err := runMessage(t, app, "work/worker", "hello")
			if tc.want == "" {
				if err != nil || len(requests()) != 1 || !strings.Contains(stdout, "woken") {
					t.Fatalf("a level daemon must deliver: err=%v stdout=%q requests=%v", err, stdout, requests())
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "without delivering") {
				t.Fatalf("message error = %v, want refusal naming %q", err, tc.want)
			}
			if len(requests()) != 0 {
				t.Fatalf("a refused message must not reach /deliver: %v", requests())
			}
		})
	}
}

// A daemon whose version answer predates the contract receipt is stale too.
func TestFiberMessageRefusesADaemonWithoutAContractLevel(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "hub", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"queued":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": jsonBody(`{"host":"hub","mix_vsn":"1.4.0"}`),
		"/api/v1/deliver": deliver,
	})
	_, _, err := runMessage(t, newApp(env), "work/worker", "hello")
	if err == nil || !strings.Contains(err.Error(), "1.4.0, which reports no CLI contract level") || len(requests()) != 0 {
		t.Fatalf("message error = %v, requests = %v", err, requests())
	}
}

// On a host whose daemon a checkout builds, a level bump installs the CLIs
// before the deploy activates the daemon, so the refusal says the deploy in
// progress brings it level.
func TestFiberMessageOnACheckoutBuiltHostWaitsForTheDeploy(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "hub", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	release := checkoutRelease(t)
	fakeRelease(t, release, "2.1.0")
	env.Set("SHUTTLE_RELEASE", release)
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"queued":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": versionBody("hub", "2.1.0", ShuttleContractLevel-1),
		"/api/v1/deliver": deliver,
	})
	_, _, err := runMessage(t, newApp(env), "work/worker", "hello")
	if err == nil || !strings.Contains(err.Error(), "A deploy in progress brings it level when it finishes") || !strings.Contains(err.Error(), "bin/shuttle-deploy --hosts local") || len(requests()) != 0 {
		t.Fatalf("message error = %v, requests = %v", err, requests())
	}
}

// checkoutRelease is the path of a release built inside a fresh checkout,
// one that holds the daemon's daemon/mix.exs.
func checkoutRelease(t *testing.T) string {
	t.Helper()
	checkout := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(filepath.Join(checkout, "daemon"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "daemon", "mix.exs"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(checkout, "bin", "rel")
}

// fakeRelease writes a daemon release whose launcher reports version.
func fakeRelease(t *testing.T, dir, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in version) echo \"shuttled %s\";; eval) echo %s;; *) exit 2;; esac\n", version, version)
	if err := os.WriteFile(filepath.Join(dir, "bin", "shuttled"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// unreachableDaemon points env at a daemon address nothing answers.
func unreachableDaemon(t *testing.T, env interface{ Set(string, string) }) {
	t.Helper()
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
}

func TestDaemonCheckSaysHowTheDaemonDiffersFromTheseCLIs(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		running   http.HandlerFunc
		installed string
		want      []string
	}{
		{name: "running stale daemon", running: versionBody("hub", "2.0.0", ShuttleContractLevel-11),
			want: []string{fmt.Sprintf("The Shuttle daemon running on this host is 2.0.0 (CLI contract %d); these CLIs are 2.1.0 (CLI contract %d).", ShuttleContractLevel-11, ShuttleContractLevel), "Until they match, `shuttle message <fiber>` refuses and messages already waiting in a fiber's inbox are not delivered.", "Bring it level: shuttle daemon upgrade\n"}},
		{name: "running daemon at another version of this contract", running: versionBody("hub", "2.1.1", ShuttleContractLevel),
			want: []string{fmt.Sprintf("is 2.1.1 (CLI contract %d); these CLIs are 2.1.0", ShuttleContractLevel), "Bring it level: shuttle daemon upgrade\n"}},
		{name: "running level daemon", running: versionBody("hub", "2.1.0", ShuttleContractLevel)},
		{name: "stopped stale release", installed: "2.0.0",
			want: []string{"is 2.0.0; these CLIs are 2.1.0.\nBring it level before starting it: shuttle daemon upgrade\n"}},
		{name: "stopped level release", installed: "2.1.0"},
		{name: "no daemon"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			if tc.running != nil {
				daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/version": tc.running})
			} else {
				unreachableDaemon(t, env)
			}
			if tc.installed != "" {
				release := filepath.Join(t.TempDir(), "share", "shuttle")
				fakeRelease(t, release, tc.installed)
				env.Set("SHUTTLE_RELEASE", release)
			}
			app := newApp(env)
			app.version = "2.1.0"
			stdout, _, err := executeApp(t, app, "", "daemon", "check")
			if err != nil {
				t.Fatal(err)
			}
			if len(tc.want) == 0 && stdout != "" {
				t.Fatalf("a matching or absent daemon must print nothing, got %q", stdout)
			}
			for _, want := range tc.want {
				if !strings.Contains(stdout, want) {
					t.Fatalf("daemon check = %q, want it to contain %q", stdout, want)
				}
			}
		})
	}
}

// A daemon a checkout built reports its source version, which says nothing
// about these CLIs: daemon check compares only its contract level, and a
// skewed one is brought level by a deploy from that checkout. The selected
// release the CLI would find elsewhere does not decide it.
func TestDaemonCheckJudgesACheckoutBuiltDaemonByItsContract(t *testing.T) {
	t.Parallel()
	release := checkoutRelease(t)
	for _, tc := range []struct {
		name  string
		level int
		want  string
	}{
		{name: "level contract", level: ShuttleContractLevel},
		{name: "skewed contract", level: ShuttleContractLevel - 1, want: "Bring it level: bin/shuttle-deploy --hosts local, from the checkout that built " + release + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/version": jsonBody(fmt.Sprintf(
				`{"host":"hub","mix_vsn":"0.1.0","contract_level":%d,"release_path":%q}`, tc.level, release))})
			env.Set("SHUTTLE_RELEASE", filepath.Join(t.TempDir(), "absent"))
			app := newApp(env)
			app.version = "2.1.1"
			stdout, _, err := executeApp(t, app, "", "daemon", "check")
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "" && stdout != "" || !strings.Contains(stdout, tc.want) {
				t.Fatalf("daemon check = %q, want %q", stdout, tc.want)
			}
		})
	}
}

// shuttle doctor names the command daemon check names for a checkout-built
// daemon at another contract: a deploy from the checkout that built it.
func TestDoctorNamesTheDeployForACheckoutBuiltDaemon(t *testing.T) {
	t.Parallel()
	release := checkoutRelease(t)
	env := testEnv(t)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/version": jsonBody(fmt.Sprintf(
		`{"ready":true,"release_path":%q,"contract":{"expected":%d,"observed":%d,"ok":true}}`, release, ShuttleContractLevel-1, ShuttleContractLevel-1))})
	env.Set("SHUTTLE_RELEASE", filepath.Join(t.TempDir(), "absent"))
	got := newApp(env).collectDaemonReceipt()
	if want := "bin/shuttle-deploy --hosts local, from the checkout that built " + release; !strings.Contains(got.Repair, want) {
		t.Fatalf("doctor repair = %q, want it to contain %q", got.Repair, want)
	}
}

// releaseArchive is a daemon release archive whose launcher reports version.
func releaseArchive(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in version) echo \"shuttled %s\";; eval) echo %s;; *) exit 2;; esac\n", version, version)
	for _, entry := range []struct {
		name string
		mode int64
		body string
	}{{"shuttled/", 0o755, ""}, {"shuttled/bin/", 0o755, ""}, {"shuttled/bin/shuttled", 0o755, script}, {"shuttled/bin/shuttle-launch", 0o755, "#!/bin/sh\n# launch " + version + "\n"}} {
		hdr := &tar.Header{Name: entry.name, Mode: entry.mode, Size: int64(len(entry.body)), Typeflag: tar.TypeReg}
		if strings.HasSuffix(entry.name, "/") {
			hdr.Typeflag = tar.TypeDir
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDaemonUpgradeReplacesTheFetchedReleaseWithThisVersion(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, archived, want, home string
		replaced, socket           bool
	}{
		{name: "verified", archived: "2.1.0", want: "installed daemon 2.1.0", home: "share/shuttle", replaced: true},
		{name: "no daemon socket", archived: "2.1.0", want: "installed daemon 2.1.0", home: "share/shuttle", replaced: true, socket: true},
		{name: "installed under a bin directory", archived: "2.1.0", want: "installed daemon 2.1.0", home: "bin/shuttled", replaced: true},
		{name: "mismatched archive", archived: "2.9.9", want: `reports version "2.9.9", expected 2.1.0`, home: "share/shuttle"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			if tc.socket {
				env.Unset("SHUTTLE_DAEMON_URL")
				env.Set("SHUTTLE_LISTEN", "unix://"+filepath.Join(shortPrivateTempDir(t), "absent.sock"))
			} else {
				unreachableDaemon(t, env)
			}
			release := filepath.Join(t.TempDir(), filepath.FromSlash(tc.home))
			fakeRelease(t, release, "2.0.0")
			env.Set("SHUTTLE_RELEASE", release)
			archive := releaseArchive(t, tc.archived)
			asset := fmt.Sprintf("/v2.1.0/shuttled_%s_%s.tar.gz", feltcli.ArchiveOS(), feltcli.ArchiveArch())
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != asset {
					http.NotFound(w, r)
					return
				}
				_, _ = w.Write(archive)
			}))
			t.Cleanup(server.Close)
			app := newApp(env)
			app.version, app.releaseDownloadBase = "2.1.0", server.URL
			stdout, _, err := executeApp(t, app, "", "daemon", "upgrade")
			got := stdout
			if err != nil {
				got = err.Error()
			}
			if !strings.Contains(got, tc.want) {
				t.Fatalf("upgrade = %q (err %v), want %q", stdout, err, tc.want)
			}
			wantVersion := "2.0.0"
			if tc.replaced {
				wantVersion = "2.1.0"
				if !strings.Contains(stdout, "no daemon is running; `shuttle daemon start` starts this release; the release it replaced is kept at ") || !strings.Contains(stdout, filepath.FromSlash(tc.home)+".previous\n") {
					t.Fatalf("upgrade with no daemon running must say how to start it and where the replaced release is: %q", stdout)
				}
				home, _ := env.UserHomeDir()
				if launch, err := os.ReadFile(filepath.Join(home, ".local", "bin", "shuttle-launch")); err != nil || !strings.Contains(string(launch), "launch 2.1.0") {
					t.Fatalf("upgrade must install the release's shuttle-launch as the installer does: %q %v", launch, err)
				}
			}
			if got := app.releaseVersion(daemonRelease{Dir: release, Launcher: filepath.Join(release, "bin", "shuttled")}); got != wantVersion {
				t.Fatalf("release reports %q after upgrade, want %q", got, wantVersion)
			}
			if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(release), ".shuttled-upgrade-*")); len(leftovers) != 0 {
				t.Fatalf("upgrade left %v behind", leftovers)
			}
			// No daemon has run the new release yet, so the replaced one stays.
			previous, _ := filepath.Glob(release + ".previous")
			if len(previous) != 0 != tc.replaced {
				t.Fatalf("replaced release kept = %v, want %v", previous, tc.replaced)
			}
		})
	}
}

// A release a checkout built is deployed from that checkout, never replaced
// by a downloaded archive.
func TestDaemonUpgradeLeavesACheckoutBuiltRelease(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	unreachableDaemon(t, env)
	release := checkoutRelease(t)
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	var fetched atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	_, _, err := executeApp(t, app, "", "daemon", "upgrade")
	if err == nil || !strings.Contains(err.Error(), "bin/shuttle-deploy --hosts local") || fetched.Load() {
		t.Fatalf("upgrade of a checkout-built release = %v (fetched %v)", err, fetched.Load())
	}
}

// A daemon that nothing restarts after the upgrade stopped it fails the
// upgrade, naming the command that starts it and the replaced release, which
// is kept.
func TestDaemonUpgradeFailsWhenNothingRestartsTheDaemon(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	daemon := daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/version": versionBody("hub", "2.0.0", ShuttleContractLevel-1)})
	// The listener the upgrade stops is the stub's, owned by this test, and
	// the stop's signal goes nowhere.
	env.Set("SHUTTLE_PORT", daemon.URL[strings.LastIndex(daemon.URL, ":")+1:])
	sysenvtest.FakeCommand(t, env, "lsof", fmt.Sprintf("#!/bin/sh\necho %d\n", os.Getpid()))
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	archive := releaseArchive(t, "2.1.0")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(archive) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	app.daemonPause = func(time.Duration) {}
	app.daemonSignalPID = func(int, syscall.Signal) error { return nil }
	_, _, err := executeApp(t, app, "", "daemon", "upgrade")
	if err == nil || !strings.Contains(err.Error(), "`shuttle daemon start`, which runs in the foreground, then `shuttle daemon release`") || !strings.Contains(err.Error(), release+".previous") {
		t.Fatalf("upgrade with nothing to restart the daemon = %v, want a failure naming the start command, that it runs in the foreground, the release that follows, and the kept release", err)
	}
	if got := app.releaseVersion(daemonRelease{Launcher: filepath.Join(release+".previous", "bin", "shuttled")}); got != "2.0.0" {
		t.Fatalf("the replaced release must be kept, reports %q", got)
	}
}

// With no daemon running, a daemon start during the download is refused, so
// a supervisor's retry starts the new release; the upgrade never swaps a
// release under a daemon it did not see.
func TestDaemonUpgradeHoldsTheOwnerClaimThroughTheSwap(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	unreachableDaemon(t, env)
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	archive := releaseArchive(t, "2.1.0")
	app := newApp(env)
	var startErr error
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		settings, err := app.resolveHostSettings()
		if err != nil {
			t.Error(err)
			return
		}
		var releaseClaim func()
		if releaseClaim, startErr = app.claimDaemonOwner(settings, 0, nil); startErr == nil {
			releaseClaim()
		}
		_, _ = w.Write(archive)
	}))
	t.Cleanup(server.Close)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	if _, _, err := executeApp(t, app, "", "daemon", "upgrade"); err != nil {
		t.Fatal(err)
	}
	if startErr == nil || !strings.Contains(startErr.Error(), "already claimed") {
		t.Fatalf("a daemon start during the download = %v, want it refused", startErr)
	}
	settings, _ := app.resolveHostSettings()
	releaseClaim, err := app.claimDaemonOwner(settings, 0, nil)
	if err != nil {
		t.Fatalf("a daemon start after the upgrade = %v, want the claim free", err)
	}
	releaseClaim()
}

// A daemon that holds the ownership claim but is not yet listening is
// starting: the upgrade fails before replacing anything.
func TestDaemonUpgradeFailsWhileADaemonStarts(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	unreachableDaemon(t, env)
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	var fetched atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	settings, err := app.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	releaseClaim, err := app.claimDaemonOwner(settings, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseClaim()
	_, _, err = executeApp(t, app, "", "daemon", "upgrade")
	if err == nil || !strings.Contains(err.Error(), "a daemon is starting") || fetched.Load() {
		t.Fatalf("upgrade while a daemon starts = %v (fetched %v), want a failure before the download", err, fetched.Load())
	}
}

// An upgrade that replaces nothing needs no claim, so a daemon starting on
// the release already in place does not fail it.
func TestDaemonUpgradeAtThisVersionIgnoresAStartingDaemon(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	unreachableDaemon(t, env)
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.1.0")
	env.Set("SHUTTLE_RELEASE", release)
	var fetched atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	settings, err := app.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	releaseClaim, err := app.claimDaemonOwner(settings, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseClaim()
	if _, _, err := executeApp(t, app, "", "daemon", "upgrade"); err != nil || fetched.Load() {
		t.Fatalf("upgrade at this version while a daemon starts = %v (fetched %v), want success with nothing fetched", err, fetched.Load())
	}
}

// On a cluster sharing HOME, the release belongs to the login node that
// ~/.shuttle/owner-node names: an upgrade from another node replaces nothing.
func TestDaemonUpgradeRefusesAnotherOwnerNodesRelease(t *testing.T) {
	t.Parallel()
	for _, installed := range []string{"2.0.0", "2.1.0"} {
		env := testEnv(t)
		unreachableDaemon(t, env)
		release := filepath.Join(t.TempDir(), "share", "shuttle")
		fakeRelease(t, release, installed)
		env.Set("SHUTTLE_RELEASE", release)
		ownerFile := filepath.Join(t.TempDir(), "owner-node")
		if err := os.WriteFile(ownerFile, []byte("login-elsewhere\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		env.Set("SHUTTLE_OWNER_NODE_FILE", ownerFile)
		var fetched atomic.Bool
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
		t.Cleanup(server.Close)
		app := newApp(env)
		app.version, app.releaseDownloadBase = "2.1.0", server.URL
		_, _, err := executeApp(t, app, "", "daemon", "upgrade")
		if err == nil || !strings.Contains(err.Error(), `login node "login-elsewhere" (`+ownerFile+`)`) || fetched.Load() {
			t.Fatalf("upgrade from another node with %s installed = %v (fetched %v), want a refusal before the download", installed, err, fetched.Load())
		}
	}
}

// A daemon that is listening but does not answer fails the upgrade before
// anything is downloaded or replaced; only a refused connection means no
// daemon runs.
func TestDaemonUpgradeFailsBeforeTheSwapWhenTheDaemonDoesNotAnswer(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/version": func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}})
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	var fetched atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	_, _, err := executeApp(t, app, "", "daemon", "upgrade")
	if err == nil || !strings.Contains(err.Error(), "the daemon's version could not be read") || fetched.Load() {
		t.Fatalf("upgrade with a daemon that does not answer = %v (fetched %v), want a failure before the swap", err, fetched.Load())
	}
	if got := app.releaseVersion(daemonRelease{Launcher: filepath.Join(release, "bin", "shuttled")}); got != "2.0.0" {
		t.Fatalf("the release must stay in place, reports %q", got)
	}
}

// The upgrade's help says plainly when the replaced release is kept.
func TestDaemonUpgradeHelpSaysWhenTheReplacedReleaseIsKept(t *testing.T) {
	t.Parallel()
	long := strings.Join(strings.Fields(newApp(testEnv(t)).daemonUpgradeCmd().Long), " ")
	if want := "The replaced release is kept at <release>.previous unless the upgrade sees a daemon running the new one."; !strings.Contains(long, want) {
		t.Fatalf("upgrade help = %q, want it to contain %q", long, want)
	}
}

// A download that stalls fails the upgrade once its time is up.
func TestDaemonUpgradeDownloadTimesOut(t *testing.T) {
	saved := releaseDownloadTimeout
	releaseDownloadTimeout = 200 * time.Millisecond
	t.Cleanup(func() { releaseDownloadTimeout = saved })
	env := testEnv(t)
	unreachableDaemon(t, env)
	release := filepath.Join(t.TempDir(), "share", "shuttle")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	stall := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-stall
	}))
	t.Cleanup(func() { close(stall); server.Close() })
	app := newApp(env)
	app.version, app.releaseDownloadBase = "2.1.0", server.URL
	done := make(chan error, 1)
	go func() {
		_, _, err := executeApp(t, app, "", "daemon", "upgrade")
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stalled download must fail the upgrade")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a stalled download hung the upgrade")
	}
}
