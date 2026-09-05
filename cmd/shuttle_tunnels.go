package cmd

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"text/template"

	"github.com/spf13/cobra"
)

// felt shuttle tunnels — hub-side operator tooling that maps the remote shuttle
// daemons onto local ports via supervised autossh tunnels (so the daemon's
// owner-routing can reach a remote's :4000 over an SSH LocalForward). It is the
// typed setup command for the cross-host network; the running daemon owns the
// network at runtime, this just installs the plumbing.
//
// Two supervisors, one command: launchd LaunchAgents on macOS, systemd --user
// units on Linux. `autossh` is the transport on both — only the thing that
// keeps it alive differs, and tunnelSupervisor is where that difference lives.
// A Linux host with no systemd user session (an HPC login node usually has
// none) is refused before anything is written, rather than handed units that
// nothing will ever start.
//
// The fleet itself is NOT described here. Every name, port, and tunnel option
// comes from the shared fleet file (see shuttle_remotes.go), which the Elixir
// daemon reads too — so the job a tunnel is installed as and the launchd label
// the recovery cascade kickstarts cannot drift.
//
// Ported from shuttle-ctl's tunnels verb in the shuttle->felt merge. The job
// templates are go:embed'd (like the agents registry) so there is no on-disk
// share/ lookup — the binary is self-contained.

//go:embed shuttle-tunnel.plist.tmpl
var tunnelPlistTemplate string

//go:embed shuttle-tunnel.service.tmpl
var tunnelServiceTemplate string

// hostGOOS is runtime.GOOS behind a variable so the tests can render and place
// the other platform's job without a machine of that platform. Tests swap and
// restore it; nothing else assigns it.
var hostGOOS = runtime.GOOS

type tunnelSpec struct {
	Name       string
	SSHHost    string
	Label      string
	UnitName   string
	LocalPort  int
	RemotePort int
	// Multiplex: ride an existing ControlMaster socket (~/.ssh/ctl/%C, the
	// ssh-config ControlPath) instead of opening independent connections.
	// For a host behind interactive 2FA a fresh unattended ssh can never
	// authenticate, so the tunnel's only viable transport is the socket a
	// human-approved login left behind: alive → tunnel up for free; dead →
	// autossh retries harmlessly until the next approved `ssh <host>` login
	// revives the master, then the tunnel comes back on its own. Reuse-only —
	// ControlMaster stays "no" so a headless job never tries (and fails) to
	// *create* a master.
	Multiplex bool
}

type tunnelTemplateData struct {
	Label       string
	SSHHost     string
	LocalPort   int
	RemotePort  int
	AutoSSHPath string
	SSHAuthSock string
	LogPath     string
	Home        string
	Path        string
	Multiplex   bool
}

var (
	tunnelsJobDir    string
	tunnelsLogDir    string
	tunnelsAutoSSH   string
	tunnelsWriteOnly bool
)

// tunnelSupervisor is the host's job supervisor. It answers the questions
// install has to ask per platform: where a job file lives, what it is called,
// which template renders it, whether the host can run it at all, and how a
// written job is brought up.
type tunnelSupervisor struct {
	Name        string
	JobDir      string
	Template    string
	AutoSSHHint string
	// JobFile is the file name a spec's job is written as, inside JobDir.
	JobFile func(tunnelSpec) string
	// Preflight refuses, before anything is written, on a host that cannot run
	// the jobs. Nil where the supervisor is part of the OS and always there.
	Preflight func() error
	// Activate loads and (re)starts a written job, printing what it did.
	Activate func(spec tunnelSpec, path string) error
	// Note is printed once after a successful install; empty prints nothing.
	Note string
}

var tunnelsCmd = &cobra.Command{
	Use:   "tunnels",
	Short: "Install supervised autossh tunnels for shuttle remotes",
	Long: `Manage the hub-side autossh tunnels that map remote shuttle daemons
onto local ports. The generated jobs go to the host's own supervisor: launchd
LaunchAgents in ~/Library/LaunchAgents on macOS, systemd --user units in
~/.config/systemd/user on Linux. Single-host use needs no tunnels at all.

A Linux host with no systemd user session cannot start a unit, so install says
so and writes nothing; --write-only renders the units for you to supervise
yourself.

The remotes come from the fleet file (` + "`felt shuttle remotes path`" + `).

Examples:
  felt shuttle tunnels install              # every configured remote, write + start
  felt shuttle tunnels install <name>       # only that remote
  felt shuttle tunnels install --write-only # write job files but don't start them`,
}

var tunnelsInstallCmd = &cobra.Command{
	Use:   "install [name ...]",
	Short: "Write and optionally start the supervisor jobs for shuttle tunnels",
	Args:  cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return installTunnels(args)
	},
}

