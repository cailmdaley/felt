package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) shuttleDaemonCmd() *cobra.Command {
	shuttleDaemonCmd := &cobra.Command{
		Use:   "daemon",
		Short: "Start, inspect, and supervise the local daemon",
	}
	shuttleDaemonCmd.AddCommand(
		a.shuttleDaemonStartCmd(),
		a.newShuttleDaemonStopCommand(),
		a.shuttleDaemonStatusCmd(),
		a.shuttleDaemonReleaseCmd(),
		a.shuttleDaemonResetCmd(),
		a.newShuttleDaemonInstallCommand(),
		a.newShuttleDaemonUninstallCommand(),
		a.daemonLoopPresentCmd(),
		a.daemonSelectReleaseCmd(),
		a.daemonActivateReleaseCmd(),
		a.daemonPruneReleasesCmd(),
	)
	return shuttleDaemonCmd
}

func (a *app) shuttleDaemonStartCmd() *cobra.Command {
	shuttleDaemonStartCmd := &cobra.Command{
		Use:   "start",
		Short: "Start the daemon in the foreground",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			release, err := a.findDaemonRelease()
			if err != nil {
				return err
			}
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			releaseClaim, err := a.claimDaemonOwner(settings, 0, nil)
			if err != nil {
				return err
			}
			defer releaseClaim()
			if err := a.daemonLifecycleOwnerCheck(settings); err != nil {
				return fmt.Errorf("refusing to start after the daemon owner check failed: %w", err)
			}
			if _, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil {
				fmt.Fprintf(a.env.Stderr, "Daemon already running at %s.\n", settings.Listen)
				fmt.Fprintln(a.env.Stderr, "If a keep-alive supervisor owns it, cycle it there:")
				fmt.Fprintln(a.env.Stderr, "  launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   (macOS)")
				fmt.Fprintln(a.env.Stderr, "  systemctl --user restart shuttle-daemon.service         (Linux)")
				fmt.Fprintln(a.env.Stderr, "Otherwise stop the listener directly:")
				if settings.listen.Network == "unix" {
					fmt.Fprintf(a.env.Stderr, "  lsof -t -- %s | xargs kill\n", settings.listen.Address)
				} else {
					_, port, _ := net.SplitHostPort(settings.listen.Address)
					fmt.Fprintf(a.env.Stderr, "  lsof -ti:%s -sTCP:LISTEN | xargs kill\n", port)
				}
				return errors.New("daemon is already running")
			}
			return a.execDaemonRelease(release.Launcher, "start")
		},
	}
	// Respawn loops started from an earlier shuttle-launch keep running its
	// text across deploys and pass --force; it changes nothing.
	shuttleDaemonStartCmd.Flags().Bool("force", false, "")
	_ = shuttleDaemonStartCmd.Flags().MarkHidden("force")
	return shuttleDaemonStartCmd
}

func (a *app) shuttleDaemonStatusCmd() *cobra.Command {
	shuttleDaemonStatusCmd := &cobra.Command{
		Use:   "status",
		Short: "Print the daemon state or version receipt",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			version, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second)
			if err != nil {
				fmt.Fprintf(a.env.Stderr, "(daemon down at %s)\n", settings.Listen)
				return &cliExitError{code: 2, err: fmt.Errorf("daemon is down at %s: %w", settings.Listen, err)}
			}
			if daemonVersionIsBooting(version) {
				a.printDaemonBody(version)
				return nil
			}
			state, err := a.daemonLifecycleGet(settings, "/api/v1/state", 5*time.Second)
			if err == nil {
				var receipt map[string]any
				var snapshot map[string]any
				if json.Unmarshal(version, &receipt) == nil && json.Unmarshal(state, &snapshot) == nil {
					if path, ok := receipt["release_path"]; ok {
						snapshot["release_path"] = path
					}
					state, _ = json.Marshal(snapshot)
				}
				a.printDaemonBody(state)
			} else {
				a.printDaemonBody(version)
			}
			return nil
		},
	}
	return shuttleDaemonStatusCmd
}

