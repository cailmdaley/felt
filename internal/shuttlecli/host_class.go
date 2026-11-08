package shuttlecli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// hostSettings is the resolved class and listener (shuttle.ResolveHostConfig)
// — and, as the output of `shuttle host --json`, the wire format the daemon
// validates against and takes its host id from.
type hostSettings struct {
	ID           string `json:"id"`
	Class        string `json:"class"`
	Terminal     string `json:"terminal"`
	ClassSource  string `json:"class_source"`
	Listen       string `json:"listen"`
	ListenSource string `json:"listen_source"`
	File         string `json:"file"`
	// DataDir is shuttle.DataDir(a.env): the resolved host-local state directory, so
	// a shell (the stop-marker writers) applies the same trim and leading-~
	// rule the CLI and the daemon share. Empty when it cannot be resolved.
	DataDir string `json:"data_dir"`

	listen shuttle.Listener
}

// hostClassFilePath is $SHUTTLE_HOST_CONFIG_FILE, else ~/.config/shuttle/host.json.
func (a *app) hostClassFilePath() (string, error) { return shuttle.HostConfigFile(a.env) }

// resolveHostSettings resolves class and listener from the environment and
// the host file. It does not resolve the host id; the verb adds that.
func (a *app) resolveHostSettings() (hostSettings, error) {
	c, err := shuttle.ResolveHostConfig(a.env)
	if err != nil {
		return hostSettings{}, err
	}
	return hostSettings{
		Class: string(c.Class), Terminal: c.Terminal, ClassSource: c.ClassSource,
		Listen: c.Listen.String(), ListenSource: c.ListenSource, File: c.File, DataDir: c.DataDir,
		listen: c.Listen,
	}, nil
}

// writeHostClass sets "class" in the host file, keeping every other key. A
// malformed file is refused rather than overwritten: it may hold a listener
// someone chose on purpose. The write is atomic and 0600.
func (a *app) writeHostClass(class shuttle.HostClass) (string, error) {
	if !class.Valid() {
		return "", shuttle.HostErr(shuttle.HostErrBadClass, "class %q is not one of %s", class, shuttle.HostClassList())
	}
	path, err := a.hostClassFilePath()
	if err != nil {
		return "", err
	}
	doc, err := shuttle.ReadHostFile(path)
	if err != nil {
		return "", err
	}
	if doc == nil {
		doc = map[string]json.RawMessage{}
	}
	doc["class"], _ = json.Marshal(string(class))
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	if err := atomicfile.Write(path, payload, 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	return path, nil
}

// ── CLI ──

func (a *app) shuttleHostCmd() *cobra.Command {
	shuttleHostCmd := &cobra.Command{
		Use:   "host",
		Short: "Show this host's identity, class, and daemon listener",
		Long: `Report the host id the daemon dispatches as, the host class, and the
listener the daemon binds and the CLI dials.

The class says who else can reach this machine and sets the default listener
($SHUTTLE_LISTEN or the host file's "listen" overrides it):
  single-user          nobody else logs in; the daemon listens on 127.0.0.1
  shared-multi-user    other users log in; the daemon listens on a unix socket
  exposed              reachable from outside; the daemon listens on a unix socket

--json prints {id, class, terminal, class_source, listen, listen_source, file, data_dir}.
The daemon reads its host id from it at boot, and shells it as the validator:
a malformed host file fails here, naming its path. data_dir is the resolved
host-local state directory ($SHUTTLE_DATA_DIR trimmed, a leading ~ expanded,
else ~/.shuttle); the stop scripts touch its heartbeat.stopped.

Examples:
  shuttle host
  shuttle host --json
  shuttle host seed
  shuttle host class shared-multi-user`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			id, source, err := a.resolveOwnHostSourced("")
			if err != nil {
				return err
			}
			s.ID = id
			if a.json {
				// Shells scrape data_dir and listen out of this with sed, so a
				// path's & < > print as themselves rather than &-style.
				enc := json.NewEncoder(a.env.Stdout)
				enc.SetIndent("", "  ")
				enc.SetEscapeHTML(false)
				return enc.Encode(s)
			}
			fmt.Fprintf(a.env.Stdout, "id      %s (%s)\n", s.ID, source.describe(a.hostConfigFilePath()))
			fmt.Fprintf(a.env.Stdout, "class   %s (%s)\n", s.Class, describeHostSource(s.ClassSource, s.File))
			fmt.Fprintf(a.env.Stdout, "listen  %s (%s)\n", s.Listen, describeHostSource(s.ListenSource, s.File))
			fmt.Fprintf(a.env.Stdout, "data    %s\n", s.DataDir)
			return nil
		},
	}
	shuttleHostCmd.AddCommand(a.shuttleHostClassCmd())
	shuttleHostCmd.AddCommand(a.shuttleHostCheckOwnerCmd())
	shuttleHostCmd.AddCommand(a.shuttleHostSeedCmd())
	return shuttleHostCmd
}

