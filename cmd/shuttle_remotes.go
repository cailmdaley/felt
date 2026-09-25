package cmd

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// The remote-daemon fleet: which other shuttle daemons this host knows about,
// what local port each one's SSH tunnel lands on, and how to reach them.
//
// This is the Go half of a two-reader contract. `Shuttle.Remotes` (Elixir) reads
// the same file with the same defaults, and `daemon/test/fixtures/remotes/*.json` is
// read by BOTH suites so the two readers cannot drift. Nothing here shells the
// daemon and nothing in the daemon shells this — the file is the contract.
//
// It is a sibling of `stores.json` (Shuttle.FeltStores) and `projects.json`
// (Shuttle.Projects), not an extension of either: one file per question. Stores
// are mutated at runtime by the kanban; the fleet is operator setup that a UI
// round-trip must never clobber.
//
// Resolution: $FELT_REMOTES_FILE, else ~/.config/felt/remotes.json. Absent file
// → no remotes (a local-only host pays nothing). There is deliberately no
// compact `FELT_REMOTES` env form: a remote carries structured fields (tunnel
// options, per-remote timeouts) that no comma-separated grammar can express, so
// a second grammar in two languages would always be a lossy subset.

const (
	// defaultRemoteDaemonPort is the port a shuttle daemon binds on its OWN
	// host. The tunnel forwards <local port> → localhost:<remote_port> there.
	defaultRemoteDaemonPort = 4000

	// defaultLaunchdLabelPrefix is the reverse-DNS prefix for the generated
	// tunnel launchd labels. It matches the daemon's own io.shuttle.daemon
	// agent. Override per-fleet with `launchd_label_prefix` in the file — the
	// Elixir recovery cascade reads the same value, so the label a plist is
	// installed under and the label `launchctl kickstart` targets cannot drift.
	defaultLaunchdLabelPrefix = "io.shuttle"

	defaultRemotePollIntervalMS   = 5000
	defaultRemoteRequestTimeoutMS = 2000
	defaultRemoteStaleMultiplier  = 4
)

// remoteTunnel is the per-remote tunnel policy.
type remoteTunnel struct {
	// Manager: "launchd" or "systemd" (this host supervises the tunnel) or
	// "none" (the remote is reachable without a locally-managed tunnel). For an
	// entry with a `port` it defaults to the hub's own supervisor — launchd on
	// darwin, systemd on linux — and to none anywhere else; for an entry with no
	// port there is no forward to supervise, so it defaults to none everywhere
	// and naming a supervisor is refused outright. The two managed values are
	// interchangeable to `felt shuttle tunnels install`: which supervisor
	// renders is the HUB's business, so a fleet file written on a Mac installs
	// unchanged on a Linux hub.
	Manager string `json:"manager,omitempty"`
	// Multiplex: ride an existing ControlMaster socket instead of opening
	// independent connections — the only viable transport for a host behind
	// interactive 2FA. See the plist template for the full argument.
	Multiplex bool `json:"multiplex,omitempty"`
	// Label: full override of the generated job name — the launchd label on
	// macOS, and the systemd unit name (given a .service suffix if it lacks
	// one) on Linux.
	Label string `json:"label,omitempty"`
}

// remoteDefaults are the file-level fallbacks for the per-remote polling knobs,
// plus the one fleet-wide setting that is not per-remote at all: the hub's
// outbound HTTP proxy.
type remoteDefaults struct {
	PollIntervalMS   int `json:"poll_interval_ms,omitempty"`
	RequestTimeoutMS int `json:"request_timeout_ms,omitempty"`
	StaleMultiplier  int `json:"stale_multiplier,omitempty"`

	// HTTPSProxy: "http://localhost:1055", or a bare "localhost:1055". The
	// daemon feeds it to its HTTP client so a hub whose own mesh-VPN daemon
	// runs with userspace networking — no kernel route to the mesh, only a
	// local proxy — can reach its https:// remotes. $HTTPS_PROXY is
	// deliberately NOT consulted by either reader: a supervised daemon's
	// environment is invisible to the operator debugging it, and this file is
	// already the one `remotes list` validates.
	HTTPSProxy string `json:"https_proxy,omitempty"`
}

