package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) rexSetupCmd() *cobra.Command {
	var (
		configDir string
		source    string
		key       string
		dryRun    bool
	)

	cmd := &cobra.Command{
		Use:   "rex-setup",
		Short: "Install Shuttle's native Rex palette plugin into Rex's config directory",
		Long: `Install share/rex/shuttle.lua into Rex's config directory (~/.config/rex/shuttle/init.lua)
and add require("shuttle").setup{} to ~/.config/rex/init.lua if not already present.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runRexSetup(configDir, source, key, dryRun)
		},
	}

	cmd.Flags().StringVar(&configDir, "config-dir", "", "Rex config directory (defaults to $XDG_CONFIG_HOME/rex or ~/.config/rex)")
	cmd.Flags().StringVar(&source, "source", "", "Path to shuttle.lua (defaults to release or checkout share/rex/shuttle.lua)")
	cmd.Flags().StringVar(&key, "key", "", "Keybinding override for shuttle_palette (e.g. cmd+p, shift+cmd+p, or false)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Print planned changes without writing files")

	return cmd
}

func (a *app) runRexSetup(configDir, source, key string, dryRun bool) error {
	srcPath, err := a.findRexShuttleLua(source)
	if err != nil {
		return err
	}
	luaBytes, err := os.ReadFile(srcPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", srcPath, err)
	}

	dir, err := a.rexConfigDir(configDir)
	if err != nil {
		return err
	}

	destLua := filepath.Join(dir, "shuttle", "init.lua")
	initLua := filepath.Join(dir, "init.lua")
	setupLine := formatRexSetupLine(key)

	existingInit, err := os.ReadFile(initLua)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", initLua, err)
	}
	alreadyWired := containsShuttleRequire(string(existingInit))

	if dryRun {
		fmt.Fprintf(a.env.Stdout, "would copy %s -> %s\n", srcPath, destLua)
		if alreadyWired {
			fmt.Fprintf(a.env.Stdout, "would keep %s (already requires shuttle)\n", initLua)
		} else {
			fmt.Fprintf(a.env.Stdout, "would append to %s: %s\n", initLua, setupLine)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(destLua), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(destLua), err)
	}
	if err := os.WriteFile(destLua, luaBytes, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", destLua, err)
	}

	if !alreadyWired {
		var buf strings.Builder
		if len(existingInit) > 0 {
			buf.Write(existingInit)
			if !strings.HasSuffix(string(existingInit), "\n") {
				buf.WriteByte('\n')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(setupLine)
		buf.WriteByte('\n')
		if err := os.WriteFile(initLua, []byte(buf.String()), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", initLua, err)
		}
	}

	fmt.Fprintf(a.env.Stdout, "installed %s\n", destLua)
	if alreadyWired {
		fmt.Fprintf(a.env.Stdout, "kept %s (already requires shuttle)\n", initLua)
	} else {
		fmt.Fprintf(a.env.Stdout, "updated %s with %s\n", initLua, setupLine)
	}
	fmt.Fprintln(a.env.Stdout, "reload Rex with: rex config reload")
	return nil
}

func (a *app) rexConfigDir(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return explicit, nil
	}
	if xdg := strings.TrimSpace(a.env.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "rex"), nil
	}
	home, err := a.env.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "rex"), nil
}

func (a *app) findRexShuttleLua(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		if isRegularFile(explicit) {
			return explicit, nil
		}
		return "", fmt.Errorf("shuttle.lua not found at %s", explicit)
	}

	var candidates []string
	if release, err := a.findDaemonRelease(); err == nil {
		candidates = append(candidates, filepath.Join(release.Dir, "share", "rex", "shuttle.lua"))
		if filepath.Base(release.Dir) == "rel" && filepath.Base(filepath.Dir(release.Dir)) == "bin" {
			candidates = append(candidates, filepath.Join(filepath.Dir(filepath.Dir(release.Dir)), "daemon", "share", "rex", "shuttle.lua"))
		}
	}
	if wd, err := a.env.Getwd(); err == nil && wd != "" {
		candidates = append(candidates, filepath.Join(wd, "daemon", "share", "rex", "shuttle.lua"))
	}
	for _, candidate := range candidates {
		if isRegularFile(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("shuttle.lua not found (pass --source /path/to/daemon/share/rex/shuttle.lua)")
}

func formatRexSetupLine(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return `require("shuttle").setup{}`
	}
	if trimmed == "false" {
		return `require("shuttle").setup{ key = false }`
	}
	return fmt.Sprintf(`require("shuttle").setup{ key = %q }`, trimmed)
}

func containsShuttleRequire(content string) bool {
	return strings.Contains(content, `require("shuttle")`) || strings.Contains(content, `require('shuttle')`)
}
