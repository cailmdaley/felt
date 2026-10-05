package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

var shuttleDaemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Start, inspect, and supervise the local daemon",
}

var shuttleDaemonStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the daemon in the foreground",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		release, err := findDaemonRelease()
		if err != nil {
			return err
		}
		if !force {
			settings, err := resolveHostSettings()
			if err != nil {
				return err
			}
			if err := daemonLifecycleOwnerCheck(settings); err != nil {
				return fmt.Errorf("refusing to start after the daemon owner check failed: %w", err)
			}
			if _, err := daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil {
				fmt.Fprintf(os.Stderr, "Daemon already running at %s.\n", settings.Listen)
				fmt.Fprintln(os.Stderr, "If a keep-alive supervisor owns it, cycle it there:")
				fmt.Fprintln(os.Stderr, "  launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   (macOS)")
				fmt.Fprintln(os.Stderr, "  systemctl --user restart shuttle-daemon.service         (Linux)")
				fmt.Fprintln(os.Stderr, "Otherwise stop the listener directly:")
				if settings.listen.Network == "unix" {
					fmt.Fprintf(os.Stderr, "  lsof -t -- %s | xargs kill\n", settings.listen.Address)
				} else {
					_, port, _ := net.SplitHostPort(settings.listen.Address)
					fmt.Fprintf(os.Stderr, "  lsof -ti:%s -sTCP:LISTEN | xargs kill\n", port)
				}
				fmt.Fprintln(os.Stderr, "Pass --force to launch anyway.")
				return errors.New("daemon is already running")
			}
		}
		return execDaemonRelease(release.Launcher, "start")
	},
}

var shuttleDaemonStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Print the daemon state or version receipt",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		settings, err := resolveHostSettings()
		if err != nil {
			return err
		}
		version, err := daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second)
		if err != nil {
			fmt.Fprintf(os.Stderr, "(daemon down at %s)\n", settings.Listen)
			return &cliExitError{code: 2, err: fmt.Errorf("daemon is down at %s: %w", settings.Listen, err)}
		}
		if daemonVersionIsBooting(version) {
			printDaemonBody(version)
			return nil
		}
		state, err := daemonLifecycleGet(settings, "/api/v1/state", 5*time.Second)
		if err == nil {
			printDaemonBody(state)
		} else {
			printDaemonBody(version)
		}
		return nil
	},
}

var shuttleDaemonReleaseCmd = &cobra.Command{
	Use:   "release",
	Short: "Release the daemon's boot quarantine",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		settings, err := resolveHostSettings()
		if err != nil {
			return err
		}
		if version, err := daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil && daemonVersionIsBooting(version) {
			return errors.New("daemon is still booting; retry when /api/v1/version shows ready:true")
		}
		if _, err := daemonLifecyclePost(settings, "/api/v1/quarantine/release", nil); err == nil {
			fmt.Println("quarantine released — parked launches will dispatch on the next tick")
			return nil
		}
		if version, err := daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil && daemonVersionIsBooting(version) {
			return errors.New("daemon is still booting; retry when /api/v1/version shows ready:true")
		}
		return errors.New("release failed: daemon unreachable or poller not running")
	},
}

var shuttleDaemonResetCmd = &cobra.Command{
	Use:   "reset <remote>",
	Short: "Reset a remote daemon's circuit breaker",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		remote := strings.TrimSpace(args[0])
		if remote == "" {
			return errors.New("Usage: shuttle daemon reset <remote>")
		}
		settings, err := resolveHostSettings()
		if err != nil {
			return err
		}
		path := "/api/v1/remotes/" + url.PathEscape(remote) + "/reset"
		if _, err := daemonLifecyclePost(settings, path, nil); err != nil {
			return errors.New("reset failed: unknown remote, breaker not tripped, or daemon unreachable")
		}
		fmt.Printf("circuit breaker reset for %s — recovery cascade re-running\n", remote)
		return nil
	},
}

var shuttleVersionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the running daemon version or its release version",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		settings, err := resolveHostSettings()
		if err != nil {
			return err
		}
		if version, err := daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second); err == nil {
			printDaemonBody(version)
			return nil
		}
		release, err := findDaemonRelease()
		if err != nil {
			return err
		}
		return runDaemonReleaseVersion(release.Launcher)
	},
}

func init() {
	shuttleDaemonStartCmd.Flags().Bool("force", false, "Start without checking whether a daemon is already running")
	shuttleDaemonCmd.AddCommand(
		shuttleDaemonStartCmd,
		newShuttleDaemonStopCommand(),
		shuttleDaemonStatusCmd,
		shuttleDaemonReleaseCmd,
		shuttleDaemonResetCmd,
		newShuttleDaemonInstallCommand(),
		newShuttleDaemonUninstallCommand(),
	)
	addShuttleCommand(shuttleDaemonCmd)
	addShuttleCommand(shuttleVersionCmd)
}

func daemonLifecycleURL(settings hostSettings, path string) string {
	if settings.listen.Network == "unix" {
		return "http://" + daemonSocketHost + path
	}
	return "http://" + settings.listen.Address + path
}

var daemonLifecycleOwnerCheck = checkResolvedDaemonPortOwner