// proxyEndpoint is defaults.https_proxy after parsing: a host with no IPv6
// brackets (that is the form the daemon hands its HTTP client) and a port as an
// integer. The zero value means "no proxy configured", which is a perfectly
// ordinary fleet — only a hub whose mesh VPN runs in userspace needs one.
//
// Host and port are kept apart rather than re-joined into one string because
// the string form is where the two readers used to drift: "localhost:1055" and
// "localhost:01055" are the same endpoint but different strings, and an
// expectation written as a string cannot say which one it means. The parity
// fixture asserts the pair, so there is nothing left to render ambiguously.
type proxyEndpoint struct {
	Host string
	Port int
}

// configured reports whether a proxy was given at all. A half-parsed endpoint
// never escapes parseProxyEndpoint — it returns an error instead — so host and
// port are either both set or both zero.
func (p proxyEndpoint) configured() bool { return p.Host != "" && p.Port != 0 }

// String is the human form `remotes list` prints and nothing parses back. It
// goes through net.JoinHostPort so an IPv6 proxy comes out bracketed
// ("[::1]:1055") and therefore re-parseable if an operator copies the line
// straight back into the fleet file.
func (p proxyEndpoint) String() string {
	if !p.configured() {
		return ""
	}
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// normalizedHTTPSProxy parses defaults.https_proxy. An absent value yields the
// zero endpoint and no error; anything present but unusable is an error, because
// `remotes list` is the fleet's validator and a proxy the daemon silently
// ignores is exactly how every https:// remote goes stale with no explanation.
func (d remoteDefaults) normalizedHTTPSProxy() (proxyEndpoint, error) {
	return parseProxyEndpoint(d.HTTPSProxy)
}

// parseProxyEndpoint is the shared proxy grammar, in Go.
// Shuttle.Remotes.parse_proxy/1 implements the same rules on the Elixir side and
// daemon/test/fixtures/remotes/expected.json asserts the result in both
// languages, with a mirrored unit table in each suite — a rule that changes in
// one language has to change in the other or a suite goes red.
//
// The grammar is deliberately narrower than a URL: `[scheme://][userinfo@]host:port`.
//
//   - The scheme, when present, must be http or https (case-insensitive). This
//     is an HTTP CONNECT proxy; reading socks5:// as one would produce a client
//     that quietly talks the wrong protocol, which fails the same silent way a
//     dropped proxy does.
//   - Userinfo is accepted and dropped. The daemon's client does not do proxy
//     auth, and a credential in this file would be a surprise either way.
//   - A path, query, or fragment is REJECTED rather than ignored. A proxy
//     address has none, so their presence means the operator pasted something
//     that is not a proxy address, and ignoring the tail would accept a string
//     whose meaning we are guessing at.
//   - The port must be written out and must land in 1..65535. A scheme's default
//     port is a guess about a local proxy nobody runs on 80, so "https://h" is an
//     error, not port 443. Leading zeros parse as the integer they denote
//     ("01055" is 1055), which is precisely why the parsed port, not the source
//     text, is what both readers compare.
//   - An IPv6 literal keeps its brackets only in the source text: "[::1]:1055"
//     yields host "::1".
func parseProxyEndpoint(raw string) (proxyEndpoint, error) {
	rest := strings.TrimSpace(raw)
	if rest == "" {
		return proxyEndpoint{}, nil
	}

	if i := strings.Index(rest, "://"); i >= 0 {
		scheme := strings.ToLower(rest[:i])
		if scheme != "http" && scheme != "https" {
			return proxyEndpoint{}, fmt.Errorf("scheme %q is not http or https", rest[:i])
		}
		rest = rest[i+len("://"):]
	}

	// Checked before userinfo is stripped: a "/" or "?" ahead of the "@" is not
	// a userinfo character either, so there is no input where rejecting early
	// loses a valid parse.
	if strings.ContainsAny(rest, "/?#") {
		return proxyEndpoint{}, fmt.Errorf("a proxy address has no path, query, or fragment")
	}
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}

	host, portText, err := net.SplitHostPort(rest)
	if err != nil {
		return proxyEndpoint{}, fmt.Errorf("want host:port with the port written out")
	}
	if host == "" {
		return proxyEndpoint{}, fmt.Errorf("no host")
	}
	// strconv.Atoi alone would accept "+1055" and "-0"; a port is digits.
	if portText == "" || strings.TrimLeft(portText, "0123456789") != "" {
		return proxyEndpoint{}, fmt.Errorf("port %q is not a number", portText)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return proxyEndpoint{}, fmt.Errorf("port %q out of range 1-65535", portText)
	}
	return proxyEndpoint{Host: host, Port: port}, nil
}

