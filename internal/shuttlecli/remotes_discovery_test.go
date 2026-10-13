package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

const tailnetPeersFixtureDir = "../../daemon/test/fixtures/tailnet_peers"

// tailnetPeersFixture is one daemon/test/fixtures/tailnet_peers/*.json case.
// The Elixir suite runs discovery from status and probes to `discovered`, then
// both suites resolve `remotes` with `discovered` to `resolved`.
type tailnetPeersFixture struct {
	Remotes    json.RawMessage     `json:"remotes"`
	Discovered []discoveredPeer    `json:"discovered"`
	Resolved   []resolvedRemoteRow `json:"resolved"`
}

type resolvedRemoteRow struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Source string `json:"source"`
	SSH    string `json:"ssh"`
	Port   int    `json:"port"`
}

func TestResolveRemotes_SharedFixtures(t *testing.T) {
	t.Parallel()
	paths, err := filepath.Glob(filepath.Join(tailnetPeersFixtureDir, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no tailnet peer fixtures: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			t.Parallel()
			a := newApp(testEnv(t))
			content, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture tailnetPeersFixture
			if err := json.Unmarshal(content, &fixture); err != nil {
				t.Fatal(err)
			}
			doc := remotesFile{Version: 1}
			if len(fixture.Remotes) > 0 && string(fixture.Remotes) != "null" {
				if doc, err = parseRemotesDocument(fixture.Remotes); err != nil {
					t.Fatal(err)
				}
			}
			if err := a.normalizeRemotes(&doc); err != nil {
				t.Fatal(err)
			}

			got := []resolvedRemoteRow{}
			for _, r := range a.resolveRemotes(doc, fixture.Discovered) {
				got = append(got, resolvedRemoteRow{Name: r.Name, URL: r.URL, Source: r.Source, SSH: r.SSH, Port: r.Port})
			}
			if !reflect.DeepEqual(got, fixture.Resolved) {
				t.Fatalf("resolved\n got %+v\nwant %+v", got, fixture.Resolved)
			}
		})
	}
}

func TestAdmitDiscovered_TakesDocumentDefaults(t *testing.T) {
	t.Parallel()
	a := newApp(testEnv(t))
	doc, err := parseRemotesDocument([]byte(`{"defaults":{"request_timeout_ms":9000},"remotes":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.normalizeRemotes(&doc); err != nil {
		t.Fatal(err)
	}
	got := a.admitDiscovered(doc, []discoveredPeer{{Name: "hub-a", URL: "https://hub-a.example.ts.net"}})
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	if got[0].RequestTimeoutMS != 9000 || got[0].tunnelOpts().Manager != "none" || got[0].SSH != "" {
		t.Fatalf("discovered peer = %+v, want the document's timeout, no tunnel and no ssh", got[0])
	}
}

// serveDiscovery stands env's local daemon up, its /api/v1/version reporting
// the given discovery block.
func serveDiscovery(t *testing.T, env *sysenv.Env, discovery string, fleet ...string) {
	t.Helper()
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/fleet": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if len(fleet) == 0 {
				_, _ = w.Write([]byte(`{"remotes":[]}`))
				return
			}
			_, _ = w.Write([]byte(fleet[0]))
		},
		"/api/v1/version": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ready":true,"host":"hub-self","discovery":` + discovery + `}`))
		},
	})
}

// remotesList runs a's `remotes list` command and returns what it printed.
func remotesList(t *testing.T, a *app) string {
	t.Helper()
	streams := sysenvtest.Capture(a.env)
	cmd := a.remotesListCmd()
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatal(err)
	}
	return streams.Stdout.String()
}

