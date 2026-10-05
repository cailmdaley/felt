package shuttlecli

import (
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSupervisorTemplatesRenderBothPlatforms(t *testing.T) {
	releaseDir := filepath.Join(t.TempDir(), "release")
	release := writeTestDaemonRelease(t, releaseDir)
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	templates := supervisorTemplateFixtures()
	for name, source := range templates {
		if err := os.WriteFile(filepath.Join(share, name), []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	options := supervisorOptions{
		Label:      `io.shuttle.test & <unit>`,
		ShuttleBin: `/tmp/go bin/shuttle "quoted" \literal %bin`,
		Stores:     `/tmp/store with spaces & <notes> "quoted" \literal %store`,
		StoresFile: `/tmp/config with spaces "quoted" \literal %file/stores.json`,
		Path:       `/tmp/bin one:/opt/bin"quoted"\path:%path`,
		Log:        `/tmp/log dir/"quoted"\literal %log`,
		Port:       "4401",
		SSHSocket:  `/tmp/ssh socket/"quoted"\literal %sock`,
		TmuxTmpdir: `/scratch/tmux dir/"quoted"\literal %tmux & <x>`,
	}

	for _, tc := range []struct {
		osName string
		name   string
	}{
		{"Darwin", "io.shuttle.daemon.plist.template"},
		{"Linux", "io.shuttle.daemon.service.template"},
	} {
		t.Run(tc.osName, func(t *testing.T) {
			path, err := findSupervisorTemplate(release, tc.osName)
			if err != nil || filepath.Base(path) != tc.name {
				t.Fatalf("template path = %q, %v", path, err)
			}
			source, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			rendered, err := renderSupervisorTemplate(tc.osName, string(source), options, release)
			if err != nil {
				t.Fatalf("render template: %v", err)
			}
			if remaining := templatePlaceholderPattern.FindAllString(rendered, -1); len(remaining) != 0 {
				t.Fatalf("unrendered placeholders: %v\n%s", remaining, rendered)
			}
			if tc.osName == "Darwin" {
				if !strings.Contains(rendered, "&amp; &lt;unit&gt;") || !strings.Contains(rendered, "&lt;notes&gt;") ||
					!strings.Contains(rendered, "<key>TMUX_TMPDIR</key>\n<string>/scratch/tmux dir/&#34;quoted&#34;\\literal %tmux &amp; &lt;x&gt;</string>") {
					t.Fatalf("plist values were not XML escaped:\n%s", rendered)
				}
				decoder := xml.NewDecoder(strings.NewReader(rendered))
				for {
					_, err := decoder.Token()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatalf("rendered plist is not well-formed XML: %v", err)
					}
				}
			} else {
				if !strings.Contains(rendered, "WorkingDirectory="+release.Dir+"\n") || strings.Contains(rendered, `WorkingDirectory="`) {
					t.Fatalf("systemd WorkingDirectory must be unquoted:\n%s", rendered)
				}
				for _, want := range []string{
					`ExecStart="/tmp/go bin/shuttle \"quoted\" \\literal %%bin" daemon start --force`,
					`Environment="SHUTTLE_STORES=/tmp/store with spaces & <notes> \"quoted\" \\literal %%store"`,
					`StandardOutput=append:/tmp/log dir/"quoted"\literal %%log`,
					`StandardError=append:/tmp/log dir/"quoted"\literal %%log`,
					`Environment="SHUTTLE_LOG=/tmp/log dir/\"quoted\"\\literal %%log"`,
					`Environment="SHUTTLE_RELEASE=` + systemdQuotedValue(release.Dir) + `"`,
					`Environment="TMUX_TMPDIR=/scratch/tmux dir/\"quoted\"\\literal %%tmux & <x>"`,
				} {
					if !strings.Contains(rendered, want) {
						t.Errorf("systemd unit missing escaped value %q:\n%s", want, rendered)
					}
				}
				if strings.Contains(rendered, `Environment="SHUTTLE_PORT="`) || strings.Contains(rendered, `Environment="SSH_AUTH_SOCK="`) {
					t.Fatalf("non-empty optional values were omitted:\n%s", rendered)
				}
			}
		})
	}
}

func TestTrackedSupervisorTemplatesRenderFromFakeRelease(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"io.shuttle.daemon.plist.template", "io.shuttle.daemon.service.template"} {
		source, err := os.ReadFile(filepath.Join("..", "..", "daemon", "share", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(share, name), source, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	options := supervisorOptions{
		Label: "io.shuttle.test", ShuttleBin: "/opt/shuttle", StoresFile: "/tmp/stores.json",
		Path: "/usr/bin:/home/test/.local/bin", Log: "/tmp/shuttle.log", Port: "4401",
		SSHSocket: "/tmp/ssh-agent.sock", TmuxTmpdir: "/scratch/tmux",
	}
	for _, tc := range []struct {
		osName string
		want   string
		tmux   string
	}{
		{"Darwin", `<string>daemon</string>`, "<key>TMUX_TMPDIR</key>\n        <string>/scratch/tmux</string>"},
		{"Linux", `ExecStart="/opt/shuttle" daemon start --force`, `Environment="TMUX_TMPDIR=/scratch/tmux"`},
	} {
		t.Run(tc.osName, func(t *testing.T) {
			path, err := findSupervisorTemplate(release, tc.osName)
			if err != nil {
				t.Fatal(err)
			}
			source, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			rendered, err := renderSupervisorTemplate(tc.osName, string(source), options, release)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(rendered, tc.want) || templatePlaceholderPattern.MatchString(rendered) {
				t.Fatalf("rendered template does not start shuttle or has placeholders:\n%s", rendered)
			}
			if !strings.Contains(rendered, tc.tmux) {
				t.Fatalf("rendered template lacks TMUX_TMPDIR %q:\n%s", tc.tmux, rendered)
			}
			bare := options
			bare.TmuxTmpdir = ""
			without, err := renderSupervisorTemplate(tc.osName, string(source), bare, release)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(without, "<key>TMUX_TMPDIR</key>") || strings.Contains(without, `Environment="TMUX_TMPDIR=`) {
				t.Fatalf("empty TMUX_TMPDIR was rendered:\n%s", without)
			}
			if tc.osName == "Darwin" {
				decoder := xml.NewDecoder(strings.NewReader(rendered))
				for {
					if _, err := decoder.Token(); err == io.EOF {
						break
					} else if err != nil {
						t.Fatalf("rendered plist is not well-formed XML: %v", err)
					}
				}
			}
		})
	}
}

func TestSupervisorTemplatesSetFileDescriptorHeadroom(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	options := supervisorOptions{
		Label: defaultDaemonLabel, ShuttleBin: "/bin/shuttle", StoresFile: "/tmp/stores.json",
		Path: "/bin", Log: "/tmp/shuttle.log",
	}
	for _, tc := range []struct {
		osName string
		name   string
	}{
		{"Darwin", "io.shuttle.daemon.plist.template"},
		{"Linux", "io.shuttle.daemon.service.template"},
	} {
		t.Run(tc.osName, func(t *testing.T) {
			source, err := os.ReadFile(filepath.Join("..", "..", "daemon", "share", tc.name))
			if err != nil {
				t.Fatal(err)
			}
			rendered, err := renderSupervisorTemplate(tc.osName, string(source), options, release)
			if err != nil {
				t.Fatalf("render template: %v", err)
			}
			if tc.osName == "Darwin" {
				flat := strings.Join(strings.Fields(rendered), " ")
				want := "<key>SoftResourceLimits</key> <dict> <key>NumberOfFiles</key> <integer>8192</integer> </dict>"
				if count := strings.Count(flat, "<key>SoftResourceLimits</key>"); count != 1 || strings.Count(flat, want) != 1 {
					t.Errorf("SoftResourceLimits NumberOfFiles setting is not exactly one 8192 limit")
				}
				// The hard limit stays launchd's default, so the daemon's children
				// (a tmux server and its workers) keep their headroom.
				if strings.Contains(flat, "HardResourceLimits") {
					t.Errorf("plist caps HardResourceLimits; the daemon's children inherit that cap")
				}
			} else {
				count := 0
				for _, line := range strings.Split(rendered, "\n") {
					line = strings.TrimSpace(line)
					if strings.HasPrefix(line, "LimitNOFILE=") {
						count++
						if line != "LimitNOFILE=8192" {
							t.Errorf("systemd file descriptor limit = %q; want 8192", line)
						}
					}
				}
				if count != 1 {
					t.Errorf("systemd LimitNOFILE directive occurs %d times; want exactly once", count)
				}
			}
		})
	}
}

func TestDaemonInstallLinuxPrintOmitsDarwinSSHAgentDefault(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "io.shuttle.daemon.service.template"
	if err := os.WriteFile(filepath.Join(share, name), []byte(supervisorTemplateFixtures()[name]), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHUTTLE_RELEASE", release.Dir)
	t.Setenv("SHUTTLE_STORES_FILE", filepath.Join(home, "stores.json"))
	previous, wasSet := os.LookupEnv("AGENT_SSH_AUTH_SOCK")
	if err := os.Unsetenv("AGENT_SSH_AUTH_SOCK"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if wasSet {
			_ = os.Setenv("AGENT_SSH_AUTH_SOCK", previous)
		} else {
			_ = os.Unsetenv("AGENT_SSH_AUTH_SOCK")
		}
	})
	stubLoginEnv(t, loginEnv{Path: "/captured", TmuxTmpdir: ""})
	out, stderr, err := executeCLI(t, t.TempDir(), "daemon", "install", "--print", "--os", "Linux", "--path", "/bin", "--log", filepath.Join(home, "shuttle.log"))
	if err != nil {
		t.Fatalf("daemon install --print --os Linux: %v\n%s", err, stderr)
	}
	if strings.Contains(out, "SSH_AUTH_SOCK") {
		t.Fatalf("Linux preview inherited a Darwin SSH-agent default:\n%s", out)
	}
}

func TestDaemonInstallPrintRendersFromFakeRelease(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"io.shuttle.daemon.plist.template", "io.shuttle.daemon.service.template"} {
		source, err := os.ReadFile(filepath.Join("..", "..", "daemon", "share", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(share, name), source, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	storesFile := filepath.Join(t.TempDir(), "stores.json")
	if err := os.WriteFile(storesFile, []byte(`{"stores":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	feltDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(feltDir, "felt"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", feltDir)
	t.Setenv("SHUTTLE_RELEASE", release.Dir)
	t.Setenv("SHUTTLE_STORES_FILE", storesFile)
	t.Setenv("AGENT_STORES", "")
	stubLoginEnv(t, loginEnv{Path: "/captured"})
	out, stderr, err := executeCLI(t, t.TempDir(), "daemon", "install", "--dry-run", "--os", "Linux", "--stores", "", "--ssh-auth-sock=", "--path", "/usr/bin", "--log", "/tmp/shuttle.log", "--label", defaultDaemonLabel)
	if err != nil {
		t.Fatalf("daemon install --dry-run: %v\n%s", err, stderr)
	}
	if templatePlaceholderPattern.MatchString(out) || !strings.Contains(out, "daemon start --force") {
		t.Fatalf("preview is incomplete:\n%s", out)
	}
}

func TestSupervisorTemplatesOmitEmptyOptionalValues(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	options := supervisorOptions{
		OS:         "Darwin",
		Label:      defaultDaemonLabel,
		ShuttleBin: "/tmp/shuttle",
		StoresFile: "/tmp/stores.json",
		Path:       "/bin",
		Log:        "/tmp/shuttle.log",
	}
	for _, tc := range []struct {
		osName string
		name   string
	}{
		{"Darwin", "io.shuttle.daemon.plist.template"},
		{"Linux", "io.shuttle.daemon.service.template"},
	} {
		rendered, err := renderSupervisorTemplate(tc.osName, supervisorTemplateFixtures()[tc.name], options, release)
		if err != nil {
			t.Fatal(err)
		}
		if tc.osName == "Darwin" {
			if strings.Contains(rendered, "<key>SHUTTLE_PORT</key>") || strings.Contains(rendered, "<key>SSH_AUTH_SOCK</key>") || strings.Contains(rendered, "<key>TMUX_TMPDIR</key>") {
				t.Fatalf("empty optional plist entries remain:\n%s", rendered)
			}
		} else if strings.Contains(rendered, `Environment="SHUTTLE_PORT=`) || strings.Contains(rendered, `Environment="SSH_AUTH_SOCK=`) || strings.Contains(rendered, `Environment="TMUX_TMPDIR=`) {
			t.Fatalf("empty optional systemd entries remain:\n%s", rendered)
		}
	}
}

func TestSupervisorWorkingDirectoryUsesCheckoutRootAndFetchedReleaseRoot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		releaseDir func(string) string
	}{
		{"source checkout", func(root string) string { return filepath.Join(root, "bin", "rel") }},
		{"fetched release", func(root string) string { return filepath.Join(root, "release") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			release := writeTestDaemonRelease(t, tc.releaseDir(root))
			want, err := filepath.EvalSymlinks(root)
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "fetched release" {
				want = release.Dir
			}
			options := supervisorOptions{
				Label: defaultDaemonLabel, ShuttleBin: "/tmp/shuttle", StoresFile: "/tmp/stores.json",
				Path: "/bin", Log: "/tmp/shuttle.log",
			}
			for _, osName := range []string{"Darwin", "Linux"} {
				template := supervisorTemplateFixtures()["io.shuttle.daemon.service.template"]
				if osName == "Darwin" {
					template = supervisorTemplateFixtures()["io.shuttle.daemon.plist.template"]
				}
				rendered, err := renderSupervisorTemplate(osName, template, options, release)
				if err != nil {
					t.Fatal(err)
				}
				if osName == "Linux" && !strings.Contains(rendered, "WorkingDirectory="+want+"\n") {
					t.Errorf("Linux working directory does not use %q:\n%s", want, rendered)
				}
				if osName == "Darwin" && !strings.Contains(rendered, "<key>WorkingDirectory</key>\n<string>"+want+"</string>") {
					t.Errorf("launchd working directory does not use %q:\n%s", want, rendered)
				}
				if osName == "Linux" && !strings.Contains(rendered, `Environment="SHUTTLE_RELEASE=`+release.Dir+`"`) {
					t.Errorf("rendered supervisor lost SHUTTLE_RELEASE=%q:\n%s", release.Dir, rendered)
				}
				if osName == "Darwin" && !strings.Contains(rendered, `<key>Release</key><string>`+release.Dir+`</string>`) {
					t.Errorf("rendered supervisor lost its release path %q:\n%s", release.Dir, rendered)
				}
			}
		})
	}
}

func TestSupervisorInstallStopsOnlyTheIndistinguishableDefaultDaemon(t *testing.T) {
	if !supervisorInstallStopsDaemon(defaultDaemonLabel) {
		t.Fatal("replacing the default supervisor must stop its daemon")
	}
	if supervisorInstallStopsDaemon("io.shuttle.second") {
		t.Fatal("installing a second supervisor would stop the primary daemon")
	}
}

func TestSupervisorTemplateSourceCheckoutFallbackIsScopedToBinRel(t *testing.T) {
	repo := t.TempDir()
	release := writeTestDaemonRelease(t, filepath.Join(repo, "bin", "rel"))
	if err := os.MkdirAll(filepath.Join(repo, "daemon", "share"), 0o755); err != nil {
		t.Fatal(err)
	}
	name := "io.shuttle.daemon.service.template"
	if err := os.WriteFile(filepath.Join(repo, "daemon", "share", name), []byte(supervisorTemplateFixtures()[name]), 0o644); err != nil {
		t.Fatal(err)
	}
	path, err := findSupervisorTemplate(release, "Linux")
	expected, _ := filepath.EvalSymlinks(filepath.Join(repo, "daemon", "share", name))
	if err != nil || path != expected {
		t.Fatalf("checkout template path = %q, %v; want %q", path, err, expected)
	}

	fetched := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	if _, err := findSupervisorTemplate(fetched, "Linux"); err == nil {
		t.Fatal("fetched release borrowed a template from the source checkout")
	}
}

func TestSupervisorTemplateRequiresExactPlaceholderSet(t *testing.T) {
	template := supervisorTemplateFixtures()["io.shuttle.daemon.service.template"]
	if err := validateTemplatePlaceholderSet("Linux", template); err != nil {
		t.Fatalf("valid template rejected: %v", err)
	}
	if err := validateTemplatePlaceholderSet("Linux", strings.ReplaceAll(template, "__SHUTTLE_BIN__", "")); err == nil {
		t.Fatal("missing placeholder was accepted")
	}
	if err := validateTemplatePlaceholderSet("Linux", template+" __UNEXPECTED__"); err == nil {
		t.Fatal("unknown placeholder was accepted")
	}
}

func TestCaptureLoginEnvReadsFencedShellOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell capture requires a POSIX shell")
	}
	for _, tc := range []struct {
		name   string
		output string
		want   loginEnv
		ok     bool
	}{
		{"both", `banner\n__SHUTTLE_TMUX_TMPDIR__/rc/noise\n__SHUTTLE_PATH__/one:/bin:/one\n__SHUTTLE_TMUX_TMPDIR__/scratch/tmp\n`, loginEnv{Path: "/one:/bin:/one", TmuxTmpdir: "/scratch/tmp"}, true},
		{"no tmux dir", `__SHUTTLE_PATH__/usr/bin\n__SHUTTLE_TMUX_TMPDIR__\n`, loginEnv{Path: "/usr/bin"}, true},
		{"no path", `__SHUTTLE_PATH__\n__SHUTTLE_TMUX_TMPDIR__/scratch/tmp\n`, loginEnv{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shell := filepath.Join(t.TempDir(), "login-shell")
			if err := os.WriteFile(shell, []byte("#!/bin/sh\nprintf '"+tc.output+"'\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			got, ok := captureLoginEnvWith(shell, "-lc")
			if got != tc.want || ok != tc.ok {
				t.Fatalf("captured %+v, %v; want %+v, %v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestCaptureLoginEnvRunsOneLoginShellForEveryValue(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell capture requires a POSIX shell")
	}
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	rc := filepath.Join(dir, "rc")
	// The rc file exports TMUX_TMPDIR the way a cluster ~/.bashrc does; the
	// capture must evaluate the real script, not echo canned markers.
	if err := os.WriteFile(rc, []byte("PATH=/rc/bin:/usr/bin\nTMUX_TMPDIR=/scratch/me/tmp\nexport PATH TMUX_TMPDIR\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(dir, "sh")
	script := "#!/bin/sh\necho \"$1\" >> '" + calls + "'\n. '" + rc + "'\nexec /bin/sh -c \"$2\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	t.Setenv("TMUX_TMPDIR", "/leaked/from/installer")
	got := captureLoginEnv()
	if got != (loginEnv{Path: "/rc/bin:/usr/bin", TmuxTmpdir: "/scratch/me/tmp"}) {
		t.Fatalf("captured %+v", got)
	}
	invocations, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(invocations)) != "-lic" {
		t.Fatalf("login shell invocations = %q; want one -lic run", invocations)
	}
}

func TestDaemonInstallTmuxTmpdirPrecedence(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, source := range supervisorTemplateFixtures() {
		if err := os.WriteFile(filepath.Join(share, name), []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHUTTLE_RELEASE", release.Dir)
	t.Setenv("SHUTTLE_STORES_FILE", filepath.Join(home, "stores.json"))
	unsetEnv(t, "AGENT_TMUX_TMPDIR")
	for _, tc := range []struct {
		name  string
		env   *string
		args  []string
		path  string
		want  string
		calls int
	}{
		{name: "captured", want: "/scratch/captured", calls: 1},
		{name: "captured with explicit path", args: []string{"--path", "/explicit"}, path: "/explicit", want: "/scratch/captured", calls: 1},
		{name: "flag", args: []string{"--tmux-tmpdir", "/flag/dir"}, want: "/flag/dir", calls: 1},
		{name: "flag and path skip capture", args: []string{"--tmux-tmpdir", "/flag/dir", "--path", "/explicit"}, path: "/explicit", want: "/flag/dir"},
		{name: "env", env: stringPtr("/env/dir"), want: "/env/dir", calls: 1},
		{name: "flag beats env", env: stringPtr("/env/dir"), args: []string{"--tmux-tmpdir=/flag/dir"}, want: "/flag/dir", calls: 1},
		{name: "explicit empty omits", args: []string{"--tmux-tmpdir="}, want: "", calls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.env != nil {
				t.Setenv("AGENT_TMUX_TMPDIR", *tc.env)
			} else {
				unsetEnv(t, "AGENT_TMUX_TMPDIR")
			}
			calls := 0
			previous := loginEnvCapture
			loginEnvCapture = func() loginEnv {
				calls++
				return loginEnv{Path: "/captured", TmuxTmpdir: "/scratch/captured"}
			}
			t.Cleanup(func() { loginEnvCapture = previous })
			for _, osName := range []string{"Linux", "Darwin"} {
				calls = 0
				args := append([]string{"daemon", "install", "--print", "--os", osName, "--ssh-auth-sock=", "--log", filepath.Join(home, "shuttle.log")}, tc.args...)
				out, stderr, err := executeCLI(t, t.TempDir(), args...)
				if err != nil {
					t.Fatalf("%s: daemon install --print: %v\n%s", osName, err, stderr)
				}
				if calls != tc.calls {
					t.Errorf("%s: login shell captured %d times; want %d", osName, calls, tc.calls)
				}
				wantPath := tc.path
				if wantPath == "" {
					wantPath = "/captured"
				}
				tmuxLine, pathLine := `Environment="TMUX_TMPDIR=`+tc.want+`"`, `Environment="PATH=`+wantPath
				if osName == "Darwin" {
					tmuxLine, pathLine = "<key>TMUX_TMPDIR</key>\n<string>"+tc.want+"</string>", "<key>Path</key><string>"+wantPath
				}
				if !strings.Contains(out, pathLine) {
					t.Errorf("%s: PATH is not %q:\n%s", osName, wantPath, out)
				}
				if tc.want == "" {
					if strings.Contains(out, "TMUX_TMPDIR") {
						t.Errorf("%s: an empty TMUX_TMPDIR was rendered:\n%s", osName, out)
					}
				} else if !strings.Contains(out, tmuxLine) {
					t.Errorf("%s: TMUX_TMPDIR is not %q:\n%s", osName, tc.want, out)
				}
			}
		})
	}
}

func stubLoginEnv(t *testing.T, env loginEnv) {
	t.Helper()
	previous := loginEnvCapture
	loginEnvCapture = func() loginEnv { return env }
	t.Cleanup(func() { loginEnvCapture = previous })
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	previous, wasSet := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if wasSet {
			_ = os.Setenv(key, previous)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func stringPtr(value string) *string { return &value }

func TestSupervisorPathContainsShuttleAndFeltDirectories(t *testing.T) {
	binDir := t.TempDir()
	for _, name := range []string{"felt", "shuttle"} {
		if err := os.WriteFile(filepath.Join(binDir, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := pathForDaemonSupervisor(binDir)
	entries := cleanPathEntries(got)
	if !containsPathEntry(entries, binDir) {
		t.Fatalf("PATH %q lost the directory containing both CLIs", got)
	}
	executable, err := executablePath()
	if err != nil {
		t.Fatal(err)
	}
	if !containsPathEntry(entries, filepath.Dir(executable)) {
		t.Fatalf("PATH %q omitted the running shuttle directory", got)
	}
}

func containsPathEntry(entries []string, value string) bool {
	for _, entry := range entries {
		if entry == value {
			return true
		}
	}
	return false
}

func supervisorTemplateFixtures() map[string]string {
	return map[string]string{
		"io.shuttle.daemon.plist.template": `<?xml version="1.0"?><plist><dict>
<key>Label</key><string>__LABEL__</string>
<key>Program</key><string>__SHUTTLE_BIN__</string>
<key>Release</key><string>__SHUTTLE_RELEASE__</string>
<key>WorkingDirectory</key>
<string>__WORKING_DIRECTORY__</string>
<key>Log</key><string>__LOG__</string>
<key>Stores</key><string>__SHUTTLE_STORES__</string>
<key>StoresFile</key><string>__SHUTTLE_STORES_FILE__</string>
<key>Path</key><string>__PATH__</string>
<key>SHUTTLE_PORT</key>
<string>__PORT__</string>
<key>SSH_AUTH_SOCK</key>
<string>__SSH_AUTH_SOCK__</string>
<key>TMUX_TMPDIR</key>
<string>__TMUX_TMPDIR__</string>
<key>EnvironmentVariables</key><dict>
<key>SHUTTLE_CODEX_SOCKET</key>
<string>__CODEX_SOCKET__</string>
<key>CODEX_HOME</key>
<string>__CODEX_HOME__</string>
</dict>
<key>SoftResourceLimits</key>
<dict><key>NumberOfFiles</key><integer>8192</integer></dict>
</dict></plist>
`,
		"io.shuttle.daemon.service.template": `[Service]
LimitNOFILE=8192
WorkingDirectory=__WORKING_DIRECTORY__
ExecStart="__SHUTTLE_BIN__" daemon start --force
ExecStartPre=/bin/sh -c 'if [ -f "__LOG__" ]; then :; fi'
Environment="SHUTTLE_RELEASE=__SHUTTLE_RELEASE__"
Environment="PATH=__PATH__"
Environment="SHUTTLE_PORT=__PORT__"
Environment="SHUTTLE_STORES=__SHUTTLE_STORES__"
Environment="SHUTTLE_STORES_FILE=__SHUTTLE_STORES_FILE__"
Environment="SSH_AUTH_SOCK=__SSH_AUTH_SOCK__"
Environment="TMUX_TMPDIR=__TMUX_TMPDIR__"
Environment="SHUTTLE_CODEX_SOCKET=__CODEX_SOCKET__"
Environment="CODEX_HOME=__CODEX_HOME__"
Environment="SHUTTLE_LOG=__LOG__"
StandardOutput=append:__LOG__
StandardError=append:__LOG__
`,
	}
}

func TestSupervisorCodexEndpointPreservedAcrossReinstall(t *testing.T) {
	for _, osName := range []string{"Darwin", "Linux"} {
		t.Run(osName, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			unsetEnv(t, "SHUTTLE_CODEX_SOCKET")
			unsetEnv(t, "CODEX_HOME")
			name := "io.shuttle.daemon.plist.template"
			path := filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
			if osName == "Linux" {
				name = "io.shuttle.daemon.service.template"
				path = filepath.Join(home, ".config", "systemd", "user", systemdUnitName(defaultDaemonLabel))
			}
			source, err := os.ReadFile(filepath.Join("..", "..", "daemon", "share", name))
			if err != nil {
				t.Fatal(err)
			}
			original := supervisorOptions{OS: osName, Label: defaultDaemonLabel, ShuttleBin: "/bin/shuttle", Path: "/bin", Log: "/tmp/shuttle.log",
				CodexSocket: `/tmp/desktop "quoted" & 50%/control.sock`, CodexHome: "/tmp/codex home"}
			rendered, err := renderSupervisorTemplate(osName, string(source), original, daemonRelease{Dir: "/opt/shuttle"})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(rendered), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, tc := range []struct {
				name, env, flag, want string
				explicit              bool
			}{
				{name: "preserve", want: original.CodexSocket},
				{name: "environment", env: "/tmp/env.sock", want: "/tmp/env.sock"},
				{name: "flag beats environment", env: "/tmp/env.sock", flag: "/tmp/flag.sock", explicit: true, want: "/tmp/flag.sock"},
				{name: "explicit reset", env: "/tmp/env.sock", explicit: true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					if tc.env != "" {
						t.Setenv("SHUTTLE_CODEX_SOCKET", tc.env)
					}
					options := supervisorOptions{OS: osName, Label: defaultDaemonLabel, CodexSocket: tc.flag, CodexSocketSet: tc.explicit}
					if err := resolveSupervisorCodex(&options); err != nil {
						t.Fatal(err)
					}
					if options.CodexSocket != tc.want || options.CodexHome != original.CodexHome {
						t.Fatalf("resolved %+v; want socket %q and home %q", options, tc.want, original.CodexHome)
					}
				})
			}
			t.Setenv("CODEX_HOME", "/tmp/env home")
			options := supervisorOptions{OS: osName, Label: defaultDaemonLabel}
			if err := resolveSupervisorCodex(&options); err != nil || options.CodexHome != "/tmp/env home" {
				t.Fatalf("home override: %+v, %v", options, err)
			}
		})
	}
}

func TestDaemonInstallCodexSocketFlagAndValidation(t *testing.T) {
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, source := range supervisorTemplateFixtures() {
		if err := os.WriteFile(filepath.Join(share, name), []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHUTTLE_RELEASE", release.Dir)
	t.Setenv("SHUTTLE_CODEX_SOCKET", "/tmp/env.sock")
	unsetEnv(t, "CODEX_HOME")
	stubLoginEnv(t, loginEnv{Path: "/bin"})
	for _, osName := range []string{"Darwin", "Linux"} {
		for _, endpoint := range []string{"/tmp/not-created-yet.sock", ""} {
			out, stderr, err := executeCLI(t, t.TempDir(), "daemon", "install", "--print", "--os", osName, "--codex-socket="+endpoint)
			if err != nil {
				t.Fatalf("%s: %v %s", osName, err, stderr)
			}
			if endpoint == "" && strings.Contains(out, "SHUTTLE_CODEX_SOCKET") {
				t.Fatalf("reset retained endpoint: %s", out)
			}
			if endpoint != "" && !strings.Contains(out, endpoint) {
				t.Fatalf("missing endpoint: %s", out)
			}
		}
	}
	for _, path := range []string{"relative.sock", "unix:///tmp/control.sock", "/tmp/../control.sock", "/tmp/control\nsock", "/tmp/control\x00sock"} {
		_, _, err := executeCLI(t, t.TempDir(), "daemon", "install", "--print", "--codex-socket="+path)
		if err == nil || !strings.Contains(err.Error(), "--codex-socket") {
			t.Errorf("invalid endpoint %q: %v", path, err)
		}
	}
}

func TestSupervisorCodexMalformedExistingConfiguration(t *testing.T) {
	for _, tc := range []struct{ osName, source string }{{"Darwin", "<plist><dict>"}, {"Linux", `Environment="SHUTTLE_CODEX_SOCKET=/tmp/unclosed`}} {
		if _, err := supervisorCodexEnvironment(tc.osName, tc.source); err == nil {
			t.Errorf("%s accepted malformed settings", tc.osName)
		}
	}
}

func TestSupervisorCodexOlderTemplateCompatibility(t *testing.T) {
	source := supervisorTemplateFixtures()["io.shuttle.daemon.service.template"]
	source = removeEnvironmentLine(source, "SHUTTLE_CODEX_SOCKET", "__CODEX_SOCKET__")
	source = removeEnvironmentLine(source, "CODEX_HOME", "__CODEX_HOME__")
	options := supervisorOptions{Label: defaultDaemonLabel, ShuttleBin: "/bin/shuttle", Path: "/bin", Log: "/tmp/shuttle.log"}
	if _, err := renderSupervisorTemplate("Linux", source, options, daemonRelease{Dir: "/opt/shuttle"}); err != nil {
		t.Fatalf("old template without endpoint: %v", err)
	}
	options.CodexSocket = "/tmp/control.sock"
	if _, err := renderSupervisorTemplate("Linux", source, options, daemonRelease{Dir: "/opt/shuttle"}); err == nil {
		t.Fatal("old template silently discarded the endpoint")
	}
}