// remoteSpec is one entry in the fleet.
//
// `Name` is the routing key everywhere: it must equal that daemon's own host id
// and the `shuttle.host` its fibers carry. `Display` is presentation only and is
// never accepted as an address — two ways to name one origin is exactly how a
// mis-stamped origin silently degrades to local.
type remoteSpec struct {
	Name       string `json:"name"`
	Display    string `json:"display,omitempty"`
	SSH        string `json:"ssh,omitempty"`
	Port       int    `json:"port,omitempty"`
	RemotePort int    `json:"remote_port,omitempty"`
	// RemoteSocket: the daemon's unix socket on the remote host, forwarded in
	// place of remote_port — a shared-multi-user remote listens on no TCP port
	// at all. Absolute; mutually exclusive with remote_port.
	RemoteSocket string        `json:"remote_socket,omitempty"`
	URL          string        `json:"url,omitempty"`
	Enabled      *bool         `json:"enabled,omitempty"`
	Tunnel       *remoteTunnel `json:"tunnel,omitempty"`

	PollIntervalMS   int `json:"poll_interval_ms,omitempty"`
	RequestTimeoutMS int `json:"request_timeout_ms,omitempty"`
	StaleMultiplier  int `json:"stale_multiplier,omitempty"`

	// Deploy-side fields. Carried so the fleet stops being described in four
	// places; not read by the CLI or the daemon yet.
	Checkout string   `json:"checkout,omitempty"`
	Auth     string   `json:"auth,omitempty"`
	SSHFlags []string `json:"ssh_flags,omitempty"`
}

// remotesFile is the whole document: fleet-wide settings plus the entries.
type remotesFile struct {
	Version            int             `json:"version"`
	LaunchdLabelPrefix string          `json:"launchd_label_prefix,omitempty"`
	Defaults           *remoteDefaults `json:"defaults,omitempty"`
	Remotes            []remoteSpec    `json:"remotes"`
}

// enabledOr reports whether the entry participates. Absent `enabled` means yes;
// `false` keeps the entry on file without polling or tunnelling it.
func (r remoteSpec) enabledOr() bool {
	return r.Enabled == nil || *r.Enabled
}

// tunnelOpts is the entry's tunnel policy, zero-valued when the file omits the
// block. Pointer-typed on the struct so a saved file stays sparse.
func (r remoteSpec) tunnelOpts() remoteTunnel {
	if r.Tunnel == nil {
		return remoteTunnel{}
	}
	return *r.Tunnel
}

// label is the launchd job label for this remote's tunnel.
func (r remoteSpec) label(prefix string) string {
	if opts := r.tunnelOpts(); opts.Label != "" {
		return opts.Label
	}
	if prefix == "" {
		prefix = defaultLaunchdLabelPrefix
	}
	return fmt.Sprintf("%s.shuttle-tunnel-%s", prefix, r.Name)
}

// unitName is the systemd user unit for this remote's tunnel — the Linux analog
// of label(). No reverse-DNS prefix: a unit name is a file name, and the
// daemon's own unit is shuttle-daemon.service, so a tunnel is
// shuttle-tunnel-<name>.service and one naming rule covers both. An explicit
// tunnel.label still wins, gaining the suffix systemd requires.
func (r remoteSpec) unitName() string {
	if opts := r.tunnelOpts(); opts.Label != "" {
		if strings.HasSuffix(opts.Label, ".service") {
			return opts.Label
		}
		return opts.Label + ".service"
	}
	return fmt.Sprintf("shuttle-tunnel-%s.service", r.Name)
}

// managedTunnel reports whether the fleet hands this remote's tunnel to a
// supervisor on this host. Both supervisor names count: the fleet file says
// that the tunnel is managed, and the hub decides with what.
func managedTunnel(manager string) bool {
	return manager == "launchd" || manager == "systemd"
}

// feltRemotesPath is the canonical fleet file location for reads AND writes:
// $FELT_REMOTES_FILE, else ~/.config/felt/remotes.json.
func feltRemotesPath() (string, error) {
	return feltConfigPath("FELT_REMOTES_FILE", "remotes.json")
}

