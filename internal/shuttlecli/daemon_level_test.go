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
	"testing"

	"github.com/cailmdaley/felt/internal/feltcli"
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
	release := filepath.Join(t.TempDir(), "repo", "bin", "rel")
	fakeRelease(t, release, "3.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"queued":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": versionBody("hub", "3.0.0", ShuttleContractLevel-1),
		"/api/v1/deliver": deliver,
	})
	_, _, err := runMessage(t, newApp(env), "work/worker", "hello")
	if err == nil || !strings.Contains(err.Error(), "A deploy in progress brings it level when it finishes") || !strings.Contains(err.Error(), "bin/shuttle-deploy --hosts local") || len(requests()) != 0 {
		t.Fatalf("message error = %v, requests = %v", err, requests())
	}
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
			want: []string{fmt.Sprintf("The Shuttle daemon running on this host is 2.0.0 (CLI contract %d); these CLIs are 3.0.0 (CLI contract %d).", ShuttleContractLevel-11, ShuttleContractLevel), "messages to live workers are queued and not delivered", "Bring it level: shuttle daemon upgrade\n"}},
		{name: "running daemon at another version of this contract", running: versionBody("hub", "3.0.1", ShuttleContractLevel),
			want: []string{fmt.Sprintf("is 3.0.1 (CLI contract %d); these CLIs are 3.0.0", ShuttleContractLevel), "Bring it level: shuttle daemon upgrade\n"}},
		{name: "running level daemon", running: versionBody("hub", "3.0.0", ShuttleContractLevel)},
		{name: "stopped stale release", installed: "2.0.0",
			want: []string{"is 2.0.0; these CLIs are 3.0.0.\nBring it level before starting it: shuttle daemon upgrade\n"}},
		{name: "stopped level release", installed: "3.0.0"},
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
			app.version = "3.0.0"
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
		name, archived, want string
		replaced             bool
	}{
		{name: "verified", archived: "3.0.0", want: "installed daemon 3.0.0", replaced: true},
		{name: "mismatched archive", archived: "2.9.9", want: `reports version "2.9.9", expected 3.0.0`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			unreachableDaemon(t, env)
			release := filepath.Join(t.TempDir(), "share", "shuttle")
			fakeRelease(t, release, "2.0.0")
			env.Set("SHUTTLE_RELEASE", release)
			archive := releaseArchive(t, tc.archived)
			asset := fmt.Sprintf("/v3.0.0/shuttled_%s_%s.tar.gz", feltcli.ArchiveOS(), feltcli.ArchiveArch())
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != asset {
					http.NotFound(w, r)
					return
				}
				_, _ = w.Write(archive)
			}))
			t.Cleanup(server.Close)
			app := newApp(env)
			app.version, app.releaseDownloadBase = "3.0.0", server.URL
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
				wantVersion = "3.0.0"
				if !strings.Contains(stdout, "no daemon is running; `shuttle daemon start` starts this release") {
					t.Fatalf("upgrade with no daemon running must say how to start it: %q", stdout)
				}
				home, _ := env.UserHomeDir()
				if launch, err := os.ReadFile(filepath.Join(home, ".local", "bin", "shuttle-launch")); err != nil || !strings.Contains(string(launch), "launch 3.0.0") {
					t.Fatalf("upgrade must install the release's shuttle-launch as the installer does: %q %v", launch, err)
				}
			}
			if got := app.releaseVersion(daemonRelease{Dir: release, Launcher: filepath.Join(release, "bin", "shuttled")}); got != wantVersion {
				t.Fatalf("release reports %q after upgrade, want %q", got, wantVersion)
			}
			leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(release), ".shuttled-upgrade-*"))
			if previous, _ := filepath.Glob(release + ".previous"); len(leftovers)+len(previous) != 0 {
				t.Fatalf("upgrade left %v %v behind", leftovers, previous)
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
	release := filepath.Join(t.TempDir(), "repo", "bin", "rel")
	fakeRelease(t, release, "2.0.0")
	env.Set("SHUTTLE_RELEASE", release)
	var fetched atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Store(true) }))
	t.Cleanup(server.Close)
	app := newApp(env)
	app.version, app.releaseDownloadBase = "3.0.0", server.URL
	_, _, err := executeApp(t, app, "", "daemon", "upgrade")
	if err == nil || !strings.Contains(err.Error(), "bin/shuttle-deploy --hosts local") || fetched.Load() {
		t.Fatalf("upgrade of a checkout-built release = %v (fetched %v)", err, fetched.Load())
	}
}
