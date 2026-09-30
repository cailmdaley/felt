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
				if !strings.Contains(rendered, "&amp; &lt;unit&gt;") || !strings.Contains(rendered, "&lt;notes&gt;") {
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
		SSHSocket: "/tmp/ssh-agent.sock",
	}
	for _, tc := range []struct {
		osName string
		want   string
	}{
		{"Darwin", `<string>daemon</string>`},
		{"Linux", `ExecStart="/opt/shuttle" daemon start --force`},
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
			if strings.Contains(rendered, "<key>SHUTTLE_PORT</key>") || strings.Contains(rendered, "<key>SSH_AUTH_SOCK</key>") {
				t.Fatalf("empty optional plist entries remain:\n%s", rendered)
			}
		} else if strings.Contains(rendered, `Environment="SHUTTLE_PORT=`) || strings.Contains(rendered, `Environment="SSH_AUTH_SOCK=`) {
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

func TestCaptureLoginPathReadsFencedShellOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell PATH capture requires a POSIX shell")
	}
	shell := filepath.Join(t.TempDir(), "login-shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nprintf 'banner\\n__SHUTTLE_PATH__/one:/bin:/one\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := captureLoginPathWith(shell, "-lc"); got != "/one:/bin:/one" {
		t.Fatalf("captured PATH = %q", got)
	}
}

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
</dict></plist>
`,
		"io.shuttle.daemon.service.template": `[Service]
WorkingDirectory=__WORKING_DIRECTORY__
ExecStart="__SHUTTLE_BIN__" daemon start --force
ExecStartPre=/bin/sh -c 'if [ -f "__LOG__" ]; then :; fi'
Environment="SHUTTLE_RELEASE=__SHUTTLE_RELEASE__"
Environment="PATH=__PATH__"
Environment="SHUTTLE_PORT=__PORT__"
Environment="SHUTTLE_STORES=__SHUTTLE_STORES__"
Environment="SHUTTLE_STORES_FILE=__SHUTTLE_STORES_FILE__"
Environment="SSH_AUTH_SOCK=__SSH_AUTH_SOCK__"
Environment="SHUTTLE_LOG=__LOG__"
StandardOutput=append:__LOG__
StandardError=append:__LOG__
`,
	}
}