func installTunnels(requested []string) error {
	specs, err := resolveTunnelSpecs(requested)
	if err != nil {
		return err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home dir: %w", err)
	}
	sup, err := supervisorForHost(home)
	if err != nil {
		return err
	}

	// Probe before creating anything. A host that cannot start the jobs should
	// be left with no job directory and no half-installed fleet, and should
	// hear why. --write-only is an explicit "just render them", so it skips
	// the probe exactly as it skips the activation the probe guards.
	if !tunnelsWriteOnly && sup.Preflight != nil {
		if err := sup.Preflight(); err != nil {
			return err
		}
	}

	jobDir := tunnelsJobDir
	if jobDir == "" {
		jobDir = sup.JobDir
	}
	logDir := tunnelsLogDir
	if logDir == "" {
		logDir = filepath.Join(home, ".local", "state", "shuttle")
	}

	autosshPath := tunnelsAutoSSH
	if autosshPath == "" {
		autosshPath, err = exec.LookPath("autossh")
		if err != nil {
			return fmt.Errorf("autossh not found on PATH (install with `%s`, or pass --autossh-path)", sup.AutoSSHHint)
		}
	}

	if err := os.MkdirAll(jobDir, 0o755); err != nil {
		return fmt.Errorf("create job dir %s: %w", jobDir, err)
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return fmt.Errorf("create log dir %s: %w", logDir, err)
	}

	tmpl, err := template.New("shuttle-tunnel").Parse(sup.Template)
	if err != nil {
		return fmt.Errorf("parse embedded %s tunnel template: %w", sup.Name, err)
	}

	for _, spec := range specs {
		jobPath := filepath.Join(jobDir, sup.JobFile(spec))
		logPath := filepath.Join(logDir, fmt.Sprintf("tunnel-%s.log", spec.Name))

		rendered, err := renderTunnelJob(tmpl, tunnelTemplateData{
			Label:       spec.Label,
			SSHHost:     spec.SSHHost,
			LocalPort:   spec.LocalPort,
			RemotePort:  spec.RemotePort,
			Multiplex:   spec.Multiplex,
			AutoSSHPath: autosshPath,
			SSHAuthSock: os.Getenv("SSH_AUTH_SOCK"),
			LogPath:     logPath,
			Home:        home,
			// The PATH this command was typed with, which is the user's real
			// login PATH — the same value `make install-agent` reconstructs
			// with `bash -lc` because make may be invoked from anywhere. Only
			// the systemd template reads it (see its header); launchd's own
			// default PATH already finds ssh.
			Path: os.Getenv("PATH"),
		})
		if err != nil {
			return fmt.Errorf("render %s: %w", spec.Name, err)
		}
		if err := os.WriteFile(jobPath, rendered, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", jobPath, err)
		}

		fmt.Printf("installed %s -> %s\n", spec.Name, jobPath)
		fmt.Printf("  log: %s\n", logPath)

		if tunnelsWriteOnly {
			continue
		}
		if err := sup.Activate(spec, jobPath); err != nil {
			return fmt.Errorf("start %s: %w", spec.Name, err)
		}
	}

	if !tunnelsWriteOnly && sup.Note != "" {
		fmt.Println(sup.Note)
	}
	return nil
}

// supervisorForHost picks the keep-alive this machine actually has. The two
// arms mirror the daemon's own (share/io.shuttle.daemon.{plist,service}.template,
// selected by the Makefile's `uname -s` branch).
func supervisorForHost(home string) (tunnelSupervisor, error) {
	switch hostGOOS {
	case "darwin":
		return launchdSupervisor(home), nil
	case "linux":
		return systemdSupervisor(home), nil
	default:
		return tunnelSupervisor{}, fmt.Errorf(
			"no tunnel supervisor for %s (launchd on macOS, systemd --user on Linux)", hostGOOS)
	}
}

func launchdSupervisor(home string) tunnelSupervisor {
	uid := os.Getuid()
	return tunnelSupervisor{
		Name:        "launchd",
		JobDir:      filepath.Join(home, "Library", "LaunchAgents"),
		Template:    tunnelPlistTemplate,
		AutoSSHHint: "brew install autossh",
		JobFile:     func(spec tunnelSpec) string { return spec.Label + ".plist" },
		Activate: func(spec tunnelSpec, path string) error {
			target := fmt.Sprintf("gui/%d/%s", uid, spec.Label)
			// bootstrap refuses a label that is already loaded, and on a
			// reinstall it always is; booting it out first is the only way the
			// second install of a tunnel picks up the plist just written.
			// Nothing loaded is not an error, so the result is dropped.
			_ = runSupervisor("launchctl", "bootout", target)
			if err := runSupervisor("launchctl", "bootstrap", fmt.Sprintf("gui/%d", uid), path); err != nil {
				return err
			}
			if err := runSupervisor("launchctl", "kickstart", "-k", target); err != nil {
				return err
			}
			fmt.Printf("  bootstrapped %s\n", target)
			return nil
		},
	}
}