// loadRemotesFileRaw parses the fleet file WITHOUT filling defaults. Edit verbs
// use it so a round-trip through `add`/`rm` never materializes every default
// into the file and pins values the reader should keep deciding.
func loadRemotesFileRaw() (remotesFile, error) {
	path, err := feltRemotesPath()
	if err != nil {
		return remotesFile{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return remotesFile{Version: 1}, nil
		}
		return remotesFile{}, fmt.Errorf("reading %s: %w", path, err)
	}

	// Tolerate both shapes the Elixir reader accepts:
	//   {"version": 1, "remotes": [...]}  ← canonical
	//   [...]                             ← bare list
	var doc remotesFile
	if err := json.Unmarshal(content, &doc); err != nil {
		var bare []remoteSpec
		if berr := json.Unmarshal(content, &bare); berr != nil {
			return remotesFile{}, fmt.Errorf("parsing %s: %w", path, err)
		}
		doc = remotesFile{Version: 1, Remotes: bare}
	}
	return doc, nil
}

// loadRemotesFile reads and normalizes the fleet file. A missing file yields an
// empty, valid document with no error. A malformed one is an error naming the
// path — the CLI is the fleet's validator, so it fails loud rather than
// silently degrading to "no remotes".
func loadRemotesFile() (remotesFile, error) {
	doc, err := loadRemotesFileRaw()
	if err != nil {
		return remotesFile{}, err
	}
	if err := normalizeRemotes(&doc); err != nil {
		path, _ := feltRemotesPath()
		return remotesFile{}, fmt.Errorf("%s: %w", path, err)
	}
	return doc, nil
}

// configuredRemotes returns the normalized, enabled fleet in file order.
func configuredRemotes() ([]remoteSpec, error) {
	doc, err := loadRemotesFile()
	if err != nil {
		return nil, err
	}
	out := make([]remoteSpec, 0, len(doc.Remotes))
	for _, r := range doc.Remotes {
		if r.enabledOr() {
			out = append(out, r)
		}
	}
	return out, nil
}

