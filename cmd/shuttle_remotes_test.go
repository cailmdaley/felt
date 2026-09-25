package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// remoteFixture is one row of daemon/test/fixtures/remotes/expected.json — the shared
// expectation the Elixir suite asserts against too.
type remoteFixture struct {
	Name             string `json:"name"`
	URL              string `json:"url"`
	SSH              string `json:"ssh"`
	Display          string `json:"display"`
	Port             int    `json:"port"`
	RemotePort       int    `json:"remote_port"`
	RemoteSocket     string `json:"remote_socket"`
	PollIntervalMS   int    `json:"poll_interval_ms"`
	RequestTimeoutMS int    `json:"request_timeout_ms"`
	StaleMultiplier  int    `json:"stale_multiplier"`
	Label            string `json:"label"`

	// Manager is asserted only where expected.json carries it — on portless
	// entries, the one place the two readers must agree that a remote has no
	// tunnel to supervise. Pointer-typed so "absent" and "none" stay distinct:
	// for a PORT entry the two readers answer different questions on purpose
	// (which supervisor to install with vs. what the cascade can bounce), so
	// asserting a shared value there would be asserting a bug.
	Manager *string `json:"manager"`
}

// proxyFixture is expected.json's `https_proxy`: the parsed pair, not a
// rendered string. The string form was where the two readers could disagree
// without the fixture noticing — "localhost:1055" and "localhost:01055" denote
// one endpoint — so the expectation names host and port separately and
// {"", 0} means no proxy at all.
type proxyFixture struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type remoteFixtureDoc struct {
	LaunchdLabelPrefix string          `json:"launchd_label_prefix"`
	HTTPSProxy         proxyFixture    `json:"https_proxy"`
	Remotes            []remoteFixture `json:"remotes"`
}

const remotesFixtureDir = "../daemon/test/fixtures/remotes"

// TestRemotesFixtureParity is the anti-drift device: the Go reader and the
// Elixir reader (daemon/test/shuttle/remotes_test.exs) read the SAME fixture files and
// assert the SAME expected.json. A default that changes in one language fails in
// both. FELT_STORES parity is guarded only by comments; this one is executable.
func TestRemotesFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(remotesFixtureDir, "expected.json"))
	if err != nil {
		t.Fatalf("read expected.json: %v", err)
	}
	var expected map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatalf("parse expected.json: %v", err)
	}

	cases := 0
	for fixture, blob := range expected {
		if strings.HasPrefix(fixture, "_") {
			continue
		}
		cases++
		fixture, blob := fixture, blob
		t.Run(fixture, func(t *testing.T) {
			var want remoteFixtureDoc
			if err := json.Unmarshal(blob, &want); err != nil {
				t.Fatalf("parse expectation: %v", err)
			}
			t.Setenv("FELT_REMOTES_FILE", filepath.Join(remotesFixtureDir, fixture))

			doc, err := loadRemotesFile()
			if err != nil {
				t.Fatalf("loadRemotesFile: %v", err)
			}
			if doc.LaunchdLabelPrefix != want.LaunchdLabelPrefix {
				t.Errorf("launchd_label_prefix = %q, want %q", doc.LaunchdLabelPrefix, want.LaunchdLabelPrefix)
			}
			var gotProxy proxyEndpoint
			if doc.Defaults != nil {
				// loadRemotesFile already refused an unparseable proxy, so an
				// error here cannot happen; the fixture asserts the value.
				gotProxy, _ = doc.Defaults.normalizedHTTPSProxy()
			}
			if (proxyFixture{Host: gotProxy.Host, Port: gotProxy.Port}) != want.HTTPSProxy {
				t.Errorf("defaults.https_proxy = %+v, want %+v", gotProxy, want.HTTPSProxy)
			}
			if len(doc.Remotes) != len(want.Remotes) {
				t.Fatalf("got %d remotes, want %d", len(doc.Remotes), len(want.Remotes))
			}
			for i, w := range want.Remotes {
				got := doc.Remotes[i]
				g := remoteFixture{
					Name:             got.Name,
					URL:              got.URL,
					SSH:              got.SSH,
					Display:          got.Display,
					Port:             got.Port,
					RemotePort:       got.RemotePort,
					RemoteSocket:     got.RemoteSocket,
					PollIntervalMS:   got.PollIntervalMS,
					RequestTimeoutMS: got.RequestTimeoutMS,
					StaleMultiplier:  got.StaleMultiplier,
					Label:            got.label(doc.LaunchdLabelPrefix),
				}
				if w.Manager != nil {
					manager := got.tunnelOpts().Manager
					g.Manager = &manager
				}
				if !sameRemoteFixture(g, w) {
					t.Errorf("remote #%d:\n got  %+v\n want %+v", i, g, w)
				}
			}
		})
	}
	if cases == 0 {
		t.Fatal("expected.json listed no fixtures")
	}
}

