package cmd

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	// RemoteSocket, when set, is the remote daemon's unix socket, forwarded in
	// place of RemotePort.
	RemoteSocket string
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
	Label     string
	SSHHost   string
	LocalPort int
	// Forward is the whole `ssh -L` argument; RemoteEnd names its far side
	// for a human (":4000" or a socket path).
	Forward     string
	RemoteEnd   string
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
	tunnelsDryRun    bool
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
	// Deactivate stops and unloads a job by its file name (not full path — the
	// convergent prune only ever knows a name it read back out of JobDir, not
	// a tunnelSpec, since the remote it once belonged to may no longer be in
	// the fleet file at all) and removes the job file. Unloading a job that
	// isn't currently loaded, or removing a file that is already gone, must
	// both be treated as success: prune runs unconditionally on every
	// convergent install, so "there was nothing to clean up" is the common
	// case, not an error.
	Deactivate func(jobFile, jobDir string) error
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

Run with no remote named, install is convergent: it writes and starts a job
for every remote the fleet file currently names with a managed tunnel, then
removes any job on this host, installed under our own naming convention, that
no remote in the file still asks for — a remote dropped from the file
entirely, or flipped to ` + "`manager: none`" + ` or ` + "`enabled: false`" + `, stops running
forever once you re-run install. Naming a remote installs (or reinstalls)
only that one and prunes nothing.

A Linux host with no systemd user session cannot start a unit, so install says
so and writes nothing; --write-only renders the units for you to supervise
yourself (and skips pruning too, since both touch the supervisor).

The remotes come from the fleet file (` + "`felt shuttle remotes path`" + `).