func TestRemotesList_ShowsDiscoveredPeersWithSource(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeRemotesIn(t, env, `{"version":1,"remotes":[
	  {"name":"hub-n","ssh":"hub-n-login","port":4005},
	  {"name":"hub-b","url":"https://hub-b.example.ts.net","enabled":false}
	]}`)
	serveDiscovery(t, env, `{"enabled":true,"state":"ok","via":"cli","peers":[
	  {"name":"hub-a","url":"https://hub-a.example.ts.net"},
	  {"name":"hub-b","url":"https://hub-b.example.ts.net"}
	]}`)

	a := newApp(env)
	out := remotesList(t, a)
	if !strings.Contains(out, "tailnet discovery via cli: 2 peer(s)") {
		t.Fatalf("missing discovery summary:\n%s", out)
	}
	for _, want := range []string{"SOURCE", "hub-n", "hub-a", "discovered", "configured"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q:\n%s", want, out)
		}
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "hub-b") && !strings.Contains(line, "disabled") {
			t.Fatalf("hub-b should appear once, as the disabled configured entry: %q", line)
		}
	}

	remotes, err := a.resolvedRemotes()
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, r := range remotes {
		names = append(names, r.Name+"/"+r.Source)
	}
	if want := []string{"hub-n/configured", "hub-a/discovered"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("resolved = %v, want %v", names, want)
	}
}

func TestRemotesList_DaemonUnreachableListsConfiguredOnly(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeRemotesIn(t, env, `{"version":1,"remotes":[{"name":"hub-n","port":4005}]}`)

	out := remotesList(t, newApp(env))
	if !strings.Contains(out, "no discovered peers from the daemon") || !strings.Contains(out, "showing configured remotes only") {
		t.Fatalf("missing unreachable note:\n%s", out)
	}
	if !strings.Contains(out, "hub-n") || !strings.Contains(out, "REACH") || !strings.HasSuffix(strings.TrimSpace(out), "?") {
		t.Fatalf("configured entry or unknown reach missing:\n%s", out)
	}
	a := newApp(env)
	a.json = true
	var listing struct {
		Remotes []map[string]any `json:"remotes"`
	}
	if err := json.Unmarshal([]byte(remotesList(t, a)), &listing); err != nil {
		t.Fatal(err)
	}
	row := listing.Remotes[0]
	for _, key := range []string{"health", "build"} {
		if value, ok := row[key]; !ok || value != nil {
			t.Fatalf("unknown %s = %v (present %v)", key, value, ok)
		}
	}
}

func TestRemotesList_ReportsDaemonReachAndPreservesObservations(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeRemotesIn(t, env, `{"remotes":[{"name":"hub-stale","port":4005},{"name":"hub-unpolled","port":4006},{"name":"hub-unknown","port":4007}]}`)
	const healthy = `{"polled":true,"stale":false,"last_error":null,"last_polled_at":"2026-01-02T00:00:00Z","recovery":{"state":"healthy","attempt":0},"future_field":42}`
	const build = `{"git_short_sha":"abc123","booted_at":"2026-01-01T00:00:00Z","future_field":"kept"}`
	serveDiscovery(t, env, `{"state":"ok","via":"localapi","peers":[{"name":"hub-healthy","url":"https://hub-healthy.example.ts.net"}]}`, `{"remotes":[
  {"name":"hub-healthy","health":`+healthy+`,"build":`+build+`},
  {"name":"hub-stale","health":{"polled":true,"stale":true,"last_error":"dial timeout"},"build":null},
  {"name":"hub-unpolled","health":{"polled":false,"stale":true},"build":null}
 ]}`)
	a := newApp(env)
	out := remotesList(t, a)
	for name, want := range map[string]string{"hub-healthy": "healthy abc123 up ", "hub-stale": "stale dial timeout", "hub-unpolled": "unpolled", "hub-unknown": "?"} {
		found := false
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, name+" ") {
				found = strings.Contains(line, want)
			}
		}
		if !found {
			t.Fatalf("%s missing reach %q:\n%s", name, want, out)
		}
	}
	a.json = true
	var listing struct {
		Remotes []remoteListingRow `json:"remotes"`
	}
	if err := json.Unmarshal([]byte(remotesList(t, a)), &listing); err != nil {
		t.Fatal(err)
	}
	row := listing.Remotes[len(listing.Remotes)-1]
	for key, pair := range map[string][2]json.RawMessage{"health": {row.Health, json.RawMessage(healthy)}, "build": {row.Build, json.RawMessage(build)}} {
		var got, want any
		_ = json.Unmarshal(pair[0], &got)
		_ = json.Unmarshal(pair[1], &want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s was not preserved: %s", key, pair[0])
		}
	}
	// The daemon's internal fleet reader must retain discovery without asking
	// the fleet endpoint to shell this same command again.
	streams := sysenvtest.Capture(env)
	cmd := a.remotesListCmd()
	if err := cmd.Flags().Set("no-reach", "true"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(streams.Stdout.String(), "hub-healthy") || strings.Contains(streams.Stdout.String(), "abc123") {
		t.Fatal("no-reach must preserve peers but omit observations")
	}
}