func (a *app) shuttleHostCheckOwnerCmd() *cobra.Command {
	shuttleHostCheckOwnerCmd := &cobra.Command{
		Use:   "check-owner",
		Short: "Verify ownership of the resolved daemon TCP listener",
		Long: `Check a socket-class TCP listener by connecting and matching the server-side
established row in /proc/net/tcp{,6}. A refused connection means no listener
is running yet. Unix listeners, non-socket classes, and platforms without
Linux /proc need no check.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			return checkResolvedDaemonPortOwner(settings)
		},
	}
	return shuttleHostCheckOwnerCmd
}

func (a *app) shuttleHostClassCmd() *cobra.Command {
	shuttleHostClassCmd := &cobra.Command{
		Use:       "class <single-user|shared-multi-user|exposed>",
		Short:     "Declare this host's class in the host file",
		Args:      cobra.ExactArgs(1),
		ValidArgs: []string{string(shuttle.HostClassSingleUser), string(shuttle.HostClassShared), string(shuttle.HostClassExposed)},
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := a.writeHostClass(shuttle.HostClass(args[0]))
			if err != nil {
				return err
			}
			s, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			fmt.Fprintf(a.env.Stdout, "class %s saved to %s; the daemon listens on %s after its next restart\n", s.Class, path, s.Listen)
			return nil
		},
	}
	return shuttleHostClassCmd
}

func (a *app) shuttleHostSeedCmd() *cobra.Command {
	shuttleHostSeedCmd := &cobra.Command{
		Use:   "seed",
		Short: "Write this host's identity to the host file if it holds none",
		Long: `Make this machine's host id durable in the host file ($SHUTTLE_HOST_FILE,
else ~/.shuttle/host), creating its directory.

An id already in the file is kept. Otherwise $SHUTTLE_HOST, else the
normalized OS hostname, is written, so the daemon and every later CLI call
resolve the same name. shuttle daemon install runs this before it starts
the daemon it supervises.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			id, source, seeded, err := a.seedOwnHost()
			if err != nil {
				return err
			}
			path := a.hostConfigFilePath()
			switch {
			case !seeded:
				fmt.Fprintf(a.env.Stdout, "host identity → %s   (%s)\n", id, path)
			case source == hostSourceEnv:
				fmt.Fprintf(a.env.Stdout, "host identity → %s   (seeded from $SHUTTLE_HOST into %s)\n", id, path)
			default:
				fmt.Fprintf(a.env.Stdout, "host identity → %s   (seeded from this machine's hostname into %s)\n", id, path)
			}
			return nil
		},
	}
	return shuttleHostSeedCmd
}

func describeHostSource(source, file string) string {
	switch source {
	case shuttle.HostSourceHostFile:
		return file
	case shuttle.HostSourceListenEnv:
		return "$SHUTTLE_LISTEN"
	case shuttle.HostSourceClassDefault:
		return "class default"
	}
	return "default; no class in " + file
}
