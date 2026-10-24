package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// supervisorHostSettings resolves the service's endpoint, not a caller-only
// override. Managers can carry their own environment; the rendered port wins.
func (a *app) supervisorHostSettings(options supervisorOptions) (hostSettings, error) {
	env := a.env.Clone()
	keys := []string{"SHUTTLE_LISTEN", "SHUTTLE_HOST_CONFIG_FILE", "SHUTTLE_DATA_DIR", "SHUTTLE_PORT"}
	for _, key := range keys {
		env.Unset(key)
	}
	if options.OS == "Linux" {
		dropins, err := a.env.Command("systemctl", "--user", "show", systemdUnitName(options.Label), "--property=DropInPaths", "--property=LoadState").Output()
		if err != nil && !strings.Contains(string(dropins), "LoadState=not-found") {
			return hostSettings{}, fmt.Errorf("inspecting service overrides: %w", err)
		}
		for _, line := range strings.Split(string(dropins), "\n") {
			if value, ok := strings.CutPrefix(line, "DropInPaths="); ok && strings.TrimSpace(value) != "" {
				return hostSettings{}, fmt.Errorf("cannot safely refresh %s with systemd drop-ins; move its settings into install options or host.json first", systemdUnitName(options.Label))
			}
		}
		out, err := a.env.Command("systemctl", "--user", "show-environment").Output()
		if err != nil {
			return hostSettings{}, fmt.Errorf("systemd user manager is unavailable: %w", err)
		}
		for _, line := range strings.Split(string(out), "\n") {
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			for _, wanted := range keys {
				if key != wanted {
					continue
				}
				// These endpoint values are normally plain paths/URIs. Refuse shell-
				// encoded overrides instead of evaluating manager-provided shell text.
				if strings.ContainsAny(value, "'\"\\\\") {
					return hostSettings{}, fmt.Errorf("cannot inspect shell-encoded manager environment %s; configure its value in host.json", key)
				}
				env.Set(key, value)
			}
		}
	} else {
		for _, key := range keys {
			if out, err := a.env.Command("launchctl", "getenv", key).Output(); err == nil {
				env.Set(key, strings.TrimSpace(string(out)))
			}
		}
	}
	if options.Port != "" {
		env.Set("SHUTTLE_PORT", options.Port)
	}
	return newApp(env).resolveHostSettings()
}

// loop-present is shared by installation and the deploy script so they cannot
// disagree about a pane that merely contains launcher-like text.
func (a *app) daemonLoopPresentCmd() *cobra.Command {
	return &cobra.Command{Use: "loop-present", Hidden: true, Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			if daemonRespawnLoopPresent(a.env) {
				return nil
			}
			return fmt.Errorf("no verified daemon respawn loop is running")
		},
	}
}

func daemonRespawnLoopPresent(env *sysenv.Env) bool {
	home, _ := env.UserHomeDir()
	paths := []string{filepath.Join(home, ".local", "bin", "shuttle-launch")}
	repos := []string{env.Getenv("SHUTTLE_DIR")}
	if data, err := os.ReadFile(filepath.Join(home, ".shuttle", "repo")); err == nil {
		repos = append(repos, strings.TrimSpace(string(data)))
	}
	for _, repo := range repos {
		if filepath.IsAbs(repo) {
			paths = append(paths, filepath.Join(repo, "bin", "shuttle-launch"))
		}
	}
	// Include the current checkout's launcher, including invocation before install.
	if cwd, err := env.Getwd(); err == nil {
		paths = append(paths, filepath.Join(cwd, "bin", "shuttle-launch"))
	}
	for _, socket := range [][]string{nil, {"-S", filepath.Join(home, ".shuttle", "tmux.sock")}} {
		args := append(append([]string{}, socket...), "list-panes", "-t", "shuttle-daemon", "-F", "#{pane_pid}")
		pids, err := env.Command("tmux", args...).Output()
		if err != nil {
			continue
		}
		for _, pid := range strings.Fields(string(pids)) {
			if n, err := strconv.Atoi(pid); err != nil || n <= 0 {
				continue
			}
			cmd, err := env.Command("ps", "-ww", "-p", pid, "-o", "command=").Output()
			if err != nil {
				continue
			}
			command := strings.TrimSpace(string(cmd))
			for _, path := range paths {
				if !filepath.IsAbs(path) {
					continue
				}
				if command != "/bin/sh "+path+" --loop" && command != path+" --loop" {
					continue
				}
				data, err := os.ReadFile(path)
				if err != nil || !strings.Contains(string(data), "# shuttle-launch —") || !strings.Contains(string(data), "SHUTTLE_RESPAWN_LOOP=1") {
					continue
				}
				out, err := env.Command("ps", "eww", "-p", pid, "-o", "command=").Output()
				if err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), command+" ") {
					for _, field := range strings.Fields(strings.TrimPrefix(strings.TrimSpace(string(out)), command+" ")) {
						if field == "SHUTTLE_RESPAWN_LOOP=1" {
							return true
						}
					}
				}
				// Older launchers export the marker inside the shell, invisible to Linux
				// ps. Accept only their exact known script path and --loop argv, backed
				// by the installed launcher's signature, never text inside sh -c.
				return true
			}
		}
	}
	return false
}