func TestRemotesList_SharedReachFixtureAndNoReachReader(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../daemon/test/fixtures/remotes_health/fleet.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Remotes []remoteListingRow `json:"remotes"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	writeRemotesIn(t, env, `{"remotes":[{"name":"hub-a","port":4001}]}`)
	var fleetReads atomic.Int32
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"discovery":{"state":"ok","via":"localapi","peers":[{"name":"hub-b","url":"https://hub-b.example.ts.net"}]}}`))
		},
		"/api/v1/fleet": func(w http.ResponseWriter, _ *http.Request) {
			fleetReads.Add(1)
			_, _ = w.Write(content)
		},
	})
	a := newApp(env)
	a.json = true
	for _, noReach := range []bool{false, true} {
		streams := sysenvtest.Capture(env)
		cmd := a.remotesListCmd()
		if err := cmd.Flags().Set("no-reach", fmt.Sprint(noReach)); err != nil {
			t.Fatal(err)
		}
		if err := cmd.RunE(cmd, nil); err != nil {
			t.Fatal(err)
		}
		var listing struct {
			Remotes []remoteListingRow `json:"remotes"`
		}
		if err := json.Unmarshal([]byte(streams.Stdout.String()), &listing); err != nil {
			t.Fatal(err)
		}
		if len(listing.Remotes) != len(fixture.Remotes) {
			t.Fatalf("rows = %+v", listing.Remotes)
		}
		for i, expected := range fixture.Remotes {
			actual := listing.Remotes[i]
			if actual.Name != expected.Name || actual.Source != expected.Source {
				t.Fatalf("resolved row = %+v", actual)
			}
			for key, pair := range map[string][2]json.RawMessage{"health": {actual.Health, expected.Health}, "build": {actual.Build, expected.Build}} {
				var got, want any
				_ = json.Unmarshal(pair[0], &got)
				if !noReach {
					_ = json.Unmarshal(pair[1], &want)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("noReach=%v %s = %s, want %v", noReach, key, pair[0], want)
				}
			}
		}
		if fleetReads.Load() != 1 {
			t.Fatalf("--no-reach recursively fetched fleet: %d requests", fleetReads.Load())
		}
	}
}

func TestRemoteReachFormatting(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct{ health, build, want string }{
		{`{"polled":true,"stale":false}`, `{"git_short_sha":"abc123","booted_at":"2026-01-01T00:00:00Z"}`, "healthy abc123 up 24h0m0s"},
		{`{"polled":true,"stale":false}`, `null`, "healthy ? up ?"},
		{`{"polled":false,"stale":true}`, `null`, "unpolled"},
		{`{"polled":true,"stale":true,"last_error":"dial\n timeout"}`, `null`, "stale dial timeout"},
		{`{"polled":true,"stale":true}`, `null`, "stale"},
		{`null`, `null`, "?"},
		{`{"polled":true,"stale":true,"last_error":"` + strings.Repeat("界", 90) + `"}`, `null`, "stale " + strings.Repeat("界", 79) + "…"},
	} {
		row := remoteListingRow{Health: json.RawMessage(tc.health), Build: json.RawMessage(tc.build)}
		if got := row.reach(now); got != tc.want {
			t.Errorf("reach = %q, want %q", got, tc.want)
		}
	}
}