// TestRemotesFixtureRejected — the fixtures under expected.json's _rejected
// fail to load, naming the offending remote and field.
func TestRemotesFixtureRejected(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(remotesFixtureDir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Rejected map[string]json.RawMessage `json:"_rejected"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	cases := 0
	for fixture, blob := range doc.Rejected {
		if strings.HasPrefix(fixture, "_") {
			continue
		}
		cases++
		var want struct{ Remote, Field string }
		if err := json.Unmarshal(blob, &want); err != nil {
			t.Fatalf("%s: %v", fixture, err)
		}
		t.Setenv("FELT_REMOTES_FILE", filepath.Join(remotesFixtureDir, fixture))
		_, err := loadRemotesFile()
		if err == nil {
			t.Errorf("%s loaded; want a refusal of %s.%s", fixture, want.Remote, want.Field)
			continue
		}
		if !strings.Contains(err.Error(), `"`+want.Remote+`"`) || !strings.Contains(err.Error(), want.Field) {
			t.Errorf("%s: error %q does not name %s.%s", fixture, err, want.Remote, want.Field)
		}
	}
	if cases == 0 {
		t.Fatal("expected.json lists no _rejected fixtures")
	}
}

// sameRemoteFixture compares two readings field by field, dereferencing the
// optional Manager: the struct holds a pointer, so == would compare addresses.
func sameRemoteFixture(a, b remoteFixture) bool {
	am, bm := a.Manager, b.Manager
	a.Manager, b.Manager = nil, nil
	if a != b {
		return false
	}
	switch {
	case am == nil && bm == nil:
		return true
	case am == nil || bm == nil:
		return false
	default:
		return *am == *bm
	}
}

// TestConfiguredRemotes_Resolution locks the precedence and the absent-file
// contract. There is deliberately no compact FELT_REMOTES env form, so
// FELT_REMOTES_FILE is the only override.
func TestConfiguredRemotes_Resolution(t *testing.T) {
	dir := t.TempDir()

	// Missing file → empty, no error. A host with no fleet is a valid host.
	t.Setenv("FELT_REMOTES_FILE", filepath.Join(dir, "absent.json"))
	got, err := configuredRemotes()
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("missing file → %v, want none", got)
	}

	// Malformed → error naming the path. The CLI is the fleet's validator.
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{"remotes": [`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", bad)
	if _, err := configuredRemotes(); err == nil {
		t.Fatal("malformed file should error")
	} else if !strings.Contains(err.Error(), bad) {
		t.Fatalf("error should name the path, got %q", err)
	}

	// FELT_REMOTES_FILE points the reader elsewhere.
	good := filepath.Join(dir, "good.json")
	if err := os.WriteFile(good, []byte(`{"version":1,"remotes":[{"name":"x","port":4009}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", good)
	got, err = configuredRemotes()
	if err != nil {
		t.Fatalf("configuredRemotes: %v", err)
	}
	if len(got) != 1 || got[0].Name != "x" || got[0].URL != "http://127.0.0.1:4009" {
		t.Fatalf("got %+v", got)
	}
}

// TestConfiguredRemotes_DropsDisabled — an entry can stay on file without being
// polled or tunnelled.
func TestConfiguredRemotes_DropsDisabled(t *testing.T) {
	writeRemotes(t, `{"version":1,"remotes":[
	  {"name":"on","port":4001},
	  {"name":"off","port":4002,"enabled":false}
	]}`)

	got, err := configuredRemotes()
	if err != nil {
		t.Fatalf("configuredRemotes: %v", err)
	}
	if len(got) != 1 || got[0].Name != "on" {
		t.Fatalf("got %+v, want only the enabled remote", got)
	}
}

func TestNormalizeRemotes_Validation(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"empty name", `[{"name":"","port":4001}]`, "name is required"},
		{"duplicate name", `[{"name":"a","port":4001},{"name":"a","port":4002}]`, "duplicate remote name"},
		{"duplicate port", `[{"name":"a","port":4001},{"name":"b","port":4001}]`, "already used by"},
		{"port too high", `[{"name":"a","port":70000}]`, "out of range"},
		{"port negative", `[{"name":"a","port":-1}]`, "out of range"},
		{"remote port too high", `[{"name":"a","port":4001,"remote_port":70000}]`, "remote_port"},
		{"remote port negative", `[{"name":"a","port":4001,"remote_port":-1}]`, "remote_port"},
		{"poll interval negative", `[{"name":"a","port":4001,"poll_interval_ms":-1}]`, "poll_interval_ms"},
		{"request timeout negative", `[{"name":"a","port":4001,"request_timeout_ms":-1}]`, "request_timeout_ms"},
		{"stale multiplier negative", `[{"name":"a","port":4001,"stale_multiplier":-1}]`, "stale_multiplier"},
		{"no port, no url", `[{"name":"a"}]`, "needs a port or an explicit url"},
		// A portless entry has no forward for this host to supervise, so naming
		// a supervisor for it is a contradiction, not a default to fill in.
		{"managed tunnel without a port", `[{"name":"a","url":"https://a.example.ts.net","tunnel":{"manager":"systemd"}}]`, "needs a local port to forward"},
		{"launchd tunnel without a port", `[{"name":"a","url":"https://a.example.ts.net","tunnel":{"manager":"launchd"}}]`, "needs a local port to forward"},
		{"remote port and socket", `[{"name":"a","port":4001,"remote_port":4000,"remote_socket":"/srv/s.sock"}]`, "mutually exclusive"},
		{"relative remote socket", `[{"name":"a","port":4001,"remote_socket":"sock/daemon.sock"}]`, "absolute"},
		{"remote socket with a colon", `[{"name":"a","port":4001,"remote_socket":"/srv/a:b.sock"}]`, "letters, digits"},
		{"remote socket with a command substitution", `[{"name":"a","port":4001,"remote_socket":"/srv/$(id).sock"}]`, "letters, digits"},
		{"remote socket with a quote", `[{"name":"a","port":4001,"remote_socket":"/srv/a'b.sock"}]`, "letters, digits"},
		{"remote socket with xml", `[{"name":"a","port":4001,"remote_socket":"/srv/</string>.sock"}]`, "letters, digits"},
		{"remote socket with a percent", `[{"name":"a","port":4001,"remote_socket":"/srv/%h.sock"}]`, "letters, digits"},
		{"remote socket with dot-dot", `[{"name":"a","port":4001,"remote_socket":"/srv/../etc/d.sock"}]`, "clean path"},
		{"remote socket with a trailing slash", `[{"name":"a","port":4001,"remote_socket":"/srv/sock/"}]`, "clean path"},
		{"proxy with a path", `{"defaults":{"https_proxy":"http://h:1/x"},"remotes":[{"name":"a","port":4001}]}`, "https_proxy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeRemotes(t, tc.body)
			_, err := loadRemotesFile()
			if err == nil {
				t.Fatalf("want error containing %q, got none", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

// TestSaveRemotes_RoundTrip — atomic write, and an empty fleet deletes the file
// (matching the stores/projects writers).
func TestSaveRemotes_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remotes.json")
	t.Setenv("FELT_REMOTES_FILE", path)

	doc := remotesFile{Remotes: []remoteSpec{{Name: "a", Port: 4001}}}
	if err := saveRemotes(doc); err != nil {
		t.Fatalf("saveRemotes: %v", err)
	}
	reloaded, err := loadRemotesFile()
	if err != nil {
		t.Fatalf("loadRemotesFile: %v", err)
	}
	if len(reloaded.Remotes) != 1 || reloaded.Remotes[0].Name != "a" {
		t.Fatalf("round trip lost the entry: %+v", reloaded)
	}
	if reloaded.Version != 1 {
		t.Errorf("version = %d, want 1", reloaded.Version)
	}

	if err := saveRemotes(remotesFile{}); err != nil {
		t.Fatalf("saveRemotes(empty): %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("empty save should delete the file, stat err = %v", err)
	}
}

// writeRemotes points FELT_REMOTES_FILE at a temp file holding body.
func writeRemotes(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "remotes.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", path)
	return path
}

// TestParseProxyEndpoint is the proxy grammar's full table, and it is mirrored
// line for line by the Elixir suite's table over Shuttle.Remotes.parse_proxy/1.
// The two readers share the fixture files for everything a fleet file can
// legally say, but a fixture can only hold readings that SUCCEED — the rejected
// inputs are the half where the readers actually drifted (Go used to accept a
// path, a query, a fragment, a leading-zero port and a socks5:// scheme that
// Elixir read as no proxy at all, so `remotes list` validated a file clean while
// the daemon silently connected direct and every ts.net remote went stale). So
// the table lives in both suites instead: change a rule in one language and the
// other language's table is what fails.
func TestParseProxyEndpoint(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want proxyEndpoint // zero value with wantErr means "rejected"
		// wantErr: the string is present but not a usable proxy address. Note
		// that the empty input is NOT an error — an absent proxy is an ordinary
		// fleet, and only a present-but-broken one is worth refusing.
		wantErr bool
	}{
		{"absent", "", proxyEndpoint{}, false},
		{"bare host:port", "h:1", proxyEndpoint{Host: "h", Port: 1}, false},
		{"surrounding whitespace", "  h:1  ", proxyEndpoint{Host: "h", Port: 1}, false},
		{"http scheme", "http://localhost:1055", proxyEndpoint{Host: "localhost", Port: 1055}, false},
		{"https scheme", "https://h:443", proxyEndpoint{Host: "h", Port: 443}, false},
		{"scheme is case-insensitive", "HTTP://h:1", proxyEndpoint{Host: "h", Port: 1}, false},
		{"userinfo is dropped", "http://user:pass@h:3128", proxyEndpoint{Host: "h", Port: 3128}, false},
		{"ipv6 loses its brackets", "[::1]:1055", proxyEndpoint{Host: "::1", Port: 1055}, false},

		// A path, query, or fragment means the operator pasted something that is
		// not a proxy address. Ignoring the tail accepts a string whose meaning
		// we would be guessing at, and the guess is invisible once it is wrong.
		{"path", "http://h:1/x", proxyEndpoint{}, true},
		{"deeper path", "http://h:1/x/y", proxyEndpoint{}, true},
		{"query", "http://h:1?a=b", proxyEndpoint{}, true},
		{"fragment", "http://h:1#f", proxyEndpoint{}, true},

		// The port is parsed as a number and bounded. A leading-zero port is not
		// a different endpoint, which is exactly why the expectation is the
		// integer and not the source text.
		{"leading zeros normalize", "http://h:01055", proxyEndpoint{Host: "h", Port: 1055}, false},
		{"port zero", "http://h:0", proxyEndpoint{}, true},
		{"port above the range", "http://h:99999", proxyEndpoint{}, true},
		{"empty port", "h:", proxyEndpoint{}, true},
		{"no port at all", "https://h", proxyEndpoint{}, true},

		{"no host", "http://:1055", proxyEndpoint{}, true},
		// An HTTP CONNECT proxy is the only kind the daemon's client speaks;
		// reading a SOCKS URL as one fails the same silent way a dropped proxy
		// does, so it is refused rather than coerced.
		{"socks is not an http proxy", "socks5://h:1080", proxyEndpoint{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseProxyEndpoint(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseProxyEndpoint(%q) = %+v, want an error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseProxyEndpoint(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("parseProxyEndpoint(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

// TestProxyEndpoint_String — the human line `remotes list` prints. An IPv6
// proxy comes back bracketed so an operator can paste the line straight back
// into the fleet file and have it parse.
func TestProxyEndpoint_String(t *testing.T) {
	if got := (proxyEndpoint{Host: "localhost", Port: 1055}).String(); got != "localhost:1055" {
		t.Errorf("String() = %q", got)
	}
	if got := (proxyEndpoint{Host: "::1", Port: 1055}).String(); got != "[::1]:1055" {
		t.Errorf("String() = %q, want the brackets back", got)
	}
	if got := (proxyEndpoint{}).String(); got != "" {
		t.Errorf("an absent proxy should render empty, got %q", got)
	}
}

// TestNormalizeRemotes_TunnelManagerDefaultFollowsTheTransport — the default
// manager is a question about the ENTRY, not only about the host. A port entry
// gets the hub's supervisor; a portless one has no forward to supervise, so it
// is `none` even on a hub that has launchd or systemd right there. Getting this
// wrong wrote a unit with `-L 0:localhost:4000` and no ssh destination, which
// the convergent prune then protected because the fleet file still named it.
func TestNormalizeRemotes_TunnelManagerDefaultFollowsTheTransport(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			useHostGOOS(t, goos)
			writeRemotes(t, `[{"name":"meshnode","url":"https://meshnode.example.ts.net"},
			  {"name":"hub-a","port":4001}]`)
			doc, err := loadRemotesFile()
			if err != nil {
				t.Fatalf("loadRemotesFile: %v", err)
			}
			if got := doc.Remotes[0].tunnelOpts().Manager; got != "none" {
				t.Errorf("portless remote manager = %q, want none", got)
			}
			if got := doc.Remotes[1].tunnelOpts().Manager; got != defaultTunnelManager() {
				t.Errorf("port remote manager = %q, want %q", got, defaultTunnelManager())
			}
			// And nothing portless ever reaches the installer.
			if specs := resolveManagedTunnelSpecs(doc); len(specs) != 1 || specs[0].Name != "hub-a" {
				t.Errorf("managed specs = %+v, want only hub-a", specs)
			}
		})
	}
}