// normalizeRemotes fills every default in place and validates the fleet.
//
// Validation is fail-loud on the things that silently break routing: a nameless
// entry has no routing key, a duplicate name means two daemons answer to one
// origin, and a duplicate local port means one tunnel shadows another.
func normalizeRemotes(doc *remotesFile) error {
	if doc.LaunchdLabelPrefix == "" {
		doc.LaunchdLabelPrefix = defaultLaunchdLabelPrefix
	}

	defaults := remoteDefaults{}
	if doc.Defaults != nil {
		defaults = *doc.Defaults
		if _, err := defaults.normalizedHTTPSProxy(); err != nil {
			return fmt.Errorf("defaults.https_proxy %q: %w", strings.TrimSpace(defaults.HTTPSProxy), err)
		}
	}

	seenNames := map[string]bool{}
	seenPorts := map[int]string{}

	for i := range doc.Remotes {
		r := &doc.Remotes[i]

		r.Name = strings.TrimSpace(r.Name)
		if r.Name == "" {
			return fmt.Errorf("remote #%d: name is required", i+1)
		}
		if seenNames[r.Name] {
			return fmt.Errorf("duplicate remote name %q", r.Name)
		}
		seenNames[r.Name] = true

		// ssh defaults to the name ONLY for a port-forwarded entry, where the
		// ssh destination and the routing name are the same thing by
		// construction. A bare `url` entry naming no ssh has no ssh path at
		// all, and the daemon's recovery cascade reads that empty string as
		// "HTTP is the only way in; report it stale" rather than shelling
		// `ssh <name>` at a host it was never given credentials to.
		if r.SSH == "" && r.Port != 0 {
			r.SSH = r.Name
		}
		if r.Display == "" {
			r.Display = r.Name
		}
		r.RemoteSocket = strings.TrimSpace(r.RemoteSocket)
		if r.RemoteSocket != "" {
			if r.RemotePort != 0 {
				return fmt.Errorf("remote %q: remote_port and remote_socket are mutually exclusive; the remote daemon listens on one or the other", r.Name)
			}
			if err := validateRemoteSocket(r.RemoteSocket); err != nil {
				return fmt.Errorf("remote %q: remote_socket %q: %w", r.Name, r.RemoteSocket, err)
			}
		} else {
			if r.RemotePort == 0 {
				r.RemotePort = defaultRemoteDaemonPort
			}
			if r.RemotePort < 1 || r.RemotePort > 65535 {
				return fmt.Errorf("remote %q: remote_port %d out of range 1-65535", r.Name, r.RemotePort)
			}
		}

		if r.Port != 0 {
			if r.Port < 1 || r.Port > 65535 {
				return fmt.Errorf("remote %q: port %d out of range 1-65535", r.Name, r.Port)
			}
			if other, dup := seenPorts[r.Port]; dup {
				return fmt.Errorf("remote %q: port %d already used by %q", r.Name, r.Port, other)
			}
			seenPorts[r.Port] = r.Name
		} else if r.URL == "" {
			return fmt.Errorf("remote %q: needs a port or an explicit url", r.Name)
		}

		if r.URL == "" {
			r.URL = fmt.Sprintf("http://127.0.0.1:%d", r.Port)
		}

		// Replace rather than mutate through the pointer: a caller may be
		// validating a shallow copy of a sparse document it intends to SAVE
		// (see `remotes add`), and filling the default in place would write the
		// default into the file.
		//
		// The default manager follows the entry's TRANSPORT, not just the host.
		// A tunnel is a local forwarded port; an entry with no `port` has no
		// forward for this host to supervise, so there is no job to write and
		// its manager is `none` however good a supervisor this hub has. Letting
		// defaultTunnelManager() answer for a portless entry is what produced a
		// unit with `-L 0:localhost:4000` and no ssh destination — a job that
		// can never come up, and which the convergent prune then protects
		// because the fleet file still asks for it.
		//
		// An entry that names a supervisor explicitly while having no port is
		// that same contradiction stated by hand, so it is refused here rather
		// than installed: `remotes list` is the fleet's validator, and the
		// operator who wrote it meant one of two things we must not guess
		// between (give the entry a port, or say `manager: none`).
		opts := r.tunnelOpts()
		switch {
		case opts.Manager == "" && r.Port != 0:
			opts.Manager = defaultTunnelManager()
		case opts.Manager == "":
			opts.Manager = "none"
		case r.Port == 0 && managedTunnel(opts.Manager):
			return fmt.Errorf(
				"remote %q: tunnel.manager %q needs a local port to forward; give it a `port`, or set tunnel.manager to \"none\" if it is reached directly",
				r.Name, opts.Manager)
		}
		r.Tunnel = &opts

		if r.PollIntervalMS == 0 {
			r.PollIntervalMS = firstNonZero(defaults.PollIntervalMS, defaultRemotePollIntervalMS)
		}
		if r.RequestTimeoutMS == 0 {
			r.RequestTimeoutMS = firstNonZero(defaults.RequestTimeoutMS, defaultRemoteRequestTimeoutMS)
		}
		if r.StaleMultiplier == 0 {
			r.StaleMultiplier = firstNonZero(defaults.StaleMultiplier, defaultRemoteStaleMultiplier)
		}
		if r.PollIntervalMS < 1 {
			return fmt.Errorf("remote %q: poll_interval_ms must be positive", r.Name)
		}
		if r.RequestTimeoutMS < 1 {
			return fmt.Errorf("remote %q: request_timeout_ms must be positive", r.Name)
		}
		if r.StaleMultiplier < 1 {
			return fmt.Errorf("remote %q: stale_multiplier must be positive", r.Name)
		}
	}

	return nil
}

// remoteSocketPattern is the whole alphabet a remote socket path may use. It
// is an allowlist because the path is rendered into a launchd plist (XML), a
// systemd unit, and a `sh -c` loop: no quote, "$", backtick, "<", "&", "%",
// ":" (the -L field separator) or whitespace can reach any of them.
var remoteSocketPattern = regexp.MustCompile(`^/[A-Za-z0-9._/@+-]+$`)

// validateRemoteSocket checks a remote socket path for what `ssh -L` and the
// job templates can carry: an absolute, clean path in the allowlisted
// alphabet. Its length is the remote kernel's business and is checked there,
// by the remote's own `host --json`.
func validateRemoteSocket(path string) error {
	if !remoteSocketPattern.MatchString(path) {
		return fmt.Errorf("must be an absolute path of letters, digits and . _ / @ + - only")
	}
	if filepath.Clean(path) != path {
		return fmt.Errorf("must be a clean path (no '..', '.', '//' or trailing '/')")
	}
	return nil
}