Examples:
  felt shuttle tunnels install                 # every configured remote, write + start + prune orphans
  felt shuttle tunnels install <name>          # only that remote, no pruning
  felt shuttle tunnels install --dry-run       # print what would be installed and removed, touching nothing
  felt shuttle tunnels install --write-only    # write job files but don't start them or prune`,
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
	// The all-remotes form is convergent: it installs every remote the fleet
	// file currently names with a managed tunnel, AND prunes every job on this
	// host that our own naming convention recognizes but the file no longer
	// backs. `install <name>` targets exactly the named remotes and prunes
	// nothing — a partial, single-remote install has no business deciding
	// what the rest of the fleet's jobs are for.
	convergent := len(requested) == 0

	var specs []tunnelSpec
	if convergent {
		doc, err := loadRemotesFile()
		if err != nil {
			return err
		}
		specs = resolveManagedTunnelSpecs(doc)
		if len(specs) == 0 {
			fmt.Println("no remotes use a supervisor-managed tunnel; checking for orphaned tunnel jobs")
		}
	} else {
		var err error
		specs, err = resolveTunnelSpecs(requested)
		if err != nil {
			return err
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home dir: %w", err)
	}
	sup, err := supervisorForHost(home)
	if err != nil {
		return err
	}

	jobDir := tunnelsJobDir
	if jobDir == "" {
		jobDir = sup.JobDir
	}

	// --dry-run is a preview of the WHOLE command, not of its last step. It
	// creates no directories, writes no job files, and shells no supervisor —
	// which means it also skips the systemd probe and the autossh lookup, since
	// both are questions only an install that is about to act needs answered,
	// and failing a preview on a missing autossh would hide the very listing the
	// operator asked for. Everything it would have done is printed instead, and
	// the command exits 0: the orphan listing below is the half people run this
	// for, and it used to be unreachable whenever an Activate failed first.
	if tunnelsDryRun {
		for _, spec := range specs {
			fmt.Printf("would install %s -> %s\n", spec.Name, filepath.Join(jobDir, sup.JobFile(spec)))
		}
		if convergent && !tunnelsWriteOnly {
			return pruneOrphanTunnels(sup, jobDir, specs, true)
		}
		return nil
	}

	if len(specs) > 0 {
		// Probe before creating anything. A host that cannot start the jobs
		// should be left with no job directory and no half-installed fleet,
		// and should hear why. --write-only is an explicit "just render
		// them", so it skips the probe exactly as it skips the activation the
		// probe guards.
		if !tunnelsWriteOnly && sup.Preflight != nil {
			if err := sup.Preflight(); err != nil {
				return err
			}
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
				Forward:     spec.forward(),
				RemoteEnd:   spec.remoteEnd(),
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
	}

	// --write-only means "render, don't touch the supervisor" — pruning stops
	// jobs and deletes files, which is exactly the touching write-only asks us
	// to skip, so it sits out this pass entirely rather than half-applying.
	if convergent && !tunnelsWriteOnly {
		if err := pruneOrphanTunnels(sup, jobDir, specs, false); err != nil {
			return err
		}
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
		Deactivate: func(jobFile, jobDir string) error {
			// A plist's file name IS its label plus ".plist" (see JobFile
			// above) — there is no other record of the label once the remote
			// it belonged to has left the fleet file, so recovering it from
			// the name is the only option, and it is exact by construction.
			label := jobFile[:len(jobFile)-len(".plist")]
			target := fmt.Sprintf("gui/%d/%s", uid, label)
			_ = runSupervisor("launchctl", "bootout", target)
			path := filepath.Join(jobDir, jobFile)
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
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
		Deactivate: func(jobFile, jobDir string) error {
			// Errors from stop/disable are swallowed the same way the
			// launchd arm swallows bootout: a unit systemd has already
			// forgotten (never loaded this boot, or already stopped) fails
			// both calls harmlessly, and that is not a reason to leave its
			// file behind.
			_ = runSupervisor("systemctl", "--user", "stop", jobFile)
			_ = runSupervisor("systemctl", "--user", "disable", jobFile)
			path := filepath.Join(jobDir, jobFile)
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			_ = runSupervisor("systemctl", "--user", "daemon-reload")
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

	if len(requested) == 0 {
		if len(doc.Remotes) == 0 {
			path, _ := feltRemotesPath()
			return nil, fmt.Errorf(
				"no remotes configured; run 'felt shuttle remotes add <name> --port <n>' (file: %s)", path)
		}
		resolved := resolveManagedTunnelSpecs(doc)
		if len(resolved) == 0 {
			return nil, fmt.Errorf("no remotes use a supervisor-managed tunnel (configured: %s)",
				remoteNameList(doc.Remotes))
		}
		return resolved, nil
	}

	byName := make(map[string]remoteSpec, len(doc.Remotes))
	for _, r := range doc.Remotes {
		byName[r.Name] = r
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
		// Belt and braces against a portless entry reaching the templates.
		// normalizeRemotes already refuses `manager: launchd|systemd` without a
		// port, so this is unreachable through the fleet file today; it stays
		// because the failure it guards is silent and durable — a rendered
		// `-L 0:localhost:4000` with no ssh destination is a job that can never
		// come up, and once written the convergent prune protects it, because
		// the file still names it. Refusing here costs one comparison and means
		// no future path into the resolvers can reintroduce that job.
		if r.Port == 0 {
			return nil, fmt.Errorf(
				"remote %q has no local port to forward; a tunnel needs one (or set tunnel.manager to \"none\")", name)
		}
		resolved = append(resolved, tunnelSpecFor(r, doc.LaunchdLabelPrefix))
	}
	sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
	return resolved, nil
}

// resolveManagedTunnelSpecs is every remote the fleet file currently asks THIS
// host to supervise a tunnel for: enabled, and carrying manager launchd or
// systemd. It never errors — an empty result (no remotes at all, or none of
// them managed) is a legitimate steady state, not a misconfiguration, and it
// is exactly the state that leaves the convergent install with nothing to
// write but everything to prune.
func resolveManagedTunnelSpecs(doc remotesFile) []tunnelSpec {
	resolved := make([]tunnelSpec, 0, len(doc.Remotes))
	for _, r := range doc.Remotes {
		if !r.enabledOr() || !managedTunnel(r.tunnelOpts().Manager) {
			continue
		}
		// Unreachable through the fleet file: normalizeRemotes already refuses
		// a managed manager on a portless entry, and defaults a portless entry
		// to none, so nothing that gets here can be both managed and port-0.
		// It stays because this function takes a remotesFile, and the day
		// something builds one in memory rather than reading it, a port-0
		// tunnel spec would render `-L 0:localhost:4000` — a job that installs
		// cleanly and forwards nothing. See resolveTunnelSpecs, which refuses
		// the same shape loudly because the named arm is allowed to.
		if r.Port == 0 {
			continue
		}
		resolved = append(resolved, tunnelSpecFor(r, doc.LaunchdLabelPrefix))
	}
	sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
	return resolved
}

func tunnelSpecFor(r remoteSpec, labelPrefix string) tunnelSpec {
	return tunnelSpec{
		Name:         r.Name,
		SSHHost:      r.SSH,
		Label:        r.label(labelPrefix),
		UnitName:     r.unitName(),
		LocalPort:    r.Port,
		RemotePort:   r.RemotePort,
		RemoteSocket: r.RemoteSocket,
		Multiplex:    r.tunnelOpts().Multiplex,
	}
}

// forward is the `ssh -L` argument: `<local>:localhost:<remote>` for a port,
// and OpenSSH's `[bind:]port:remote_socket` form (OpenSSH 6.7+) for a socket,
// bound to 127.0.0.1 so the forward is never a wildcard listener.
func (s tunnelSpec) forward() string {
	if s.RemoteSocket != "" {
		return fmt.Sprintf("127.0.0.1:%d:%s", s.LocalPort, s.RemoteSocket)
	}
	return fmt.Sprintf("%d:localhost:%d", s.LocalPort, s.RemotePort)
}

// tunnelForwardPattern is every forward() can legitimately produce.
var tunnelForwardPattern = regexp.MustCompile(`^(?:[0-9]+:localhost:[0-9]+|127\.0\.0\.1:[0-9]+:/[A-Za-z0-9._/@+-]+)$`)

func (s tunnelSpec) remoteEnd() string {
	if s.RemoteSocket != "" {
		return s.RemoteSocket
	}
	return fmt.Sprintf(":%d", s.RemotePort)
}

// tunnelJobPattern matches ONLY the filename shape this command itself
// generates for supervisor sup — never a hand-written plist or unit, and never
// a remote installed under an explicit tunnel.label (see
// resolveManagedTunnelSpecs/label/unitName): a custom label is, by the same
// construction that makes the generated shape recognizable, indistinguishable
// from something the operator wrote by hand, so prune must not touch it either
// way. The one capture group is the remote name embedded in the generated
// shape, used only for the removal message.
//
// The launchd arm matches ANY reverse-DNS prefix, not the fleet file's current
// `launchd_label_prefix`. Pinning the current prefix was the bug this shape
// fixes: change the prefix and every job installed under the old one matches
// neither the kept-files set nor the pattern, so prune walks straight past an
// autossh loop that keeps running forever — the exact haunting prune exists to
// end. Widening it is safe because the recognizable part was never the prefix:
// the `.shuttle-tunnel-` infix is ours, nothing else on a machine writes a
// label shaped that way, and a custom tunnel.label (which by definition does
// not contain it) stays untouchable as before. The systemd arm needs no such
// widening — a unit name is a file name and carries no prefix at all, so it has
// always been prefix-agnostic.
func tunnelJobPattern(sup tunnelSupervisor) *regexp.Regexp {
	switch sup.Name {
	case "launchd":
		return regexp.MustCompile(`^[A-Za-z0-9._-]+\.shuttle-tunnel-(.+)\.plist$`)
	case "systemd":
		return regexp.MustCompile(`^shuttle-tunnel-(.+)\.service$`)
	}
	// A supervisor this function has never been taught is one whose job files
	// we cannot recognize, and the failure mode of guessing is deleting
	// someone else's. nil means prune finds nothing, which is the only safe
	// answer; add the arm here when you add the supervisor.
	return nil
}

// pruneOrphanTunnels is the other half of convergent install. Having just
// written and started a job for every remote the fleet file currently names
// with a managed tunnel, it walks the same job directory for anything else
// that carries this command's OWN generated naming convention and boots it
// out — the file, and whatever the supervisor still remembers about it. This
// is how a remote dropped from the fleet file entirely, or merely flipped to
// `manager: none` or `enabled: false`, stops haunting the host as an autossh
// loop running forever against a daemon nothing polls that way anymore.
//
// It is deliberately conservative about what counts as "ours": only a
// filename matching tunnelJobPattern is a candidate, so a hand-written plist
// or unit, or one installed under a custom tunnel.label, is never touched —
// see tunnelJobPattern's own comment for the custom-label case in both
// directions. Removing a job that was never there, or that the supervisor had
// already forgotten, is success, not an error: prune runs on every convergent
// install, so "nothing to clean up" is the ordinary outcome.
func pruneOrphanTunnels(sup tunnelSupervisor, jobDir string, keep []tunnelSpec, dryRun bool) error {
	entries, err := os.ReadDir(jobDir)
	if err != nil {
		// No job directory at all reads the same as an empty one: there is
		// nothing installed, so there is nothing to prune.
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("scan %s for orphaned tunnels: %w", jobDir, err)
	}

	keptFiles := make(map[string]bool, len(keep))
	for _, spec := range keep {
		keptFiles[sup.JobFile(spec)] = true
	}
	pattern := tunnelJobPattern(sup)
	if pattern == nil || sup.Deactivate == nil {
		return nil
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		if keptFiles[name] {
			continue
		}
		match := pattern.FindStringSubmatch(name)
		if match == nil {
			continue
		}
		remoteName := match[1]
		if dryRun {
			fmt.Printf("would remove %s (no longer in the fleet file)\n", remoteName)
			continue
		}
		if err := sup.Deactivate(name, jobDir); err != nil {
			return fmt.Errorf("remove orphaned tunnel %s: %w", remoteName, err)
		}
		fmt.Printf("removed %s (no longer in the fleet file)\n", remoteName)
	}
	return nil
}

func renderTunnelJob(tmpl *template.Template, data tunnelTemplateData) ([]byte, error) {
	// The forward lands in XML, a systemd unit and a `sh -c` loop. The fleet
	// validator already refuses anything outside this alphabet; this guard
	// keeps a spec built any other way from rendering at all.
	if !tunnelForwardPattern.MatchString(data.Forward) {
		return nil, fmt.Errorf("refusing to render tunnel forward %q: not a port or allowlisted socket forward", data.Forward)
	}
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
	tunnelsInstallCmd.Flags().BoolVar(&tunnelsDryRun, "dry-run", false, "Print what would be installed, and (with no remote named) which orphaned jobs would be removed; writes nothing and shells no supervisor")
	tunnelsCmd.AddCommand(tunnelsInstallCmd)
	shuttleCmd.AddCommand(tunnelsCmd)
}
