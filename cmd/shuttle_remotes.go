package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

// The remote-daemon fleet: which other shuttle daemons this host knows about,
// what local port each one's SSH tunnel lands on, and how to reach them.
//
// This is the Go half of a two-reader contract. `Shuttle.Remotes` (Elixir) reads
// the same file with the same defaults, and `test/fixtures/remotes/*.json` is
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
	// "none" (the remote is reachable without a locally-managed tunnel).
	// Defaults to the hub's own supervisor — launchd on darwin, systemd on
	// linux — and to none anywhere else. The two managed values are
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

// remoteDefaults are the file-level fallbacks for the per-remote polling knobs.
type remoteDefaults struct {
	PollIntervalMS   int `json:"poll_interval_ms,omitempty"`
	RequestTimeoutMS int `json:"request_timeout_ms,omitempty"`
	StaleMultiplier  int `json:"stale_multiplier,omitempty"`
}

// remoteSpec is one entry in the fleet.
//
// `Name` is the routing key everywhere: it must equal that daemon's own host id
// and the `shuttle.host` its fibers carry. `Display` is presentation only and is
// never accepted as an address — two ways to name one origin is exactly how a
// mis-stamped origin silently degrades to local.
type remoteSpec struct {
	Name       string        `json:"name"`
	Display    string        `json:"display,omitempty"`
	SSH        string        `json:"ssh,omitempty"`
	Port       int           `json:"port,omitempty"`
	RemotePort int           `json:"remote_port,omitempty"`
	URL        string        `json:"url,omitempty"`
	Enabled    *bool         `json:"enabled,omitempty"`
	Tunnel     *remoteTunnel `json:"tunnel,omitempty"`

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
	if env := os.Getenv("FELT_REMOTES_FILE"); env != "" {
		return expandUserPath(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "felt", "remotes.json"), nil
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

		if r.SSH == "" {
			r.SSH = r.Name
		}
		if r.Display == "" {
			r.Display = r.Name
		}
		if r.RemotePort == 0 {
			r.RemotePort = defaultRemoteDaemonPort
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
		opts := r.tunnelOpts()
		if opts.Manager == "" {
			opts.Manager = defaultTunnelManager()
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
	remotesAddCheckout   string
	remotesAddMultiplex  bool
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
			fmt.Printf("%-16s %-6d %-18s %-12s %s\n", r.Name, r.Port, r.SSH, tunnel, r.URL)
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
			Name:       args[0],
			SSH:        remotesAddSSH,
			Display:    remotesAddDisplay,
			Port:       remotesAddPort,
			RemotePort: remotesAddRemotePort,
			Checkout:   remotesAddCheckout,
		}
		if remotesAddMultiplex {
			entry.Tunnel = &remoteTunnel{Multiplex: true}
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
	remotesAddCmd.Flags().StringVar(&remotesAddCheckout, "checkout", "", "Repo checkout path on the remote host (deploy metadata)")
	remotesAddCmd.Flags().BoolVar(&remotesAddMultiplex, "multiplex", false, "Ride an existing ControlMaster socket (2FA hosts)")
	remotesCmd.AddCommand(remotesListCmd, remotesAddCmd, remotesRmCmd, remotesPathCmd)
	shuttleCmd.AddCommand(remotesCmd)
}
