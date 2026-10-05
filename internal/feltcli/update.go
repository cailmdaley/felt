package feltcli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

type ghRelease struct {
	TagName string `json:"tag_name"`
}

func (a *app) updateCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "update",
		Short: "Update felt and shuttle to the latest release",
		Long: `Replaces both CLI binaries from the latest GitHub release (a dev build asks first),
then moves the agent integrations to the matching tag so hooks and skills stay
in step with the binary: the Claude Code plugin whenever the claude CLI is on
PATH, and the Codex and pi integrations where felt is already installed.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			feltPath, err := os.Executable()
			if err != nil {
				return fmt.Errorf("locating current felt binary: %w", err)
			}
			if err := a.refuseHomebrewUpdate(feltPath); err != nil {
				return err
			}

			// Get latest release tag from GitHub
			latest, err := latestVersion()
			if err != nil {
				return fmt.Errorf("checking latest version: %w", err)
			}

			current := a.version
			latestClean := strings.TrimPrefix(latest, "v")

			if a.updatePairIsCurrent(feltPath, current, latest, a.feltBuildVersion()) {
				fmt.Fprintf(a.env.Stdout, "Already up to date (%s)\n", current)
				return nil
			}
			if current == latestClean {
				fmt.Fprintf(a.env.Stdout, "Repairing felt and shuttle pair at %s\n", current)
			}

			if current == "dev" {
				fmt.Fprintln(a.env.Stdout, "Running a dev build — cannot determine current version.")
				fmt.Fprintf(a.env.Stdout, "Latest release is %s. Continue? [y/N] ", latest)
				var answer string
				fmt.Scanln(&answer)
				if answer != "y" && answer != "Y" {
					return nil
				}
			} else if current != latestClean {
				fmt.Fprintf(a.env.Stdout, "Updating %s → %s\n", current, latestClean)
			}

			// Build asset name matching goreleaser template
			assetName := fmt.Sprintf("felt_%s_%s.tar.gz", archiveOS(), archiveArch())
			url := fmt.Sprintf("https://github.com/cailmdaley/felt/releases/download/%s/%s", latest, assetName)

			// Download
			resp, err := http.Get(url)
			if err != nil {
				return fmt.Errorf("downloading release: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				return fmt.Errorf("download failed: %s (asset: %s)", resp.Status, assetName)
			}

			binaries, err := extractBinaries(resp.Body)
			if err != nil {
				return fmt.Errorf("extracting CLI binaries: %w", err)
			}
			if err := replaceBinaryPair(feltPath, binaries); err != nil {
				return fmt.Errorf("replacing felt and shuttle binaries: %w", err)
			}

			fmt.Fprintf(a.env.Stdout, "Updated felt and shuttle to %s\n", latestClean)
			a.refreshPluginAfterUpdate(a.defaultMarketplaceRef())
			return nil
		},
	}
	command.GroupID = groupAgents
	return command
}

// refreshPluginAfterUpdate keeps both agent integrations in lockstep with the
// binary that just landed, pointing each at the same marketplaceRef so an
// update from a local checkout doesn't leave one harness on the checkout and
// the other on GitHub. Failures are surfaced as one-line warnings rather than
// errored — the binary update has already succeeded and shouldn't be undone
// because a downstream integration step couldn't run (e.g. claude CLI missing,
// network blip on marketplace fetch).
func (a *app) refreshPluginAfterUpdate(marketplaceRef string) {
	if _, err := a.env.LookPath("claude"); err != nil {
		fmt.Fprintln(a.env.Stdout, "Plugin refresh skipped: claude CLI not on PATH (run `felt setup claude` once it is).")
	} else {
		fmt.Fprintln(a.env.Stdout)
		fmt.Fprintln(a.env.Stdout, "Refreshing Claude Code plugin...")
		if err := a.installPluginViaCLI(marketplaceRef); err != nil {
			fmt.Fprintf(a.env.Stdout, "Plugin refresh failed: %v\n", err)
			fmt.Fprintln(a.env.Stdout, "Rerun `felt setup claude` to retry.")
		}
	}
	a.refreshCodexSetupIfInstalled(marketplaceRef)
	a.refreshPiSetupIfInstalled(marketplaceRef)
}

func (a *app) updatePairIsCurrent(feltPath, currentVersion, latestVersion, build string) bool {
	return currentVersion == strings.TrimPrefix(latestVersion, "v") && a.siblingShuttleBuildMatches(feltPath, build)
}

func (a *app) feltBuildVersion() string {
	if displayVersion != "" {
		return displayVersion
	}
	return a.version
}

func (a *app) siblingShuttleBuildMatches(feltPath, expectedBuild string) bool {
	shuttlePath := filepath.Join(filepath.Dir(feltPath), "shuttle")
	info, err := os.Stat(shuttlePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), a.probeTimeout)
	defer cancel()
	output, err := a.env.CommandContext(ctx, shuttlePath, "--version").CombinedOutput()
	if err != nil {
		return false
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "shuttle version ")
	return version == expectedBuild
}

func (a *app) refuseHomebrewUpdate(path string) error {
	resolved := filepath.Clean(path)
	if absolute, err := a.env.Abs(resolved); err == nil {
		resolved = absolute
	}
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		resolved = real
	}
	if strings.Contains(filepath.ToSlash(resolved), "/Cellar/") {
		return homebrewUpdateError(resolved)
	}
	brew, err := a.env.LookPath("brew")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), a.probeTimeout)
	defer cancel()
	output, err := a.env.CommandContext(ctx, brew, "--prefix").Output()
	if err != nil {
		return nil
	}
	prefix := strings.TrimSpace(string(output))
	if real, err := filepath.EvalSymlinks(prefix); err == nil {
		prefix = real
	}
	if prefix != "" && a.pathWithin(resolved, prefix) {
		return homebrewUpdateError(resolved)
	}
	return nil
}

func homebrewUpdateError(path string) error {
	return fmt.Errorf("felt at %s is managed by Homebrew; update it with `brew upgrade felt`", path)
}

func (a *app) pathWithin(path, root string) bool {
	pathAbs, err := a.env.Abs(path)
	if err != nil {
		return false
	}
	rootAbs, err := a.env.Abs(root)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil {
		return false
	}
	return rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func latestVersion() (string, error) {
	resp, err := http.Get("https://api.github.com/repos/cailmdaley/felt/releases/latest")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GitHub API: %s", resp.Status)
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	return rel.TagName, nil
}

// archiveOS returns the OS name as goreleaser formats it (title case).
func archiveOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "Darwin"
	case "linux":
		return "Linux"
	default:
		return strings.ToUpper(runtime.GOOS[:1]) + runtime.GOOS[1:]
	}
}

// archiveArch returns the arch as goreleaser formats it.
func archiveArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	default:
		return runtime.GOARCH
	}
}

func extractBinaries(r io.Reader) (map[string][]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	const maxBinaryBytes = 256 << 20
	binaries := make(map[string][]byte, 2)
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		name := path.Base(hdr.Name)
		if name != "felt" && name != "shuttle" {
			continue
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			return nil, fmt.Errorf("archive entry %q is not a regular file", hdr.Name)
		}
		if _, duplicate := binaries[name]; duplicate {
			return nil, fmt.Errorf("archive contains more than one %s binary", name)
		}
		if hdr.Size < 0 || hdr.Size > maxBinaryBytes {
			return nil, fmt.Errorf("archive entry %q exceeds the %d-byte limit", hdr.Name, maxBinaryBytes)
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxBinaryBytes+1))
		if err != nil {
			return nil, err
		}
		if len(data) > maxBinaryBytes {
			return nil, fmt.Errorf("archive entry %q exceeds the %d-byte limit", hdr.Name, maxBinaryBytes)
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("archive entry %q is empty", hdr.Name)
		}
		binaries[name] = data
	}
	for _, name := range []string{"felt", "shuttle"} {
		if _, ok := binaries[name]; !ok {
			return nil, fmt.Errorf("binary %q not found in archive", name)
		}
	}
	return binaries, nil
}

func replaceBinaryPair(feltPath string, binaries map[string][]byte) error {
	feltBinary, feltOK := binaries["felt"]
	shuttleBinary, shuttleOK := binaries["shuttle"]
	if !feltOK || !shuttleOK {
		return errors.New("both felt and shuttle binaries are required")
	}
	directory := filepath.Dir(feltPath)
	targets := []struct {
		path string
		data []byte
	}{{feltPath, feltBinary}, {filepath.Join(directory, "shuttle"), shuttleBinary}}
	for _, target := range targets {
		if info, err := os.Lstat(target.path); err == nil {
			if info.IsDir() || info.Mode()&os.ModeSymlink == 0 && !info.Mode().IsRegular() {
				return fmt.Errorf("binary destination %q is not a regular file", target.path)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("checking binary destination %q: %w", target.path, err)
		}
	}

	type stagedBinary struct {
		target string
		temp   string
		backup string
		moved  bool
		placed bool
	}
	staged := make([]stagedBinary, 0, len(targets))
	cleanupTemps := func() {
		for _, item := range staged {
			if item.temp != "" {
				_ = os.Remove(item.temp)
			}
			if item.backup != "" && !item.moved {
				_ = os.Remove(item.backup)
			}
		}
	}
	for _, target := range targets {
		file, err := os.CreateTemp(directory, ".felt-update-*")
		if err != nil {
			cleanupTemps()
			return fmt.Errorf("staging %q: %w", target.path, err)
		}
		item := stagedBinary{target: target.path, temp: file.Name()}
		staged = append(staged, item)
		if err := file.Chmod(0o755); err != nil {
			_ = file.Close()
			cleanupTemps()
			return fmt.Errorf("setting mode on staged %q: %w", target.path, err)
		}
		if _, err := file.Write(target.data); err != nil {
			_ = file.Close()
			cleanupTemps()
			return fmt.Errorf("writing staged %q: %w", target.path, err)
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			cleanupTemps()
			return fmt.Errorf("syncing staged %q: %w", target.path, err)
		}
		if err := file.Close(); err != nil {
			cleanupTemps()
			return fmt.Errorf("closing staged %q: %w", target.path, err)
		}
	}

	rollback := func() error {
		var rollbackErr error
		for i := len(staged) - 1; i >= 0; i-- {
			item := &staged[i]
			if item.placed {
				if err := os.Remove(item.target); err != nil && !errors.Is(err, os.ErrNotExist) {
					rollbackErr = errors.Join(rollbackErr, fmt.Errorf("removing new %q: %w", item.target, err))
				}
			}
			if item.moved {
				if err := os.Rename(item.backup, item.target); err != nil {
					rollbackErr = errors.Join(rollbackErr, fmt.Errorf("restoring %q: %w", item.target, err))
				}
			}
		}
		cleanupTemps()
		return rollbackErr
	}

	for i := range staged {
		item := &staged[i]
		if _, err := os.Lstat(item.target); err == nil {
			backup, err := os.CreateTemp(directory, ".felt-update-backup-*")
			if err != nil {
				return errors.Join(fmt.Errorf("preparing backup for %q: %w", item.target, err), rollback())
			}
			item.backup = backup.Name()
			if err := backup.Close(); err != nil {
				_ = os.Remove(item.backup)
				return errors.Join(fmt.Errorf("closing backup placeholder for %q: %w", item.target, err), rollback())
			}
			if err := os.Remove(item.backup); err != nil {
				return errors.Join(fmt.Errorf("removing backup placeholder for %q: %w", item.target, err), rollback())
			}
			if err := os.Rename(item.target, item.backup); err != nil {
				return errors.Join(fmt.Errorf("backing up %q: %w", item.target, err), rollback())
			}
			item.moved = true
		} else if !errors.Is(err, os.ErrNotExist) {
			return errors.Join(fmt.Errorf("checking backup source %q: %w", item.target, err), rollback())
		}
	}
	for i := range staged {
		item := &staged[i]
		if err := os.Rename(item.temp, item.target); err != nil {
			return errors.Join(fmt.Errorf("installing %q: %w", item.target, err), rollback())
		}
		item.temp = ""
		item.placed = true
	}
	for _, item := range staged {
		if item.moved {
			if err := os.Remove(item.backup); err != nil {
				return fmt.Errorf("both CLIs were updated, but removing backup %q failed: %w", item.backup, err)
			}
		}
	}
	return nil
}