func TestRouteOwnerForCommand_AcceptsDiscoveredPeer(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "hub-self")
	writeRemotesIn(t, env, `{"version":1,"remotes":[]}`)
	serveDiscovery(t, env, `{"enabled":true,"state":"ok","via":"cli","peers":[
	  {"name":"hub-a","url":"https://hub-a.example.ts.net"}
	]}`)

	a := newApp(env)
	owner, err := a.routeOwnerForCommand(a.reopenCmd(), []string{"some-fiber"}, "hub-a")
	if err != nil || owner != "hub-a" {
		t.Fatalf("routeOwnerForCommand = %q, %v; want hub-a", owner, err)
	}
	if _, err := a.routeOwnerForCommand(a.reopenCmd(), []string{"some-fiber"}, "hub-z"); err == nil ||
		!strings.Contains(err.Error(), "nor a discovered tailnet peer") {
		t.Fatalf("unknown host should be refused, got %v", err)
	}
}

func TestDoctor_WarnsWhenDiscoveryIsUnavailable(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	serveDiscovery(t, env, `{"enabled":true,"state":"unavailable","via":"cli","error":"tailscale CLI not found","peers":[]}`)

	a := newApp(env)
	daemon := a.collectDaemonReceipt()
	if daemon.Discovery == nil || daemon.Discovery.State != "unavailable" {
		t.Fatalf("receipt discovery = %+v", daemon.Discovery)
	}
	streams := sysenvtest.Capture(env)
	a.printDiscoveryReceipt(daemon.Discovery)
	out := streams.Stdout.String()
	if !strings.Contains(out, "warning: tailnet discovery unavailable (tailscale CLI not found)") ||
		!strings.Contains(out, "running on remotes.json alone") {
		t.Fatalf("doctor line = %q", out)
	}
}

// defaultTailscaleSocketApp is an app running as Linux (the default socket is
// Linux-only, so these cases run as Linux on any host) on a fresh env whose
// HOME is a short directory, since a unix socket path must fit sun_path. When
// listen is true it binds bin/tailscaled-launch's socket under that HOME. It
// returns the app and the socket path.
func defaultTailscaleSocketApp(t *testing.T, listen bool) (*app, string) {
	t.Helper()
	a := newApp(testEnv(t))
	a.hostGOOS = "linux"
	home, err := os.MkdirTemp("/tmp", "tsd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	a.env.Set("HOME", home)
	path := filepath.Join(home, defaultTailscaleSocketPath)
	if listen {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { listener.Close() })
	}
	return a, path
}