func systemdSupervisor(home string) tunnelSupervisor {
	return tunnelSupervisor{
		Name:        "systemd",
		JobDir:      filepath.Join(home, ".config", "systemd", "user"),
		Template:    tunnelServiceTemplate,
		AutoSSHHint: "apt install autossh",
		JobFile:     func(spec tunnelSpec) string { return spec.UnitName },
		Preflight:   requireSystemdUserSession,
		Activate: func(spec tunnelSpec, _ string) error {
			// daemon-reload per unit rather than once for the batch: it is
			// cheap and idempotent, and it keeps a partial install (one unit
			// written, the next one failing) from leaving systemd's view of
			// the units it already has stale.
			if err := runSupervisor("systemctl", "--user", "daemon-reload"); err != nil {
				return err
			}
			if err := runSupervisor("systemctl", "--user", "enable", spec.UnitName); err != nil {
				return err
			}
			// restart, not `enable --now`: --now starts a unit that is stopped
			// and leaves a running one alone, so reinstalling over a live
			// tunnel would keep serving the old unit. restart covers the first
			// install and every one after it — the analog of launchctl's
			// kickstart -k.
			if err := runSupervisor("systemctl", "--user", "restart", spec.UnitName); err != nil {
				return err
			}
			fmt.Printf("  enabled + started %s\n", spec.UnitName)
			return nil
		},
		Note: "tunnels survive logout and start at boot after:  loginctl enable-linger $(id -un)",
	}
}

// requireSystemdUserSession is the honest check before the Linux install writes
// anything. systemd --user is the Linux durable surface, but plenty of Linux
// hosts have none — an HPC login node often has no user manager reachable over
// ssh, and a container may have no systemd at all. There the units would be
// files nothing ever reads, and reporting success for tunnels that will never
// come up is worse than refusing.
func requireSystemdUserSession() error {
	if err := exec.Command("systemctl", "--user", "show-environment").Run(); err != nil {
		return fmt.Errorf(`no systemd user session here (systemctl --user is unavailable or not reachable); nothing was written.
Write the units anyway and supervise them yourself:
  felt shuttle tunnels install --write-only
Or hold one up by hand, in a tmux session that outlives your login:
  autossh -M 0 -N -L <local>:localhost:<remote> <host>`)
	}
	return nil
}

// resolveTunnelSpecs turns the configured fleet into the tunnels to install.
//
// With no arguments it is every enabled remote whose tunnel is supervisor-
// managed. With arguments it is exactly those remotes, and an unknown one is an
// error that names what IS configured — the fleet lives in one file, so the
// error can always be specific.
func resolveTunnelSpecs(requested []string) ([]tunnelSpec, error) {
	doc, err := loadRemotesFile()
	if err != nil {
		return nil, err
	}

	byName := make(map[string]remoteSpec, len(doc.Remotes))
	for _, r := range doc.Remotes {
		byName[r.Name] = r
	}

	toSpec := func(r remoteSpec) tunnelSpec {
		return tunnelSpec{
			Name:       r.Name,
			SSHHost:    r.SSH,
			Label:      r.label(doc.LaunchdLabelPrefix),
			UnitName:   r.unitName(),
			LocalPort:  r.Port,
			RemotePort: r.RemotePort,
			Multiplex:  r.tunnelOpts().Multiplex,
		}
	}

	if len(requested) == 0 {
		if len(doc.Remotes) == 0 {
			path, _ := feltRemotesPath()
			return nil, fmt.Errorf(
				"no remotes configured; run 'felt shuttle remotes add <name> --port <n>' (file: %s)", path)
		}
		resolved := make([]tunnelSpec, 0, len(doc.Remotes))
		for _, r := range doc.Remotes {
			if !r.enabledOr() || !managedTunnel(r.tunnelOpts().Manager) {
				continue
			}
			resolved = append(resolved, toSpec(r))
		}
		if len(resolved) == 0 {
			return nil, fmt.Errorf("no remotes use a supervisor-managed tunnel (configured: %s)",
				remoteNameList(doc.Remotes))
		}
		sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
		return resolved, nil
	}

	resolved := make([]tunnelSpec, 0, len(requested))
	seen := map[string]bool{}
	for _, name := range requested {
		r, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("unknown tunnel %q (configured: %s)", name, remoteNameList(doc.Remotes))
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		resolved = append(resolved, toSpec(r))
	}
	sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
	return resolved, nil
}

func renderTunnelJob(tmpl *template.Template, data tunnelTemplateData) ([]byte, error) {
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// runSupervisor shells the host's job supervisor and folds its output into the
// error, which is where launchctl and systemctl both say what actually went
// wrong.
func runSupervisor(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := string(bytes.TrimSpace(out))
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("%s %v: %s", bin, args, msg)
}

func init() {
	tunnelsInstallCmd.Flags().StringVar(&tunnelsJobDir, "unit-dir", "", "Directory to write supervisor jobs into (default: ~/Library/LaunchAgents on macOS, ~/.config/systemd/user on Linux)")
	tunnelsInstallCmd.Flags().StringVar(&tunnelsLogDir, "log-dir", "", "Directory for autossh logs (default: ~/.local/state/shuttle)")
	tunnelsInstallCmd.Flags().StringVar(&tunnelsAutoSSH, "autossh-path", "", "Path to autossh (default: resolve on PATH)")
	tunnelsInstallCmd.Flags().BoolVar(&tunnelsWriteOnly, "write-only", false, "Write the job files but do not load or start them")
	tunnelsCmd.AddCommand(tunnelsInstallCmd)
	shuttleCmd.AddCommand(tunnelsCmd)
}