// defaultTunnelManager: a hub manages its tunnels with whatever supervisor it
// has — launchd on macOS, systemd --user on Linux. Anywhere else there is
// neither, so a remote with no explicit policy is assumed already reachable and
// the daemon's recovery cascade goes straight to the ssh check.
//
// The Elixir reader (Shuttle.Remote.default_tunnel_manager/0) splits the same
// question differently on purpose, and the two are not drifting: this value
// decides what the Go installer WRITES, while the daemon's decides what its
// recovery cascade BOUNCES — and the cascade only knows `launchctl kickstart`,
// so on Linux it reads a managed tunnel as unbounceable and advances to the ssh
// check instead.
func defaultTunnelManager() string {
	switch hostGOOS {
	case "darwin":
		return "launchd"
	case "linux":
		return "systemd"
	}
	return "none"
}

func firstNonZero(values ...int) int {
	for _, v := range values {
		if v != 0 {
			return v
		}
	}
	return 0
}

// saveRemotes writes the fleet atomically (tmp + rename). An empty fleet deletes
// the file, matching the stores/projects writers.
func saveRemotes(doc remotesFile) error {
	path, err := feltRemotesPath()
	if err != nil {
		return err
	}
	if len(doc.Remotes) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("removing %s: %w", path, err)
		}
		return nil
	}
	if doc.Version == 0 {
		doc.Version = 1
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename %s: %w", tmp, err)
	}
	return nil
}

// ── CLI ──

var (
	remotesAddSSH        string
	remotesAddDisplay    string
	remotesAddPort       int
	remotesAddRemotePort int
	remotesAddRemoteSock string
	remotesAddCheckout   string
	remotesAddMultiplex  bool
	remotesAddURL        string
	remotesAddTunnel     string
)

var remotesCmd = &cobra.Command{
	Use:   "remotes",
	Short: "Inspect and edit the remote shuttle daemon fleet",
	Long: `The fleet file lists the other shuttle daemons this host aggregates:
one name, one local tunnel port, and how to reach each.

The daemon reads the same file directly — this command edits and validates it,
it is not the transport. ` + "`list`" + ` is also the validator: it reports parse
errors, duplicate names, and port collisions.

Examples:
  felt shuttle remotes list
  felt shuttle remotes add hub-a --port 4001
  felt shuttle remotes add hub-b --port 4004 --multiplex
  felt shuttle remotes add hub-d --port 4005 --remote-socket /home/op/.shuttle/sock/daemon.sock
  felt shuttle remotes add hub-c --url https://hub-c.example.ts.net
  felt shuttle remotes rm hub-a
  felt shuttle remotes path`,
}

var remotesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the configured remotes",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		doc, err := loadRemotesFile()
		if err != nil {
			return err
		}
		if jsonOutput {
			return outputJSON(doc)
		}
		if len(doc.Remotes) == 0 {
			path, _ := feltRemotesPath()
			fmt.Printf("no remotes configured (%s)\n", path)
			return nil
		}
		if doc.Defaults != nil {
			// loadRemotesFile has already refused a proxy that does not parse,
			// so reaching here means the error is nil; the human line is the
			// only thing left to do with it.
			if proxy, _ := doc.Defaults.normalizedHTTPSProxy(); proxy.configured() {
				fmt.Printf("https:// remotes via proxy %s\n\n", proxy)
			}
		}
		fmt.Printf("%-16s %-6s %-18s %-12s %s\n", "NAME", "PORT", "SSH", "TUNNEL", "URL")
		for _, r := range doc.Remotes {
			opts := r.tunnelOpts()
			tunnel := opts.Manager
			if opts.Multiplex {
				tunnel += "+mux"
			}
			if !r.enabledOr() {
				tunnel = "disabled"
			}
			// A url remote has no local port and no ssh destination; "-" says
			// that, where 0 and "" read as a value that failed to load.
			port, ssh := "-", "-"
			if r.Port != 0 {
				port = strconv.Itoa(r.Port)
			}
			if r.SSH != "" {
				ssh = r.SSH
			}
			fmt.Printf("%-16s %-6s %-18s %-12s %s\n", r.Name, port, ssh, tunnel, r.URL)
			if r.Port == defaultRemoteDaemonPort {
				fmt.Fprintf(os.Stderr,
					"warning: remote %q uses port %d, which the local daemon binds\n",
					r.Name, defaultRemoteDaemonPort)
			}
		}
		return nil
	},
}

