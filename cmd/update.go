package cmd

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

type ghRelease struct {
	TagName string `json:"tag_name"`
}

func init() {
	rootCmd.AddCommand(updateCmd)
}

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update felt to the latest version",
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

		// Extract the "felt" binary from the tar.gz
		binary, err := extractBinary(resp.Body)
		if err != nil {
			return fmt.Errorf("extracting binary: %w", err)
		}

		// Replace the running binary
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("locating current binary: %w", err)
		}

		// Atomic-ish replace: rename old, write new, remove old
		old := exe + ".old"
		if err := os.Rename(exe, old); err != nil {
			return fmt.Errorf("backing up current binary: %w (try running with sudo?)", err)
		}

		if err := os.WriteFile(exe, binary, 0755); err != nil {
			// Try to restore
			os.Rename(old, exe)
			return fmt.Errorf("writing new binary: %w", err)
		}

		os.Remove(old)
		fmt.Printf("Updated to %s\n", latestClean)
		return nil
	},
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
		if len(runtime.GOOS) == 0 {
			return ""
		}
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

func extractBinary(r io.Reader) ([]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Name == "felt" || strings.HasSuffix(hdr.Name, "/felt") {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("binary 'felt' not found in archive")
}