func TestEffectiveTailscaleSocket(t *testing.T) {
	t.Parallel()
	t.Run("default applies when nothing is configured", func(t *testing.T) {
		t.Parallel()
		a, want := defaultTailscaleSocketApp(t, true)
		path, source, err := a.effectiveTailscaleSocket(nil)
		if err != nil || path != want || source != socketSourceDefault {
			t.Fatalf("got %q %q %v, want %q default", path, source, err, want)
		}
	})
	t.Run("an explicit value wins", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		path, source, err := a.effectiveTailscaleSocket(&remoteDefaults{TailscaleSocket: "/run/ts/tailscaled.sock"})
		if err != nil || path != "/run/ts/tailscaled.sock" || source != socketSourceConfigured {
			t.Fatalf("got %q %q %v", path, source, err)
		}
	})
	t.Run("system turns the default off", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		path, source, err := a.effectiveTailscaleSocket(&remoteDefaults{TailscaleSocket: "system"})
		if err != nil || path != "" || source != socketSourceSystem {
			t.Fatalf("got %q %q %v", path, source, err)
		}
	})
	t.Run("a proxy suppresses the default", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		if path, source, _ := a.effectiveTailscaleSocket(&remoteDefaults{HTTPSProxy: "localhost:1055"}); path != "" || source != "" {
			t.Fatalf("got %q %q", path, source)
		}
	})
	t.Run("absent when no socket exists", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, false)
		if path, source, _ := a.effectiveTailscaleSocket(nil); path != "" || source != "" {
			t.Fatalf("got %q %q", path, source)
		}
	})
	t.Run("a regular file at the path is refused", func(t *testing.T) {
		t.Parallel()
		a, path := defaultTailscaleSocketApp(t, false)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		got, refused := a.defaultTailscaleSocketCheck()
		if got != "" || !strings.Contains(refused, "not a Unix socket") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("a group-writable ancestor up to $HOME refuses it", func(t *testing.T) {
		t.Parallel()
		a, path := defaultTailscaleSocketApp(t, true)
		local := filepath.Join(a.env.Getenv("HOME"), ".local")
		if err := os.Chmod(local, 0o775); err != nil {
			t.Fatal(err)
		}
		got, refused := a.defaultTailscaleSocketCheck()
		if got != "" || !strings.Contains(refused, local) || !strings.Contains(refused, "group- or other-writable") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
		if socket, source, _ := a.effectiveTailscaleSocket(nil); socket != "" || source != "" {
			t.Fatalf("a refused default must not be used: %q %q", socket, source)
		}
		host := a.evaluateHost(a.gatherHostEvidence())
		if !strings.HasPrefix(host.TailscaleSocketRefused, path+": ") || !strings.Contains(strings.Join(host.Problems, "\n"), "not trusted") {
			t.Fatalf("doctor must report the refusal: %+v", host)
		}
	})
}

func TestDefaultTailscaleSocket_LiteralPath(t *testing.T) {
	t.Parallel()
	t.Run("a world-writable .local refuses it", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		local := filepath.Join(a.env.Getenv("HOME"), ".local")
		if err := os.Chmod(local, 0o777); err != nil {
			t.Fatal(err)
		}
		if got, refused := a.defaultTailscaleSocketCheck(); got != "" || !strings.Contains(refused, local+": mode 0777") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("a symlinked state directory refuses it, even into a protected tree", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		home := a.env.Getenv("HOME")
		protected := filepath.Join(home, "protected")
		if err := os.Mkdir(protected, 0o700); err != nil {
			t.Fatal(err)
		}
		state := filepath.Join(home, ".local", "state")
		if err := os.Rename(state, filepath.Join(protected, "state")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(protected, "state"), state); err != nil {
			t.Fatal(err)
		}
		if got, refused := a.defaultTailscaleSocketCheck(); got != "" || refused != state+" is a symlink" {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("is Linux-only", func(t *testing.T) {
		t.Parallel()
		a, _ := defaultTailscaleSocketApp(t, true)
		a.hostGOOS = "darwin"
		if got, refused := a.defaultTailscaleSocketCheck(); got != "" || refused != "default socket is Linux-only" {
			t.Fatalf("got %q, refused %q", got, refused)
		}
		if socket, source, _ := a.effectiveTailscaleSocket(nil); socket != "" || source != "" {
			t.Fatalf("macOS must not use the default: %q %q", socket, source)
		}
	})
}

func TestSystemSocket_SurvivesLoadListAndDoctor(t *testing.T) {
	t.Parallel()
	a, _ := defaultTailscaleSocketApp(t, true)
	writeRemotesIn(t, a.env, `{"version":1,"defaults":{"tailscale_socket":"system"},"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	doc, err := a.loadRemotesFile()
	if err != nil {
		t.Fatal(err)
	}
	if doc.Defaults == nil || doc.Defaults.TailscaleSocket != "system" {
		t.Fatalf("normalized defaults lost the sentinel: %+v", doc.Defaults)
	}
	if socket, source, _ := a.effectiveTailscaleSocket(doc.Defaults); socket != "" || source != socketSourceSystem {
		t.Fatalf("effective = %q (%q), want system", socket, source)
	}
	out := remotesList(t, a)
	if strings.Contains(out, "LocalAPI socket") {
		t.Fatalf("list must not claim a socket under \"system\":\n%s", out)
	}
	ev := a.gatherHostEvidence()
	if ev.tailscaleSocket != "" || ev.tailscaleSocketSource != socketSourceSystem || len(ev.tailnetRemoteNames) != 0 {
		t.Fatalf("doctor evidence = %q (%q), bridges expected for %v", ev.tailscaleSocket, ev.tailscaleSocketSource, ev.tailnetRemoteNames)
	}
}

func TestDuplicateHTTPSAuthority_FollowsTheEffectiveSocket(t *testing.T) {
	t.Parallel()
	writeFixture := func(a *app) {
		content, err := os.ReadFile(filepath.Join(remotesFixtureDir, "duplicate_https_authority_default_socket.json"))
		if err != nil {
			t.Fatal(err)
		}
		writeRemotesIn(t, a.env, string(content))
	}

	a, _ := defaultTailscaleSocketApp(t, false)
	writeFixture(a)
	if _, err := a.loadRemotesFile(); err != nil {
		t.Fatalf("without a private socket both entries are valid: %v", err)
	}

	a, _ = defaultTailscaleSocketApp(t, true)
	writeFixture(a)
	if _, err := a.loadRemotesFile(); err == nil || !strings.Contains(err.Error(), "duplicate https authority") {
		t.Fatalf("with the default socket in effect the duplicate must be refused, got %v", err)
	}
}

func TestRemotesList_ShowsEffectiveSocketAndSource(t *testing.T) {
	t.Parallel()
	a, socket := defaultTailscaleSocketApp(t, true)
	writeRemotesIn(t, a.env, `{"version":1,"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	out := remotesList(t, a)
	if !strings.Contains(out, "tailscale LocalAPI socket "+socket+" (default)") {
		t.Fatalf("missing default socket line:\n%s", out)
	}

	writeRemotesIn(t, a.env, `{"version":1,"defaults":{"tailscale_socket":"system"},"remotes":[]}`)
	if _, err := a.loadRemotesFile(); err != nil {
		t.Fatalf("\"system\" must validate: %v", err)
	}
}

func TestHostReceipt_ReportsDefaultSocketAndSource(t *testing.T) {
	t.Parallel()
	a, socket := defaultTailscaleSocketApp(t, true)
	writeRemotesIn(t, a.env, `{"version":1,"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	ev := a.gatherHostEvidence()
	if ev.tailscaleSocket != socket || ev.tailscaleSocketSource != socketSourceDefault {
		t.Fatalf("evidence socket = %q (%q), want %q (default)", ev.tailscaleSocket, ev.tailscaleSocketSource, socket)
	}
	if len(ev.tailnetRemoteNames) != 1 || ev.tailnetRemoteNames[0] != "hub-a" {
		t.Fatalf("https remotes expecting a bridge = %v", ev.tailnetRemoteNames)
	}
	host := a.evaluateHost(ev)
	if host.TailscaleSocket != socket || host.TailscaleSocketSource != socketSourceDefault {
		t.Fatalf("receipt socket = %q (%q)", host.TailscaleSocket, host.TailscaleSocketSource)
	}
}

// TestDefaultTailscaleSocket_FleetLayouts pins the fleet's real layouts: a
// 0666 socket (as tailscaled creates it) under user-owned directories with
// these modes, and no symlinks, must be trusted.
func TestDefaultTailscaleSocket_FleetLayouts(t *testing.T) {
	t.Parallel()
	for name, modes := range map[string][3]os.FileMode{
		"cineca":   {0o700, 0o700, 0o700},
		"candide":  {0o755, 0o700, 0o700},
		"nibi":     {0o750, 0o700, 0o700},
		"amundsen": {0o700, 0o755, 0o700},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			a, path := defaultTailscaleSocketApp(t, true)
			home := a.env.Getenv("HOME")
			dirs := []string{".local", ".local/state", ".local/state/tailscale"}
			for i, dir := range dirs {
				if err := os.Chmod(filepath.Join(home, dir), modes[i]); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Chmod(path, 0o666); err != nil {
				t.Fatal(err)
			}
			if got, refused := a.defaultTailscaleSocketCheck(); got != path || refused != "" {
				t.Fatalf("got %q, refused %q", got, refused)
			}
		})
	}
}
