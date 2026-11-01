package shuttlecli

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/spf13/cobra"
)

// selectDaemonRelease publishes the launch target atomically. The repo pointer
// accepts checkout paths too, so existing installations need no separate state.
func (a *app) selectDaemonRelease(release daemonRelease) error {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".shuttle")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(dir, "repo"), []byte(release.Dir+"\n"), 0o600)
}

func (a *app) daemonSelectReleaseCmd() *cobra.Command {
	return &cobra.Command{Use: "select-release <path>", Short: "Select the release supervisors boot next", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			release, err := a.validateDaemonRelease(args[0])
			if err != nil {
				return err
			}
			return a.selectDaemonRelease(release)
		}}
}

func plistStringValue(source, wanted string) string {
	decoder := xml.NewDecoder(strings.NewReader(source))
	key := ""
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return ""
		}
		if err != nil {
			return ""
		}
		element, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if element.Name.Local != "key" && element.Name.Local != "string" {
			continue
		}
		var value string
		if decoder.DecodeElement(&value, &element) != nil {
			return ""
		}
		if element.Name.Local == "key" {
			key = value
		} else if key == wanted {
			return value
		}
	}
}

// refresh-release migrates installed path-pinned supervisors through the normal
// ownership-checked installer, preserving their operator settings.
func (a *app) daemonRefreshReleaseCmd() *cobra.Command {
	return &cobra.Command{Use: "refresh-release", Hidden: true, Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			migration := *a
			migration.env = a.env.Clone()
			a := &migration
			a.env.Unset("SHUTTLE_RELEASE")
			if daemonRespawnLoopPresent(a.env) {
				return nil
			}
			home, err := a.env.UserHomeDir()
			if err != nil {
				return err
			}
			osName := supervisorOS(runtime.GOOS)
			pattern := filepath.Join(home, "Library", "LaunchAgents", "*.plist")
			if osName == "Linux" {
				pattern = filepath.Join(home, ".config", "systemd", "user", "*.service")
			}
			paths, err := filepath.Glob(pattern)
			if err != nil {
				return err
			}
			for _, path := range paths {
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				source := string(data)
				if !strings.Contains(source, "SHUTTLE_RELEASE") || !strings.Contains(source, "shuttle") {
					continue
				}
				values, err := supervisorEnvironment(osName, source)
				if err != nil {
					return err
				}
				label := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
				log := ""
				if osName == "Linux" {
					if label == "shuttle-daemon" {
						label = defaultDaemonLabel
					} else {
						label = "io.shuttle." + label
					}
					for _, line := range strings.Split(source, "\n") {
						if value, ok := strings.CutPrefix(line, "StandardOutput=append:"); ok {
							if strings.HasPrefix(value, "\"") {
								value, err = strconv.Unquote(value)
								if err != nil {
									return err
								}
							}
							log = strings.ReplaceAll(value, "%%", "%")
						}
					}
				} else {
					log = plistStringValue(source, "StandardOutPath")
				}
				if log == "" {
					log = values["SHUTTLE_LOG"]
				}
				options := supervisorOptions{OS: osName, Label: label, Stores: values["SHUTTLE_STORES"], StoresSet: true,
					StoresFile: values["SHUTTLE_STORES_FILE"], Path: values["PATH"], Log: log, Port: values["SHUTTLE_PORT"],
					SSHSocket: values["SSH_AUTH_SOCK"], SSHSocketSet: true, TmuxTmpdir: values["TMUX_TMPDIR"], TmuxTmpdirSet: true,
					CodexSocket: values["SHUTTLE_CODEX_SOCKET"], CodexSocketSet: true, CodexHome: values["CODEX_HOME"]}
				if err := a.installDaemonSupervisor(options); err != nil {
					return fmt.Errorf("refreshing %s: %w", path, err)
				}
			}
			return nil
		}}
}