func (a *app) shuttleDaemonReleaseCmd() *cobra.Command {
	shuttleDaemonReleaseCmd := &cobra.Command{
		Use:   "release",
		Short: "Release the daemon's boot quarantine",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			if version, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil && daemonVersionIsBooting(version) {
				return errors.New("daemon is still booting; retry when /api/v1/version shows ready:true")
			}
			_, postErr := a.daemonLifecyclePost(settings, "/api/v1/quarantine/release", nil)
			if postErr == nil {
				fmt.Fprintln(a.env.Stdout, "quarantine released — parked launches will dispatch on the next tick")
				return nil
			}
			if version, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil && daemonVersionIsBooting(version) {
				return errors.New("daemon is still booting; retry when /api/v1/version shows ready:true")
			}
			return fmt.Errorf("release failed: %w", postErr)
		},
	}
	return shuttleDaemonReleaseCmd
}

func (a *app) shuttleDaemonResetCmd() *cobra.Command {
	shuttleDaemonResetCmd := &cobra.Command{
		Use:   "reset <remote>",
		Short: "Restart recovery for a remote daemon",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			remote := strings.TrimSpace(args[0])
			if remote == "" {
				return errors.New("Usage: shuttle daemon reset <remote>")
			}
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			path := "/api/v1/remotes/" + url.PathEscape(remote) + "/reset"
			if _, err := a.daemonLifecyclePost(settings, path, nil); err != nil {
				return fmt.Errorf("reset failed: %w", err)
			}
			fmt.Fprintf(a.env.Stdout, "recovery restarted for %s — cascade running\n", remote)
			return nil
		},
	}
	return shuttleDaemonResetCmd
}

func (a *app) shuttleVersionCmd() *cobra.Command {
	shuttleVersionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the running daemon version or its release version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			if version, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil {
				a.printDaemonBody(version)
				return nil
			}
			release, err := a.findDaemonRelease()
			if err != nil {
				return err
			}
			return a.runDaemonReleaseVersion(release.Launcher)
		},
	}
	return shuttleVersionCmd
}

func daemonLifecycleURL(settings hostSettings, path string) string {
	return settings.listen.BaseURL() + path
}

func (a *app) daemonLifecycleGet(settings hostSettings, path string, timeout time.Duration) ([]byte, error) {
	if err := a.daemonLifecycleOwnerCheck(settings); err != nil {
		return nil, fmt.Errorf("refusing the TCP request after the daemon owner check failed: %w", err)
	}
	return a.getDaemon(daemonLifecycleURL(settings, path), timeout)
}

func (a *app) daemonLifecyclePost(settings hostSettings, path string, payload []byte) ([]byte, error) {
	if err := a.daemonLifecycleOwnerCheck(settings); err != nil {
		return nil, fmt.Errorf("refusing the TCP request after the daemon owner check failed: %w", err)
	}
	return a.postDaemon(daemonLifecycleURL(settings, path), payload, 10*time.Second)
}

func daemonVersionIsBooting(body []byte) bool {
	var version struct {
		Ready *bool `json:"ready"`
	}
	if json.Unmarshal(body, &version) != nil || version.Ready == nil {
		return false
	}
	return !*version.Ready
}

type daemonRelease struct {
	Dir      string
	Launcher string
}

func (a *app) findDaemonRelease() (daemonRelease, error) {
	executable, err := a.resolvedExecutablePath()
	if err != nil {
		return daemonRelease{}, err
	}
	home, _ := a.env.UserHomeDir()
	return a.findDaemonReleaseAt(a.env.Getenv("SHUTTLE_RELEASE"), executable, home)
}

func (a *app) findDaemonReleaseAt(configured, executable, home string) (daemonRelease, error) {
	if configured = strings.TrimSpace(configured); configured != "" {
		dir, err := shuttle.ExpandUserPath(a.env, configured)
		if err != nil {
			return daemonRelease{}, fmt.Errorf("resolving SHUTTLE_RELEASE: %w", err)
		}
		return a.validateDaemonRelease(dir)
	}
	if home != "" {
		data, err := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
		if err == nil && strings.TrimSpace(string(data)) != "" {
			dir, err := shuttle.ExpandUserPath(a.env, strings.TrimSpace(string(data)))
			if err != nil {
				return daemonRelease{}, err
			}
			if release, err := a.validateDaemonRelease(dir); err == nil {
				return release, nil
			}
			return daemonRelease{}, fmt.Errorf("selected daemon release is missing or unbuilt at %q (pointer %s); fix: bin/shuttle-deploy --hosts local, or make restart in the main checkout", dir, filepath.Join(home, ".shuttle", "repo"))
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return daemonRelease{}, err
		}
	}
	executableDir := filepath.Dir(executable)
	if release, err := a.validateDaemonRelease(executableDir); err == nil {
		return release, nil
	}
	if info, err := os.Stat(filepath.Join(executableDir, "shuttled")); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
		if release, err := a.validateDaemonRelease(filepath.Dir(executableDir)); err == nil {
			return release, nil
		}
	}
	return daemonRelease{}, errors.New("no daemon release selected; fix: bin/shuttle-deploy --hosts local, or make restart in the main checkout; SHUTTLE_RELEASE overrides selection for a direct invocation")
}

