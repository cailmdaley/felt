package feltcli

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

type ghRelease struct {
	TagName string `json:"tag_name"`
}

func init() {
	updateCmd.GroupID = groupAgents
	rootCmd.AddCommand(updateCmd)
}

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update felt and shuttle to the latest release",
	Long: `Replaces both CLI binaries from the latest GitHub release (a dev build asks first),
then moves the agent integrations to the matching tag so hooks and skills stay
in step with the binary: the Claude Code plugin whenever the claude CLI is on
PATH, and the Codex and pi integrations where felt is already installed.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Get latest release tag from GitHub
		latest, err := latestVersion()
		if err != nil {
			return fmt.Errorf("checking latest version: %w", err)
		}

		current := Version
		latestClean := strings.TrimPrefix(latest, "v")

		if current == latestClean {
			fmt.Printf("Already up to date (%s)\n", current)
			return nil
		}

		if current == "dev" {
			fmt.Println("Running a dev build — cannot determine current version.")
			fmt.Printf("Latest release is %s. Continue? [y/N] ", latest)
			var answer string
			fmt.Scanln(&answer)
			if answer != "y" && answer != "Y" {
				return nil
			}
		} else {
			fmt.Printf("Updating %s → %s\n", current, latestClean)
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
		feltPath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("locating current felt binary: %w", err)
		}
		if err := replaceBinaryPair(feltPath, binaries); err != nil {
			return fmt.Errorf("replacing felt and shuttle binaries: %w", err)
		}

		fmt.Printf("Updated felt and shuttle to %s\n", latestClean)
		refreshPluginAfterUpdate(defaultMarketplaceRef())
		return nil
	},
}

// refreshPluginAfterUpdate keeps both agent integrations in lockstep with the
// binary that just landed, pointing each at the same marketplaceRef so an
// update from a local checkout doesn't leave one harness on the checkout and
// the other on GitHub. Failures are surfaced as one-line warnings rather than
// errored — the binary update has already succeeded and shouldn't be undone
// because a downstream integration step couldn't run (e.g. claude CLI missing,
// network blip on marketplace fetch).
func refreshPluginAfterUpdate(marketplaceRef string) {
	if _, err := exec.LookPath("claude"); err != nil {
		fmt.Println("Plugin refresh skipped: claude CLI not on PATH (run `felt setup claude` once it is).")
	} else {
		fmt.Println()
		fmt.Println("Refreshing Claude Code plugin...")
		if err := installPluginViaCLI(marketplaceRef); err != nil {
			fmt.Printf("Plugin refresh failed: %v\n", err)
			fmt.Println("Rerun `felt setup claude` to retry.")
		}
	}
	refreshCodexSetupIfInstalled(marketplaceRef)
	refreshPiSetupIfInstalled(marketplaceRef)
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