var remotesAddCmd = &cobra.Command{
	Use:   "add <name>",
	Short: "Add or replace a remote",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		doc, err := loadRemotesFileRaw()
		if err != nil {
			return err
		}
		entry := remoteSpec{
			Name:         args[0],
			SSH:          remotesAddSSH,
			Display:      remotesAddDisplay,
			Port:         remotesAddPort,
			RemotePort:   remotesAddRemotePort,
			URL:          remotesAddURL,
			RemoteSocket: remotesAddRemoteSock,
			Checkout:     remotesAddCheckout,
		}
		// No manager is written unless the operator asked for one: an entry with
		// no port already reads as `none` and a port entry already reads as this
		// host's supervisor (see normalizeRemotes), and materializing either
		// into the file would pin a decision the reader should keep making —
		// which matters because the same file is carried between a Mac hub and a
		// Linux one.
		if remotesAddMultiplex || remotesAddTunnel != "" {
			entry.Tunnel = &remoteTunnel{Multiplex: remotesAddMultiplex, Manager: remotesAddTunnel}
		}
		replaced := false
		for i := range doc.Remotes {
			if doc.Remotes[i].Name == args[0] {
				doc.Remotes[i] = entry
				replaced = true
				break
			}
		}
		if !replaced {
			doc.Remotes = append(doc.Remotes, entry)
		}
		// Validate a normalized copy; persist the sparse one.
		check := doc
		check.Remotes = append([]remoteSpec(nil), doc.Remotes...)
		if err := normalizeRemotes(&check); err != nil {
			return err
		}
		if err := saveRemotes(doc); err != nil {
			return err
		}
		path, _ := feltRemotesPath()
		fmt.Printf("saved %s (%s)\n", args[0], path)
		return nil
	},
}

var remotesRmCmd = &cobra.Command{
	Use:   "rm <name>",
	Short: "Remove a remote",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		doc, err := loadRemotesFileRaw()
		if err != nil {
			return err
		}
		kept := make([]remoteSpec, 0, len(doc.Remotes))
		found := false
		for _, r := range doc.Remotes {
			if r.Name == args[0] {
				found = true
				continue
			}
			kept = append(kept, r)
		}
		if !found {
			return fmt.Errorf("unknown remote %q (configured: %s)", args[0], remoteNameList(doc.Remotes))
		}
		doc.Remotes = kept
		if err := saveRemotes(doc); err != nil {
			return err
		}
		fmt.Printf("removed %s\n", args[0])
		return nil
	},
}

var remotesPathCmd = &cobra.Command{
	Use:   "path",
	Short: "Print the fleet file path",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		path, err := feltRemotesPath()
		if err != nil {
			return err
		}
		fmt.Println(path)
		return nil
	},
}

// remoteNameList renders the configured names for an error message.
func remoteNameList(remotes []remoteSpec) string {
	if len(remotes) == 0 {
		return "none"
	}
	names := make([]string, 0, len(remotes))
	for _, r := range remotes {
		names = append(names, r.Name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func init() {
	remotesAddCmd.Flags().StringVar(&remotesAddSSH, "ssh", "", "SSH destination (default: the remote name)")
	remotesAddCmd.Flags().StringVar(&remotesAddDisplay, "display", "", "Presentation label (default: the remote name)")
	remotesAddCmd.Flags().IntVar(&remotesAddPort, "port", 0, "Local forwarded port (required)")
	remotesAddCmd.Flags().IntVar(&remotesAddRemotePort, "remote-port", 0, "Daemon port on the remote host (default: 4000)")
	remotesAddCmd.Flags().StringVar(&remotesAddRemoteSock, "remote-socket", "", "Daemon unix socket on the remote host, forwarded instead of --remote-port")
	remotesAddCmd.Flags().StringVar(&remotesAddURL, "url", "", "Reach the daemon at this URL outright, instead of through a local tunnel port")
	remotesAddCmd.Flags().StringVar(&remotesAddTunnel, "tunnel-manager", "", "launchd | systemd | none (default: this host's supervisor for a --port entry, none without one)")
	remotesAddCmd.Flags().StringVar(&remotesAddCheckout, "checkout", "", "Repo checkout path on the remote host (deploy metadata)")
	remotesAddCmd.Flags().BoolVar(&remotesAddMultiplex, "multiplex", false, "Ride an existing ControlMaster socket (2FA hosts)")
	remotesCmd.AddCommand(remotesListCmd, remotesAddCmd, remotesRmCmd, remotesPathCmd)
	shuttleCmd.AddCommand(remotesCmd)
}