func daemonLifecycleGet(settings hostSettings, path string, timeout time.Duration) ([]byte, error) {
	if err := daemonLifecycleOwnerCheck(settings); err != nil {
		return nil, fmt.Errorf("refusing the TCP request after the daemon owner check failed: %w", err)
	}
	return getDaemon(daemonLifecycleURL(settings, path), timeout)
}

func daemonLifecyclePost(settings hostSettings, path string, payload []byte) ([]byte, error) {
	if err := daemonLifecycleOwnerCheck(settings); err != nil {
		return nil, fmt.Errorf("refusing the TCP request after the daemon owner check failed: %w", err)
	}
	return postDaemon(daemonLifecycleURL(settings, path), payload, 10*time.Second)
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

func findDaemonRelease() (daemonRelease, error) {
	executable, err := resolvedExecutablePath()
	if err != nil {
		return daemonRelease{}, err
	}
	home, _ := os.UserHomeDir()
	return findDaemonReleaseAt(os.Getenv("SHUTTLE_RELEASE"), executable, home)
}

func findDaemonReleaseAt(configured, executable, home string) (daemonRelease, error) {
	if configured = strings.TrimSpace(configured); configured != "" {
		dir, err := expandUserPath(configured)
		if err != nil {
			return daemonRelease{}, fmt.Errorf("resolving SHUTTLE_RELEASE: %w", err)
		}
		return validateDaemonRelease(dir)
	}
	executableDir := filepath.Dir(executable)
	if release, err := validateDaemonRelease(executableDir); err == nil {
		return release, nil
	}
	if info, err := os.Stat(filepath.Join(executableDir, "shuttled")); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
		if release, err := validateDaemonRelease(filepath.Dir(executableDir)); err == nil {
			return release, nil
		}
	}
	if home != "" {
		data, readErr := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
		if readErr == nil {
			repo := strings.TrimSpace(string(data))
			if repo != "" {
				if expanded, expandErr := expandUserPath(repo); expandErr == nil {
					if release, releaseErr := validateDaemonRelease(expanded); releaseErr == nil {
						return release, nil
					}
					if release, releaseErr := validateDaemonRelease(filepath.Join(expanded, "bin", "rel")); releaseErr == nil {
						return release, nil
					}
				}
			}
		}
	}
	return daemonRelease{}, errors.New("no daemon release found; set SHUTTLE_RELEASE or build/install a Mix release")
}

func validateDaemonRelease(dir string) (daemonRelease, error) {
	if !filepath.IsAbs(dir) {
		abs, err := filepath.Abs(dir)
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

func executablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locating shuttle executable: %w", err)
	}
	return absoluteExecutablePath(path)
}

func absoluteExecutablePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolving shuttle executable path: %w", err)
	}
	return abs, nil
}

func resolvedExecutablePath() (string, error) {
	path, err := executablePath()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return path, nil
}

var execDaemonRelease = func(path string, args ...string) error {
	argv := append([]string{path}, args...)
	return syscall.Exec(path, argv, os.Environ())
}

var runDaemonReleaseVersion = func(path string) error {
	cmd := exec.Command(path, "version")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

var daemonFindPIDs = findDaemonPIDs
var daemonSignalPID = signalDaemonPID
var daemonPause = time.Sleep

func newShuttleDaemonStopCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the daemon process for this release",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			release, err := findDaemonRelease()
			if err != nil {
				return err
			}
			return stopDaemonRelease(release)
		},
	}
}

func stopDaemonRelease(release daemonRelease) error {
	pattern := daemonProcessPattern(release.Dir)
	pids, err := daemonFindPIDs(pattern)
	if err != nil {
		return err
	}
	if len(pids) == 0 {
		return nil
	}
	marker, err := daemonStopMarkerPath()
	if err != nil {
		return err
	}
	if err := touchDaemonStopMarker(marker); err != nil {
		return fmt.Errorf("marking the requested daemon stop: %w", err)
	}
	pid := pids[0]
	fmt.Printf("stopping the running daemon (pid %d)\n", pid)
	_ = daemonSignalPID(pid, syscall.SIGTERM)
	for i := 0; i < 5; i++ {
		daemonPause(time.Second)
		pids, err = daemonFindPIDs(pattern)
		if err != nil || len(pids) == 0 {
			return err
		}
	}
	_ = daemonSignalPID(pid, syscall.SIGKILL)
	return nil
}

func daemonProcessPattern(releaseDir string) string {
	return regexp.QuoteMeta(filepath.Join(releaseDir, "releases")) + `/[^[:space:]]+/start([[:space:]]|$)`
}

func findDaemonPIDs(pattern string) ([]int, error) {
	output, err := exec.Command("pgrep", "-f", pattern).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("finding daemon process: %w", err)
	}
	var pids []int
	for _, line := range strings.Fields(string(output)) {
		pid, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("parsing daemon pid %q: %w", line, err)
		}
		pids = append(pids, pid)
	}
	return pids, nil
}

func signalDaemonPID(pid int, signal syscall.Signal) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(signal)
}

func daemonStopMarkerPath() (string, error) {
	dir, err := shuttle.DataDir(sysenv.OS())
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
