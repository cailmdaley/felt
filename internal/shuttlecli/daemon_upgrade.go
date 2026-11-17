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
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/spf13/cobra"
)

// daemonRespawnWait bounds how long upgrade waits for a supervisor to bring a
// stopped daemon back on the new release: launchd and systemd wait 10 s before
// a restart, and the release then boots.
const daemonRespawnWait = 60 * time.Second

func (a *app) daemonUpgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Install the daemon release matching these CLIs and restart the daemon on it",
		Long: `Replaces the selected daemon release (the one ~/.shuttle/repo or
$SHUTTLE_RELEASE names, which the installer writes) with this CLI's version of
the release archive, verified before anything is replaced. A running daemon is
then stopped, and its keep-alive supervisor or respawn loop starts the new
release; a daemon that nothing restarts is left stopped, with the command that
starts it. The restart arms the boot quarantine, released with
'shuttle daemon release'.

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
			previous := ""
			if installed := a.releaseVersion(release); installed != a.version {
				if previous, err = a.replaceRelease(release.Dir); err != nil {
					return err
				}
				fmt.Fprintf(a.env.Stdout, "installed daemon %s at %s (was %s)\n", a.version, release.Dir, installed)
				if err := a.installLaunchHelper(release.Dir); err != nil {
					return err
				}
			}
			if err := a.restartOnRelease(); err != nil {
				return err
			}
			if previous != "" {
				return os.RemoveAll(previous)
			}
			return nil
		},
	}
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

// restartOnRelease stops a running daemon that is not at this version and
// waits for its supervisor to start the selected release.
func (a *app) restartOnRelease() error {
	running, err := a.daemonBuildAt("")
	if err != nil {
		fmt.Fprintln(a.env.Stdout, "no daemon is running; `shuttle daemon start` starts this release")
		return nil
	}
	if running.Version == a.version && running.matches() {
		fmt.Fprintf(a.env.Stdout, "the daemon is running %s\n", a.version)
		return nil
	}
	settings, err := a.resolveHostSettings()
	if err != nil {
		return err
	}
	if err := a.stopDaemonEndpoint(settings, ""); err != nil {
		return err
	}
	for waited := time.Duration(0); waited < daemonRespawnWait; waited += time.Second {
		a.daemonPause(time.Second)
		if build, err := a.daemonBuildAt(""); err == nil && build.Version == a.version {
			fmt.Fprintf(a.env.Stdout, "the daemon restarted on %s; its boot quarantine holds new launches until `shuttle daemon release`\n", a.version)
			return nil
		}
	}
	fmt.Fprintf(a.env.Stdout, "the daemon stopped and nothing restarted it within %s; start it with `shuttle daemon start`\n", daemonRespawnWait)
	return nil
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
	resp, err := http.Get(url)
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
