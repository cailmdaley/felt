package shuttlecli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/spf13/cobra"
)

// daemonRespawnWait bounds how long upgrade waits for a supervisor to bring a
// stopped daemon back on the new release: launchd and systemd wait 10 s before
// a restart, and the release then boots.
const daemonRespawnWait = 60 * time.Second

// releaseDownloadTimeout bounds the whole download of a release archive, so a
// stalled connection fails the upgrade instead of hanging it.
var releaseDownloadTimeout = 10 * time.Minute

func (a *app) daemonUpgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Install the daemon release matching these CLIs and restart the daemon on it",
		Long: `Replaces the selected daemon release (the one ~/.shuttle/repo or
$SHUTTLE_RELEASE names, which the installer writes) with this CLI's version of
the release archive, verified before anything is replaced. A daemon that is
listening but does not report its version fails the upgrade before then, as
does a ~/.shuttle/owner-node that pins the daemon to another login node. With
no daemon running, the upgrade holds the daemon's ownership claim while it
replaces the release, failing first when a daemon is starting, so a 'shuttle
daemon start' in the meantime fails and its retry starts the new release. A
running daemon is then stopped, and its keep-alive supervisor or respawn loop
starts the new release. A daemon that nothing restarts is left stopped and the
command fails, naming the command that starts it. The replaced release is kept at
<release>.previous unless the upgrade sees a daemon running the new one. The
restart arms the boot quarantine, released with 'shuttle daemon release'.

A release built from a checkout is not replaced: deploy it from that checkout
with bin/shuttle-deploy.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.version == "dev" {
				return errors.New("this shuttle is a source build with no release version; deploy the daemon from its checkout with bin/shuttle-deploy")
			}
			release, err := a.findDaemonRelease()
			if err != nil {
				return fmt.Errorf("no daemon release is installed on this host: %w", err)
			}
			if !fetchedRelease(release.Dir) {
				return fmt.Errorf("the daemon release at %s was built from a checkout; deploy it from that checkout with bin/shuttle-deploy --hosts local", release.Dir)
			}
			daemon, err := a.runningDaemon()
			if err != nil {
				return fmt.Errorf("the daemon's version could not be read, so nothing was replaced: %w", err)
			}
			if owner, pin := a.otherOwnerNode(); owner != "" {
				return fmt.Errorf("this host's daemon belongs to login node %q (%s); run the upgrade there", owner, pin)
			}
			previous := ""
			if installed := a.releaseVersion(release); installed != a.version {
				// With no daemon running, the upgrade holds the endpoint's
				// ownership claim through the swap, so a supervisor's
				// `shuttle daemon start` meanwhile fails and its retry starts
				// the new release.
				if daemon == nil {
					settings, err := a.resolveHostSettings()
					if err != nil {
						return err
					}
					releaseClaim, err := a.claimDaemonOwner(settings, 0, nil)
					if err != nil {
						return fmt.Errorf("a daemon is starting, so nothing was replaced; run the upgrade again once it answers: %w", err)
					}
					defer releaseClaim()
				}
				if previous, err = a.replaceRelease(release.Dir); err != nil {
					return err
				}
				fmt.Fprintf(a.env.Stdout, "installed daemon %s at %s (was %s)\n", a.version, release.Dir, installed)
				if err := a.installLaunchHelper(release.Dir); err != nil {
					return err
				}
			}
			running, err := a.restartOnRelease(daemon, previous)
			if err != nil || !running || previous == "" {
				return err
			}
			return os.RemoveAll(previous)
		},
	}
}

// otherOwnerNode is the login node the pin file (~/.shuttle/owner-node, or
// $SHUTTLE_OWNER_NODE_FILE) assigns this host's daemon to, when that is another
// node than this one, and the pin's path: on a cluster sharing HOME, that
// node's daemon runs from the release an upgrade here would replace. It reads
// the pin as shuttle-launch does: the first line, against the short hostname.
func (a *app) otherOwnerNode() (string, string) {
	path := a.env.Getenv("SHUTTLE_OWNER_NODE_FILE")
	if path == "" {
		home, err := a.env.UserHomeDir()
		if err != nil {
			return "", ""
		}
		path = filepath.Join(home, ".shuttle", "owner-node")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	owner, _, _ := strings.Cut(string(data), "\n")
	node, _ := a.env.Hostname()
	node, _, _ = strings.Cut(node, ".")
	if owner == "" || owner == node {
		return "", ""
	}
	return owner, path
}

// runningDaemon is the daemon answering on this host, or nil when nothing
// listens: a refused connection, or no unix socket. Anything else, a daemon
// that does not answer or answers with something other than its version, is
// an error.
func (a *app) runningDaemon() (*daemonBuild, error) {
	build, err := a.daemonBuildAt("")
	if err == nil {
		return &build, nil
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOENT) {
		return nil, nil
	}
	return nil, err
}

// installLaunchHelper copies the release's shuttle-launch to ~/.local/bin, as
// the installer does: a hub revives this host over SSH by running that path.
func (a *app) installLaunchHelper(dir string) error {
	launch, err := os.ReadFile(filepath.Join(dir, "bin", "shuttle-launch"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	home, err := a.env.UserHomeDir()
	if err != nil {
		return err
	}
	target := filepath.Join(home, ".local", "bin", "shuttle-launch")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return atomicfile.Write(target, launch, 0o755)
}

// restartOnRelease stops running, the daemon the upgrade found, when it is not
// at this version and waits for its supervisor to start the selected release.
// It reports whether a daemon now runs this version. A daemon that does not
// come back is an error naming previous, the release it was replaced from,
// when there is one; with no daemon running, previous is named as kept.
func (a *app) restartOnRelease(running *daemonBuild, previous string) (bool, error) {
	kept := ""
	if previous != "" {
		kept = "; the release it replaced is kept at " + previous
	}
	if running == nil {
		fmt.Fprintf(a.env.Stdout, "no daemon is running; `shuttle daemon start` starts this release%s\n", kept)
		return false, nil
	}
	if running.Version == a.version && running.matches() {
		fmt.Fprintf(a.env.Stdout, "the daemon is running %s\n", a.version)
		return true, nil
	}
	settings, err := a.resolveHostSettings()
	if err != nil {
		return false, err
	}
	if err := a.stopDaemonEndpoint(settings, ""); err != nil {
		return false, err
	}
	for waited := time.Duration(0); waited < daemonRespawnWait; waited += time.Second {
		a.daemonPause(time.Second)
		if build, err := a.daemonBuildAt(""); err == nil && build.Version == a.version {
			fmt.Fprintf(a.env.Stdout, "the daemon restarted on %s; its boot quarantine holds new launches until `shuttle daemon release`\n", a.version)
			return true, nil
		}
	}
	return false, fmt.Errorf("the daemon stopped and nothing restarted it within %s; start it with `shuttle daemon start`, which runs in the foreground, then `shuttle daemon release`%s", daemonRespawnWait, kept)
}

// replaceRelease puts this version's release archive at dir and returns where
// the release it replaced was moved, for removal once no daemon runs from it.
func (a *app) replaceRelease(dir string) (string, error) {
	staging, err := os.MkdirTemp(filepath.Dir(dir), ".shuttled-upgrade-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	asset := fmt.Sprintf("shuttled_%s_%s.tar.gz", feltcli.ArchiveOS(), feltcli.ArchiveArch())
	url := fmt.Sprintf("%s/v%s/%s", strings.TrimRight(a.releaseDownloadBase, "/"), a.version, asset)
	fmt.Fprintf(a.env.Stdout, "downloading %s\n", url)
	resp, err := (&http.Client{Timeout: releaseDownloadTimeout}).Get(url)
	if err != nil {
		return "", fmt.Errorf("downloading the daemon release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: %s", url, resp.Status)
	}
	if err := extractRelease(resp.Body, staging); err != nil {
		return "", fmt.Errorf("unpacking %s: %w", asset, err)
	}
	fresh := filepath.Join(staging, "shuttled")
	if err := a.verifyRelease(fresh); err != nil {
		return "", err
	}
	previous := dir + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return "", err
	}
	if err := os.Rename(dir, previous); err != nil {
		return "", err
	}
	if err := os.Rename(fresh, dir); err != nil {
		return "", errors.Join(err, os.Rename(previous, dir))
	}
	return previous, nil
}

// verifyRelease starts the release's bundled runtime and reads the loaded
// application's version, as the installer does: a runtime that cannot start
// on this host is refused before it replaces anything.
func (a *app) verifyRelease(dir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	launcher := filepath.Join(dir, "bin", "shuttled")
	out, err := a.env.CommandContext(ctx, launcher, "eval", "Application.load(:shuttle); IO.puts(Application.spec(:shuttle, :vsn))").CombinedOutput()
	if err != nil {
		return fmt.Errorf("the downloaded daemon's runtime failed to start on this host: %w\n%s", err, out)
	}
	lines := strings.Fields(string(out))
	if len(lines) == 0 || lines[len(lines)-1] != a.version {
		return fmt.Errorf("the downloaded daemon reports version %q, expected %s", strings.TrimSpace(string(out)), a.version)
	}
	return nil
}

// extractRelease unpacks the archive's shuttled/ tree into dir.
func extractRelease(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := path.Clean(hdr.Name)
		if name != "shuttled" && !strings.HasPrefix(name, "shuttled/") {
			return fmt.Errorf("archive entry %q is outside shuttled/", hdr.Name)
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(hdr.Mode).Perm())
			if err != nil {
				return err
			}
			_, err = io.Copy(file, tr)
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("archive entry %q is neither a file nor a directory", hdr.Name)
		}
	}
}
