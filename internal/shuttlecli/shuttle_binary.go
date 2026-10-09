package shuttlecli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type ReceiptShuttleBinary struct {
	ResolvedPath     string                     `json:"resolved_path"`
	Build            string                     `json:"build"`
	Executables      []ReceiptShuttleExecutable `json:"other_executables"`
	HookResolution   string                     `json:"hook_resolution"`
	HooksWouldPickIt bool                       `json:"hooks_would_pick_this"`
}

type ReceiptShuttleExecutable struct {
	Path      string `json:"path"`
	Build     string `json:"build,omitempty"`
	Shadowing bool   `json:"shadowing"`
	Error     string `json:"error,omitempty"`
}

func (a *app) collectShuttleBinaryReceipt() ReceiptShuttleBinary {
	executable, _ := os.Executable()
	home, _ := a.env.UserHomeDir()
	build := versionLine
	if build == "" {
		build = Version
	}
	return a.collectShuttleBinaryReceiptAt(executable, build, home, a.env.Getenv("PATH"), a.env.Getenv("SHUTTLE_BIN"))
}

func (a *app) collectShuttleBinaryReceiptAt(executable, build, home, pathValue, override string) ReceiptShuttleBinary {
	resolved := a.resolveBinaryPath(executable)
	receipt := ReceiptShuttleBinary{
		ResolvedPath: resolved,
		Build:        build,
		Executables:  []ReceiptShuttleExecutable{},
	}
	seen := map[string]bool{resolved: true}
	directories := cleanPathEntries(pathValue)
	if home != "" {
		directories = append(directories, filepath.Join(home, ".local", "bin"), filepath.Join(home, "go", "bin"))
	}
	directories = append(directories, "/opt/homebrew/bin", "/usr/local/bin")
	for _, directory := range cleanPathEntries(strings.Join(directories, string(os.PathListSeparator))) {
		candidate := filepath.Join(directory, "shuttle")
		if !isExecutable(candidate) {
			continue
		}
		candidate = a.resolveBinaryPath(candidate)
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		candidateBuild, errText := a.shuttleExecutableBuild(candidate)
		receipt.Executables = append(receipt.Executables, ReceiptShuttleExecutable{
			Path: candidate, Build: candidateBuild, Shadowing: candidateBuild != "" && candidateBuild != build, Error: errText,
		})
	}
	if selected := hookShuttleResolution(home, pathValue, override); selected != "" {
		receipt.HookResolution = a.resolveBinaryPath(selected)
		receipt.HooksWouldPickIt = receipt.HookResolution == resolved
	}
	return receipt
}

func (a *app) shuttleExecutableBuild(path string) (string, string) {
	ctx, cancel := context.WithTimeout(context.Background(), a.versionProbeTimeout)
	defer cancel()
	output, err := a.env.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return "", fmt.Sprintf("--version failed: %s", strings.TrimSpace(string(output)))
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "shuttle version ")
	if version == "" {
		return "", "--version returned no build"
	}
	return version, ""
}

func hookShuttleResolution(home, pathValue, override string) string {
	if override != "" && isExecutable(override) {
		return override
	}
	if path := findExecutableInPath("shuttle", pathValue); path != "" {
		return path
	}
	for _, candidate := range []string{
		filepath.Join(home, ".local", "bin", "shuttle"),
		"/opt/homebrew/bin/shuttle",
		"/usr/local/bin/shuttle",
	} {
		if isExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

func (a *app) resolveBinaryPath(path string) string {
	if path == "" {
		return ""
	}
	if absolute, err := a.env.Abs(path); err == nil {
		path = absolute
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return filepath.Clean(path)
}
