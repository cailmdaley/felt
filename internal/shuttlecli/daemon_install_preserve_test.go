package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDaemonInstallPreserve(t *testing.T) {
	t.Parallel()
	for _, osName := range []string{"Darwin", "Linux"} {
		for _, label := range []string{defaultDaemonLabel, "io.shuttle.extra"} {
			for _, fixed := range []bool{false, true} {
				t.Run(osName+"/"+label+"/fixed="+map[bool]string{false: "false", true: "true"}[fixed], func(t *testing.T) {
					t.Parallel()
					env, home := envWithHome(t)
					a := stubLoginEnv(env, loginEnv{Path: "/wrong/login/bin", TmuxTmpdir: "/wrong/login/tmux"})
					options := supervisorOptions{
						OS: osName, Label: label, ShuttleBin: "/opt/shuttle", Path: "/saved/bin:/usr/bin",
						StoresFile: filepath.Join(home, "registry with spaces.json"), Port: "4401",
						Log:         filepath.Join(home, "logs", "saved & 50%.log"),
						CodexSocket: "/tmp/saved control.sock", CodexHome: "/tmp/saved codex home",
					}
					if fixed {
						options.Stores, options.TmuxTmpdir, options.SSHSocket = "/fixed/one,/fixed/two", "/saved/tmux", "/saved/agent.sock"
					}
					// The blank settings deliberately omit SSH_AUTH_SOCK and TMUX_TMPDIR.
					// A preserve install must not replace them with login-shell defaults.
					if err := os.WriteFile(options.StoresFile, []byte(`{"felt_stores":[]}`), 0600); err != nil {
						t.Fatal(err)
					}
					name := "io.shuttle.daemon.plist.template"
					if osName == "Linux" {
						name = "io.shuttle.daemon.service.template"
					}
					source, err := os.ReadFile(filepath.Join("../../daemon/share", name))
					if err != nil {
						t.Fatal(err)
					}
					rendered, err := a.renderSupervisorTemplate(osName, string(source), options, daemonRelease{Dir: "/opt/saved-release"})
					if err != nil {
						t.Fatal(err)
					}
					installed, err := a.supervisorDefinitionPath(options)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.MkdirAll(filepath.Dir(installed), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(installed, []byte(rendered), 0600); err != nil {
						t.Fatal(err)
					}
					release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "new-release"))
					if err := os.MkdirAll(filepath.Join(release.Dir, "share"), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(release.Dir, "share", name), source, 0600); err != nil {
						t.Fatal(err)
					}
					env.Set("SHUTTLE_RELEASE", release.Dir)
					for key, value := range map[string]string{
						"AGENT_STORES": "/wrong/store", "SHUTTLE_STORES_FILE": "/wrong/registry.json",
						"AGENT_PORT": "4999", "AGENT_PATH": "/wrong/bin", "AGENT_LOG": "/wrong/log",
						"AGENT_SSH_AUTH_SOCK": "/wrong/ssh.sock", "AGENT_TMUX_TMPDIR": "/wrong/tmux",
						"SHUTTLE_CODEX_SOCKET": "/wrong/codex.sock", "CODEX_HOME": "/wrong/codex",
					} {
						env.Set(key, value)
					}
					for _, explicit := range []bool{false, true} {
						args := []string{"daemon", "install", "--preserve", "--print", "--os", osName, "--label", label}
						want, err := supervisorCodexEnvironment(osName, rendered)
						if err != nil {
							t.Fatal(err)
						}
						want["SHUTTLE_RELEASE"] = release.Dir
						if explicit {
							args = append(args, "--stores=", "--stores-file=/tmp/override-registry.json", "--port=4502", "--path=/explicit/bin", "--log=/tmp/explicit.log", "--ssh-auth-sock=", "--tmux-tmpdir=", "--codex-socket=/tmp/explicit.sock", "--codex-home=/tmp/explicit-codex")
							for key, value := range map[string]string{
								"SHUTTLE_STORES": "", "SHUTTLE_STORES_FILE": "/tmp/override-registry.json", "SHUTTLE_PORT": "4502",
								"PATH": "/explicit/bin", "SHUTTLE_LOG": "/tmp/explicit.log", "SSH_AUTH_SOCK": "", "TMUX_TMPDIR": "",
								"SHUTTLE_CODEX_SOCKET": "/tmp/explicit.sock", "CODEX_HOME": "/tmp/explicit-codex",
							} {
								want[key] = value
							}
						}
						out, stderr, err := executeApp(t, a, home, args...)
						if err != nil {
							t.Fatalf("preserve (explicit=%v): %v %s", explicit, err, stderr)
						}
						got, err := supervisorCodexEnvironment(osName, out)
						if err != nil {
							t.Fatal(err)
						}
						for key, expected := range want {
							if got[key] != expected {
								t.Errorf("explicit=%v: %s=%q, want %q", explicit, key, got[key], expected)
							}
						}
						if !fixed || explicit {
							for _, key := range []string{"SSH_AUTH_SOCK", "TMUX_TMPDIR"} {
								if _, present := got[key]; present {
									t.Errorf("explicit=%v: empty %s must remain omitted", explicit, key)
								}
							}
						}
					}
					registry, err := os.ReadFile(options.StoresFile)
					if err != nil || string(registry) != `{"felt_stores":[]}` {
						t.Fatalf("preserve changed the editable registry: %q, %v", registry, err)
					}
				})
			}
		}
	}
}

func TestDaemonInstallPreserveRefusesMissingOrUndecodableDefinition(t *testing.T) {
	t.Parallel()
	for _, osName := range []string{"Darwin", "Linux"} {
		for _, source := range []string{"", "broken definition", `<plist><dict>`, "[Service]\nEnvironment=\"PATH=bad\\escape\"\n"} {
			t.Run(osName+"/"+source, func(t *testing.T) {
				t.Parallel()
				env, home := envWithHome(t)
				a := newApp(env)
				path, err := a.supervisorDefinitionPath(supervisorOptions{OS: osName, Label: "io.shuttle.extra"})
				if err != nil {
					t.Fatal(err)
				}
				if source != "" {
					if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(source), 0600); err != nil {
						t.Fatal(err)
					}
				}
				out, _, err := executeApp(t, a, home, "daemon", "install", "--preserve", "--print", "--os", osName, "--label", "io.shuttle.extra")
				if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "without --preserve") || out != "" {
					t.Fatalf("expected actionable refusal of %s; got %q, %v", path, out, err)
				}
			})
		}
	}
}