func (a *app) validateDaemonRelease(dir string) (daemonRelease, error) {
	if !filepath.IsAbs(dir) {
		abs, err := a.env.Abs(dir)
		if err != nil {
			return daemonRelease{}, err
		}
		dir = abs
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	launcher := filepath.Join(dir, "bin", "shuttled")
	info, err := os.Stat(launcher)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return daemonRelease{}, fmt.Errorf("daemon release %q does not contain an executable bin/shuttled", dir)
	}
	return daemonRelease{Dir: dir, Launcher: launcher}, nil
}

func (a *app) executablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locating shuttle executable: %w", err)
	}
	return a.absoluteExecutablePath(path)
}

func (a *app) absoluteExecutablePath(path string) (string, error) {
	abs, err := a.env.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolving shuttle executable path: %w", err)
	}
	return abs, nil
}

func (a *app) resolvedExecutablePath() (string, error) {
	path, err := a.executablePath()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return path, nil
}

// execRelease replaces this process with the daemon release
// (app.execDaemonRelease).
func (a *app) execRelease(path string, args ...string) error {
	argv := append([]string{path}, args...)
	return syscall.Exec(path, argv, a.env.Environ())
}

// runReleaseVersion runs the release's version command on this terminal
// (app.runDaemonReleaseVersion).
func (a *app) runReleaseVersion(path string) error {
	cmd := a.env.Command(path, "version")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = a.env.Stdin, a.env.Stdout, a.env.Stderr
	return cmd.Run()
}

func (a *app) newShuttleDaemonStopCommand() *cobra.Command {
	var within string
	command := &cobra.Command{
		Use:   "stop",
		Short: "Stop the daemon owning the configured listener",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			settings, err := a.resolveHostSettings()
			if err != nil {
				return err
			}
			return a.stopDaemonEndpoint(settings, within)
		},
	}
	command.Flags().StringVar(&within, "within", "", "Refuse to stop a daemon whose reported release is outside this directory")
	return command
}

func (a *app) stopDaemonEndpoint(settings hostSettings, within string) error {
	owner, err := a.resolveDaemonEndpointOwner(settings)
	if err != nil {
		return err
	}
	if owner.PID == 0 {
		return nil
	}
	if within != "" {
		body, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second)
		if err != nil {
			return err
		}
		var receipt struct {
			ReleasePath string `json:"release_path"`
		}
		if json.Unmarshal(body, &receipt) != nil || !releasePathWithin(within, receipt.ReleasePath) {
			return fmt.Errorf("refusing to stop daemon outside worktree %q (running release_path: %q)", within, receipt.ReleasePath)
		}
		confirmed, err := a.resolveDaemonEndpointOwner(settings)
		if err != nil {
			return err
		}
		if confirmed != owner {
			return errors.New("daemon owner changed while checking --within")
		}
	}
	marker, err := a.daemonStopMarkerPath()
	if err != nil {
		return err
	}
	if err := touchDaemonStopMarker(marker); err != nil {
		return fmt.Errorf("marking the requested daemon stop: %w", err)
	}
	fmt.Fprintf(a.env.Stdout, "stopping the running daemon (pid %d)\n", owner.PID)
	if err := a.signalDaemonOwner(owner, syscall.SIGTERM); err != nil {
		return err
	}
	for i := 0; i < 5; i++ {
		a.daemonPause(time.Second)
		birth, err := processBirth(a.env, owner.PID)
		if err != nil {
			if syscall.Kill(owner.PID, 0) == syscall.ESRCH {
				return nil
			}
			return fmt.Errorf("cannot verify daemon while stopping: %w", err)
		}
		if birth != owner.Birth {
			return nil
		}
	}
	return a.signalDaemonOwner(owner, syscall.SIGKILL)
}

func signalDaemonPID(pid int, signal syscall.Signal) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(signal)
}

func (a *app) daemonStopMarkerPath() (string, error) {
	dir, err := shuttle.DataDir(a.env)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "heartbeat.stopped"), nil
}

func touchDaemonStopMarker(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	now := time.Now()
	return os.Chtimes(path, now, now)
}
