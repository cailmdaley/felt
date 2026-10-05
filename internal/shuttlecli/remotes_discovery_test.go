package shuttlecli

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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
	paths, err := filepath.Glob(filepath.Join(tailnetPeersFixtureDir, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no tailnet peer fixtures: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
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
			if err := testApp(t).normalizeRemotes(&doc); err != nil {
				t.Fatal(err)
			}

			got := []resolvedRemoteRow{}
			for _, r := range testApp(t).resolveRemotes(doc, fixture.Discovered) {
				got = append(got, resolvedRemoteRow{Name: r.Name, URL: r.URL, Source: r.Source, SSH: r.SSH, Port: r.Port})
			}
			if !reflect.DeepEqual(got, fixture.Resolved) {
				t.Fatalf("resolved\n got %+v\nwant %+v", got, fixture.Resolved)
			}
		})
	}
}

func TestAdmitDiscovered_TakesDocumentDefaults(t *testing.T) {
	doc, err := parseRemotesDocument([]byte(`{"defaults":{"request_timeout_ms":9000},"remotes":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := testApp(t).normalizeRemotes(&doc); err != nil {
		t.Fatal(err)
	}
	got := testApp(t).admitDiscovered(doc, []discoveredPeer{{Name: "hub-a", URL: "https://hub-a.example.ts.net"}})
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	if got[0].RequestTimeoutMS != 9000 || got[0].tunnelOpts().Manager != "none" || got[0].SSH != "" {
		t.Fatalf("discovered peer = %+v, want the document's timeout, no tunnel and no ssh", got[0])
	}
}

// serveDiscovery stands a local daemon up at SHUTTLE_DAEMON_URL whose
// /api/v1/version reports the given discovery block.
func serveDiscovery(t *testing.T, discovery string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ready":true,"host":"hub-self","discovery":` + discovery + `}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
}

func TestRemotesList_ShowsDiscoveredPeersWithSource(t *testing.T) {
	writeRemotes(t, `{"version":1,"remotes":[
	  {"name":"hub-n","ssh":"hub-n-login","port":4005},
	  {"name":"hub-b","url":"https://hub-b.example.ts.net","enabled":false}
	]}`)
	serveDiscovery(t, `{"enabled":true,"state":"ok","via":"cli","peers":[
	  {"name":"hub-a","url":"https://hub-a.example.ts.net"},
	  {"name":"hub-b","url":"https://hub-b.example.ts.net"}
	]}`)

	out := captureStdout(t, func() {
		if err := testApp(t).remotesListCmd().RunE(testApp(t).remotesListCmd(), nil); err != nil {
			t.Fatal(err)
		}
	})
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

	remotes, err := testApp(t).resolvedRemotes()
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
	writeRemotes(t, `{"version":1,"remotes":[{"name":"hub-n","port":4005}]}`)

	out := captureStdout(t, func() {
		if err := testApp(t).remotesListCmd().RunE(testApp(t).remotesListCmd(), nil); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "no discovered peers from the daemon") || !strings.Contains(out, "showing configured remotes only") {
		t.Fatalf("missing unreachable note:\n%s", out)
	}
	if !strings.Contains(out, "hub-n") {
		t.Fatalf("configured entry missing:\n%s", out)
	}
}

func TestRouteOwnerForCommand_AcceptsDiscoveredPeer(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "hub-self")
	writeRemotes(t, `{"version":1,"remotes":[]}`)
	serveDiscovery(t, `{"enabled":true,"state":"ok","via":"cli","peers":[
	  {"name":"hub-a","url":"https://hub-a.example.ts.net"}
	]}`)

	owner, err := testApp(t).routeOwnerForCommand(testApp(t).reopenCmd(), []string{"some-fiber"}, "hub-a")
	if err != nil || owner != "hub-a" {
		t.Fatalf("routeOwnerForCommand = %q, %v; want hub-a", owner, err)
	}
	if _, err := testApp(t).routeOwnerForCommand(testApp(t).reopenCmd(), []string{"some-fiber"}, "hub-z"); err == nil ||
		!strings.Contains(err.Error(), "nor a discovered tailnet peer") {
		t.Fatalf("unknown host should be refused, got %v", err)
	}
}

func TestDoctor_WarnsWhenDiscoveryIsUnavailable(t *testing.T) {
	serveDiscovery(t, `{"enabled":true,"state":"unavailable","via":"cli","error":"tailscale CLI not found","peers":[]}`)

	daemon := testApp(t).collectDaemonReceipt()
	if daemon.Discovery == nil || daemon.Discovery.State != "unavailable" {
		t.Fatalf("receipt discovery = %+v", daemon.Discovery)
	}
	out := captureStdout(t, func() { testApp(t).printDiscoveryReceipt(daemon.Discovery) })
	if !strings.Contains(out, "warning: tailnet discovery unavailable (tailscale CLI not found)") ||
		!strings.Contains(out, "running on remotes.json alone") {
		t.Fatalf("doctor line = %q", out)
	}
}

// withDefaultTailscaleSocket points HOME at a short directory (a unix socket
// path must fit sun_path) and, when listen is true, binds
// bin/tailscaled-launch's socket under it, as if on Linux. It returns the
// socket path.
func withDefaultTailscaleSocket(t *testing.T, listen bool) string {
	t.Helper()
	// The default is Linux-only; these cases run as Linux on any host.
	useHostGOOS(t, "linux")
	home, err := os.MkdirTemp("/tmp", "tsd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
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
	return path
}

func TestEffectiveTailscaleSocket(t *testing.T) {
	t.Run("default applies when nothing is configured", func(t *testing.T) {
		want := withDefaultTailscaleSocket(t, true)
		path, source, err := testApp(t).effectiveTailscaleSocket(nil)
		if err != nil || path != want || source != socketSourceDefault {
			t.Fatalf("got %q %q %v, want %q default", path, source, err, want)
		}
	})
	t.Run("an explicit value wins", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		path, source, err := testApp(t).effectiveTailscaleSocket(&remoteDefaults{TailscaleSocket: "/run/ts/tailscaled.sock"})
		if err != nil || path != "/run/ts/tailscaled.sock" || source != socketSourceConfigured {
			t.Fatalf("got %q %q %v", path, source, err)
		}
	})
	t.Run("system turns the default off", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		path, source, err := testApp(t).effectiveTailscaleSocket(&remoteDefaults{TailscaleSocket: "system"})
		if err != nil || path != "" || source != socketSourceSystem {
			t.Fatalf("got %q %q %v", path, source, err)
		}
	})
	t.Run("a proxy suppresses the default", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		if path, source, _ := testApp(t).effectiveTailscaleSocket(&remoteDefaults{HTTPSProxy: "localhost:1055"}); path != "" || source != "" {
			t.Fatalf("got %q %q", path, source)
		}
	})
	t.Run("absent when no socket exists", func(t *testing.T) {
		withDefaultTailscaleSocket(t, false)
		if path, source, _ := testApp(t).effectiveTailscaleSocket(nil); path != "" || source != "" {
			t.Fatalf("got %q %q", path, source)
		}
	})
	t.Run("a regular file at the path is refused", func(t *testing.T) {
		path := withDefaultTailscaleSocket(t, false)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		got, refused := testApp(t).defaultTailscaleSocketCheck()
		if got != "" || !strings.Contains(refused, "not a Unix socket") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("a group-writable ancestor up to $HOME refuses it", func(t *testing.T) {
		path := withDefaultTailscaleSocket(t, true)
		local := filepath.Join(os.Getenv("HOME"), ".local")
		if err := os.Chmod(local, 0o775); err != nil {
			t.Fatal(err)
		}
		got, refused := testApp(t).defaultTailscaleSocketCheck()
		if got != "" || !strings.Contains(refused, local) || !strings.Contains(refused, "group- or other-writable") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
		if socket, source, _ := testApp(t).effectiveTailscaleSocket(nil); socket != "" || source != "" {
			t.Fatalf("a refused default must not be used: %q %q", socket, source)
		}
		host := testApp(t).evaluateHost(testApp(t).gatherHostEvidence())
		if !strings.HasPrefix(host.TailscaleSocketRefused, path+": ") || !strings.Contains(strings.Join(host.Problems, "\n"), "not trusted") {
			t.Fatalf("doctor must report the refusal: %+v", host)
		}
	})
}

func TestDefaultTailscaleSocket_LiteralPath(t *testing.T) {
	t.Run("a world-writable .local refuses it", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		local := filepath.Join(os.Getenv("HOME"), ".local")
		if err := os.Chmod(local, 0o777); err != nil {
			t.Fatal(err)
		}
		if got, refused := testApp(t).defaultTailscaleSocketCheck(); got != "" || !strings.Contains(refused, local+": mode 0777") {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("a symlinked state directory refuses it, even into a protected tree", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		home := os.Getenv("HOME")
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
		if got, refused := testApp(t).defaultTailscaleSocketCheck(); got != "" || refused != state+" is a symlink" {
			t.Fatalf("got %q, refused %q", got, refused)
		}
	})
	t.Run("is Linux-only", func(t *testing.T) {
		withDefaultTailscaleSocket(t, true)
		useHostGOOS(t, "darwin")
		if got, refused := testApp(t).defaultTailscaleSocketCheck(); got != "" || refused != "default socket is Linux-only" {
			t.Fatalf("got %q, refused %q", got, refused)
		}
		if socket, source, _ := testApp(t).effectiveTailscaleSocket(nil); socket != "" || source != "" {
			t.Fatalf("macOS must not use the default: %q %q", socket, source)
		}
	})
}

func TestSystemSocket_SurvivesLoadListAndDoctor(t *testing.T) {
	withDefaultTailscaleSocket(t, true)
	writeRemotes(t, `{"version":1,"defaults":{"tailscale_socket":"system"},"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	doc, err := testApp(t).loadRemotesFile()
	if err != nil {
		t.Fatal(err)
	}
	if doc.Defaults == nil || doc.Defaults.TailscaleSocket != "system" {
		t.Fatalf("normalized defaults lost the sentinel: %+v", doc.Defaults)
	}
	if socket, source, _ := testApp(t).effectiveTailscaleSocket(doc.Defaults); socket != "" || source != socketSourceSystem {
		t.Fatalf("effective = %q (%q), want system", socket, source)
	}
	out := captureStdout(t, func() {
		if err := testApp(t).remotesListCmd().RunE(testApp(t).remotesListCmd(), nil); err != nil {
			t.Fatal(err)
		}
	})
	if strings.Contains(out, "LocalAPI socket") {
		t.Fatalf("list must not claim a socket under \"system\":\n%s", out)
	}
	ev := testApp(t).gatherHostEvidence()
	if ev.tailscaleSocket != "" || ev.tailscaleSocketSource != socketSourceSystem || len(ev.tailnetRemoteNames) != 0 {
		t.Fatalf("doctor evidence = %q (%q), bridges expected for %v", ev.tailscaleSocket, ev.tailscaleSocketSource, ev.tailnetRemoteNames)
	}
}

func TestDuplicateHTTPSAuthority_FollowsTheEffectiveSocket(t *testing.T) {
	writeFixture := func() {
		content, err := os.ReadFile(filepath.Join(remotesFixtureDir, "duplicate_https_authority_default_socket.json"))
		if err != nil {
			t.Fatal(err)
		}
		writeRemotes(t, string(content))
	}

	withDefaultTailscaleSocket(t, false)
	writeFixture()
	if _, err := testApp(t).loadRemotesFile(); err != nil {
		t.Fatalf("without a private socket both entries are valid: %v", err)
	}

	withDefaultTailscaleSocket(t, true)
	writeFixture()
	if _, err := testApp(t).loadRemotesFile(); err == nil || !strings.Contains(err.Error(), "duplicate https authority") {
		t.Fatalf("with the default socket in effect the duplicate must be refused, got %v", err)
	}
}

func TestRemotesList_ShowsEffectiveSocketAndSource(t *testing.T) {
	socket := withDefaultTailscaleSocket(t, true)
	writeRemotes(t, `{"version":1,"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	out := captureStdout(t, func() {
		if err := testApp(t).remotesListCmd().RunE(testApp(t).remotesListCmd(), nil); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "tailscale LocalAPI socket "+socket+" (default)") {
		t.Fatalf("missing default socket line:\n%s", out)
	}

	writeRemotes(t, `{"version":1,"defaults":{"tailscale_socket":"system"},"remotes":[]}`)
	if _, err := testApp(t).loadRemotesFile(); err != nil {
		t.Fatalf("\"system\" must validate: %v", err)
	}
}

func TestHostReceipt_ReportsDefaultSocketAndSource(t *testing.T) {
	socket := withDefaultTailscaleSocket(t, true)
	writeRemotes(t, `{"version":1,"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`)

	ev := testApp(t).gatherHostEvidence()
	if ev.tailscaleSocket != socket || ev.tailscaleSocketSource != socketSourceDefault {
		t.Fatalf("evidence socket = %q (%q), want %q (default)", ev.tailscaleSocket, ev.tailscaleSocketSource, socket)
	}
	if len(ev.tailnetRemoteNames) != 1 || ev.tailnetRemoteNames[0] != "hub-a" {
		t.Fatalf("https remotes expecting a bridge = %v", ev.tailnetRemoteNames)
	}
	host := testApp(t).evaluateHost(ev)
	if host.TailscaleSocket != socket || host.TailscaleSocketSource != socketSourceDefault {
		t.Fatalf("receipt socket = %q (%q)", host.TailscaleSocket, host.TailscaleSocketSource)
	}
}

// TestDefaultTailscaleSocket_FleetLayouts pins the fleet's real layouts: a
// 0666 socket (as tailscaled creates it) under user-owned directories with
// these modes, and no symlinks, must be trusted.
func TestDefaultTailscaleSocket_FleetLayouts(t *testing.T) {
	for name, modes := range map[string][3]os.FileMode{
		"cineca":   {0o700, 0o700, 0o700},
		"candide":  {0o755, 0o700, 0o700},
		"nibi":     {0o750, 0o700, 0o700},
		"amundsen": {0o700, 0o755, 0o700},
	} {
		t.Run(name, func(t *testing.T) {
			path := withDefaultTailscaleSocket(t, true)
			home := os.Getenv("HOME")
			dirs := []string{".local", ".local/state", ".local/state/tailscale"}
			for i, dir := range dirs {
				if err := os.Chmod(filepath.Join(home, dir), modes[i]); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Chmod(path, 0o666); err != nil {
				t.Fatal(err)
			}
			if got, refused := testApp(t).defaultTailscaleSocketCheck(); got != path || refused != "" {
				t.Fatalf("got %q, refused %q", got, refused)
			}
		})
	}
}
