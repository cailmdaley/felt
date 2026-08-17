package cmd

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"text/template"
)

// The tunnels install two supervisors' jobs from one fleet file: launchd
// LaunchAgents on macOS, systemd --user units on Linux. These tests exercise
// both arms on either host — hostGOOS is a variable for exactly that — so the
// Linux rendering and file placement are covered from a Mac and vice versa.
//
// Nothing here may touch the real ~/Library/LaunchAgents, ~/.config/systemd, or
// the developer's own launchd/systemd session: HOME is redirected per test and
// launchctl/systemctl are stubs on PATH that only record their arguments.

// useHostGOOS runs a test as if this machine were `goos`.
func useHostGOOS(t *testing.T, goos string) {
	t.Helper()
	prev := hostGOOS
	t.Cleanup(func() { hostGOOS = prev })
	hostGOOS = goos
}

// installIntoTemp redirects HOME and the install flags at scratch dirs, and
// restores the package vars afterwards. An empty jobDir leaves the supervisor
// to pick its own default location under the redirected HOME — which is the
// placement worth asserting.
func installIntoTemp(t *testing.T, jobDir string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	prevJob, prevLog, prevSSH, prevWriteOnly :=
		tunnelsJobDir, tunnelsLogDir, tunnelsAutoSSH, tunnelsWriteOnly
	t.Cleanup(func() {
		tunnelsJobDir, tunnelsLogDir, tunnelsAutoSSH, tunnelsWriteOnly =
			prevJob, prevLog, prevSSH, prevWriteOnly
	})
	tunnelsJobDir = jobDir
	tunnelsLogDir = filepath.Join(home, "logs")
	tunnelsAutoSSH = "/usr/bin/autossh"
	tunnelsWriteOnly = false
	return home
}

// stubSupervisorsOnPath puts recording stubs for launchctl and systemctl at the
// front of PATH, so an install test can never reach the real login session.
// Every call lands in one log, in order. probeExit is what the stub answers
// `systemctl --user show-environment` with: 0 for a host with a systemd user
// session, non-zero for one without.
func stubSupervisorsOnPath(t *testing.T, probeExit int) func() string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	for _, bin := range []string{"launchctl", "systemctl"} {
		script := "#!/bin/sh\n" +
			"echo \"" + bin + " $*\" >> " + log + "\n" +
			"for arg in \"$@\"; do\n" +
			"  if [ \"$arg\" = show-environment ]; then exit " + strconv.Itoa(probeExit) + "; fi\n" +
			"done\n" +
			"exit 0\n"
		if err := os.WriteFile(filepath.Join(dir, bin), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() string {
		b, err := os.ReadFile(log)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// TestInstallTunnels_Launchd — the macOS arm: a plist named for the launchd
// label, in ~/Library/LaunchAgents, then bootout → bootstrap → kickstart. The
// bootout is what makes a reinstall pick up the plist just written.
func TestInstallTunnels_Launchd(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"launchd"}}]`)
	useHostGOOS(t, "darwin")
	calls := stubSupervisorsOnPath(t, 0)
	home := installIntoTemp(t, "")

	if err := installTunnels([]string{"alpha"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	plist := filepath.Join(home, "Library", "LaunchAgents", "io.shuttle.shuttle-tunnel-alpha.plist")
	if body := readFile(t, plist); !strings.Contains(body, "<key>Label</key>") {
		t.Errorf("%s is not a plist:\n%s", plist, body)
	}
	got := calls()
	for _, want := range []string{"bootout", "bootstrap", "kickstart"} {
		if !strings.Contains(got, "launchctl "+want) {
			t.Errorf("expected launchctl %s, got calls:\n%s", want, got)
		}
	}
	if strings.Contains(got, "systemctl") {
		t.Errorf("the darwin arm must not shell systemctl:\n%s", got)
	}
}

// TestInstallTunnels_Systemd — the Linux arm: a user unit named
// shuttle-tunnel-<name>.service in ~/.config/systemd/user, then the probe,
// daemon-reload, enable, restart. `restart` rather than `enable --now` is what
// makes a reinstall over a live tunnel serve the unit just written.
func TestInstallTunnels_Systemd(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"ssh":"alpha-login","tunnel":{"manager":"systemd"}}]`)
	useHostGOOS(t, "linux")
	calls := stubSupervisorsOnPath(t, 0)
	home := installIntoTemp(t, "")

	if err := installTunnels([]string{"alpha"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	unit := filepath.Join(home, ".config", "systemd", "user", "shuttle-tunnel-alpha.service")
	body := readFile(t, unit)
	for _, want := range []string{
		"[Service]",
		"ExecStart=/usr/bin/autossh",
		"-L 4001:localhost:4000 alpha-login",
		"WantedBy=default.target",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("unit is missing %q:\n%s", want, body)
		}
	}
	// The autossh log directory has to exist before systemd opens append:.
	if _, err := os.Stat(filepath.Join(home, "logs")); err != nil {
		t.Errorf("log dir was not created: %v", err)
	}

	got := calls()
	for _, want := range []string{
		"systemctl --user show-environment",
		"systemctl --user daemon-reload",
		"systemctl --user enable shuttle-tunnel-alpha.service",
		"systemctl --user restart shuttle-tunnel-alpha.service",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q, got calls:\n%s", want, got)
		}
	}
	if strings.Contains(got, "launchctl") {
		t.Errorf("the linux arm must not shell launchctl:\n%s", got)
	}
	if strings.Index(got, "show-environment") > strings.Index(got, "daemon-reload") {
		t.Errorf("the probe must come before any mutation:\n%s", got)
	}
}

// TestInstallTunnels_SystemdWithoutUserSession — the honest failure. A Linux
// host with no user manager (an HPC login node, a bare container) gets a
// refusal that names the alternative, and no half-written fleet: the probe runs
// before the job directory is created.
func TestInstallTunnels_SystemdWithoutUserSession(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"systemd"}}]`)
	useHostGOOS(t, "linux")
	calls := stubSupervisorsOnPath(t, 1)
	home := installIntoTemp(t, "")

	err := installTunnels([]string{"alpha"})
	if err == nil {
		t.Fatal("install must refuse without a systemd user session")
	}
	for _, want := range []string{"no systemd user session", "--write-only"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal should mention %q, got:\n%s", want, err)
		}
	}
	if _, statErr := os.Stat(filepath.Join(home, ".config", "systemd")); statErr == nil {
		t.Error("the refusal must not create the unit directory")
	}
	if got := calls(); strings.Contains(got, "daemon-reload") || strings.Contains(got, "enable") {
		t.Errorf("nothing may be enabled after a failed probe:\n%s", got)
	}
}

// TestInstallTunnels_WriteOnly — --write-only renders the job and stops. It is
// the escape hatch the systemd refusal points at, so it must work on a host
// with no user session at all (probe exit 1) without shelling anything.
func TestInstallTunnels_WriteOnly(t *testing.T) {
	cases := []struct {
		goos, manager, jobPath string
	}{
		{"darwin", "launchd", "Library/LaunchAgents/io.shuttle.shuttle-tunnel-alpha.plist"},
		{"linux", "systemd", ".config/systemd/user/shuttle-tunnel-alpha.service"},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"`+tc.manager+`"}}]`)
			useHostGOOS(t, tc.goos)
			calls := stubSupervisorsOnPath(t, 1)
			home := installIntoTemp(t, "")
			tunnelsWriteOnly = true

			if err := installTunnels([]string{"alpha"}); err != nil {
				t.Fatalf("install --write-only: %v", err)
			}
			if _, err := os.Stat(filepath.Join(home, tc.jobPath)); err != nil {
				t.Errorf("job not written to %s: %v", tc.jobPath, err)
			}
			if got := calls(); got != "" {
				t.Errorf("--write-only must shell no supervisor, got:\n%s", got)
			}
		})
	}
}

// TestInstallTunnels_UnsupportedPlatform — neither supervisor exists, so say
// which two do rather than writing files nothing can run.
func TestInstallTunnels_UnsupportedPlatform(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"launchd"}}]`)
	useHostGOOS(t, "windows")
	stubSupervisorsOnPath(t, 0)
	home := installIntoTemp(t, "")

	err := installTunnels([]string{"alpha"})
	if err == nil {
		t.Fatal("install must refuse on a platform with no supervisor")
	}
	if !strings.Contains(err.Error(), "launchd") || !strings.Contains(err.Error(), "systemd") {
		t.Errorf("refusal should name both supervisors, got %q", err)
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Errorf("the refusal must write nothing, found %v", entries)
	}
}

// The tunnels command had no tests while the fleet lived in a hardcoded map.
// Now that every name, port, and label comes from the fleet file, these lock the
// two things a wrong job breaks silently: the exact arguments the fleet runs,
// and the launchd label the Elixir recovery cascade kickstarts.

func renderForTest(t *testing.T, tmplText string, spec tunnelSpec) string {
	t.Helper()
	tmpl, err := template.New("shuttle-tunnel").Parse(tmplText)
	if err != nil {
		t.Fatalf("parse template: %v", err)
	}
	out, err := renderTunnelJob(tmpl, tunnelTemplateData{
		Label:       spec.Label,
		SSHHost:     spec.SSHHost,
		LocalPort:   spec.LocalPort,
		RemotePort:  spec.RemotePort,
		Multiplex:   spec.Multiplex,
		AutoSSHPath: "/usr/bin/autossh",
		LogPath:     "/tmp/tunnel.log",
		Home:        "/home/tester",
		Path:        "/usr/local/bin:/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return string(out)
}

// TestResolveTunnelSpecs_FromFleetFile — the fleet file is the only source, and
// every field a job needs comes from it.
func TestResolveTunnelSpecs_FromFleetFile(t *testing.T) {
	writeRemotes(t, `{"version":1,"launchd_label_prefix":"com.example","remotes":[
	  {"name":"beta","port":4004,"ssh":"beta-login","remote_port":4200,
	   "tunnel":{"manager":"launchd","multiplex":true}},
	  {"name":"alpha","port":4001,"tunnel":{"manager":"systemd"}}
	]}`)

	specs, err := resolveTunnelSpecs(nil)
	if err != nil {
		t.Fatalf("resolveTunnelSpecs: %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("got %d specs, want 2", len(specs))
	}
	// Sorted by name, so the output order is stable regardless of file order.
	if specs[0].Name != "alpha" || specs[1].Name != "beta" {
		t.Fatalf("specs not name-sorted: %+v", specs)
	}
	alpha, beta := specs[0], specs[1]
	if alpha.SSHHost != "alpha" {
		t.Errorf("alpha.SSHHost = %q, want the name as fallback", alpha.SSHHost)
	}
	if alpha.RemotePort != 4000 {
		t.Errorf("alpha.RemotePort = %d, want the 4000 default", alpha.RemotePort)
	}
	if alpha.Label != "com.example.shuttle-tunnel-alpha" {
		t.Errorf("alpha.Label = %q", alpha.Label)
	}
	if alpha.UnitName != "shuttle-tunnel-alpha.service" {
		t.Errorf("alpha.UnitName = %q", alpha.UnitName)
	}
	if beta.SSHHost != "beta-login" || beta.RemotePort != 4200 || !beta.Multiplex {
		t.Errorf("beta = %+v", beta)
	}
}

// TestResolveTunnelSpecs_ManagedByEitherSupervisor — a fleet file travels
// between hubs, so both supervisor names select. Which one renders is the
// host's business.
func TestResolveTunnelSpecs_ManagedByEitherSupervisor(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"launchd"}},
	  {"name":"beta","port":4002,"tunnel":{"manager":"systemd"}},
	  {"name":"direct","port":4003,"tunnel":{"manager":"none"}}]`)
	specs, err := resolveTunnelSpecs(nil)
	if err != nil {
		t.Fatalf("resolveTunnelSpecs: %v", err)
	}
	if len(specs) != 2 || specs[0].Name != "alpha" || specs[1].Name != "beta" {
		t.Fatalf("want the two managed remotes, got %+v", specs)
	}
}

// TestResolveTunnelSpecs_DefaultManagerFollowsTheHost — a remote with no tunnel
// block is managed by whatever supervisor the hub has, and by nothing where
// there is neither.
func TestResolveTunnelSpecs_DefaultManagerFollowsTheHost(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos+" manages it", func(t *testing.T) {
			writeRemotes(t, `[{"name":"alpha","port":4001}]`)
			useHostGOOS(t, goos)
			specs, err := resolveTunnelSpecs(nil)
			if err != nil {
				t.Fatalf("resolveTunnelSpecs: %v", err)
			}
			if len(specs) != 1 {
				t.Fatalf("got %d specs, want 1", len(specs))
			}
		})
	}

	t.Run("elsewhere the remote is assumed reachable", func(t *testing.T) {
		writeRemotes(t, `[{"name":"alpha","port":4001}]`)
		useHostGOOS(t, "windows")
		if _, err := resolveTunnelSpecs(nil); err == nil {
			t.Fatal("want no supervisor-managed tunnels")
		}
	})
}

// TestResolveTunnelSpecs_DefaultLabelPrefix — a fleet file with no prefix gets
// io.shuttle, matching the daemon's own launchd identifier. The systemd unit
// carries no prefix at all, matching shuttle-daemon.service.
func TestResolveTunnelSpecs_DefaultLabelPrefix(t *testing.T) {
	writeRemotes(t, `[{"name":"x","port":4001,"tunnel":{"manager":"launchd"}}]`)
	specs, err := resolveTunnelSpecs([]string{"x"})
	if err != nil {
		t.Fatalf("resolveTunnelSpecs: %v", err)
	}
	if specs[0].Label != "io.shuttle.shuttle-tunnel-x" {
		t.Fatalf("label = %q, want io.shuttle.shuttle-tunnel-x", specs[0].Label)
	}
	if specs[0].UnitName != "shuttle-tunnel-x.service" {
		t.Fatalf("unit = %q, want shuttle-tunnel-x.service", specs[0].UnitName)
	}
}

// TestResolveTunnelSpecs_LabelOverride — an explicit tunnel.label names the job
// on both supervisors; systemd needs the suffix it may not have been given.
func TestResolveTunnelSpecs_LabelOverride(t *testing.T) {
	writeRemotes(t, `[{"name":"x","port":4001,"tunnel":{"manager":"launchd","label":"custom.tunnel"}},
	  {"name":"y","port":4002,"tunnel":{"manager":"systemd","label":"custom-y.service"}}]`)
	specs, err := resolveTunnelSpecs(nil)
	if err != nil {
		t.Fatalf("resolveTunnelSpecs: %v", err)
	}
	if specs[0].Label != "custom.tunnel" || specs[0].UnitName != "custom.tunnel.service" {
		t.Errorf("x = %+v", specs[0])
	}
	if specs[1].UnitName != "custom-y.service" {
		t.Errorf("y unit = %q, want the suffix left alone", specs[1].UnitName)
	}
}

// TestResolveTunnelSpecs_Errors — both failure messages must be actionable: the
// fleet is in one file, so the error can always say what IS configured.
func TestResolveTunnelSpecs_Errors(t *testing.T) {
	t.Run("unknown name lists the configured ones", func(t *testing.T) {
		writeRemotes(t, `[{"name":"alpha","port":4001},{"name":"beta","port":4002}]`)
		_, err := resolveTunnelSpecs([]string{"gamma"})
		if err == nil {
			t.Fatal("want an error for an unknown tunnel")
		}
		if !strings.Contains(err.Error(), "alpha, beta") {
			t.Fatalf("error should list configured names, got %q", err)
		}
	})

	t.Run("empty fleet points at the fix", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "remotes.json")
		t.Setenv("FELT_REMOTES_FILE", path)
		_, err := resolveTunnelSpecs(nil)
		if err == nil {
			t.Fatal("want an error with no remotes configured")
		}
		if !strings.Contains(err.Error(), "felt shuttle remotes add") || !strings.Contains(err.Error(), path) {
			t.Fatalf("error should name the fix and the file, got %q", err)
		}
	})

	t.Run("manager none is not a supervised tunnel", func(t *testing.T) {
		writeRemotes(t, `[{"name":"direct","port":4001,"tunnel":{"manager":"none"}}]`)
		_, err := resolveTunnelSpecs(nil)
		if err == nil || !strings.Contains(err.Error(), "supervisor-managed") {
			t.Fatalf("want a supervisor-managed error, got %v", err)
		}
	})
}

// The golden tests pin the exact argument vector the fleet's tunnels run under,
// on both supervisors. A template edit that changes behavior has to change
// these files too.

func TestRenderTunnelPlist_Autossh(t *testing.T) {
	got := renderForTest(t, tunnelPlistTemplate, tunnelSpec{
		Name:       "alpha",
		SSHHost:    "alpha-login",
		Label:      "io.shuttle.shuttle-tunnel-alpha",
		LocalPort:  4001,
		RemotePort: 4000,
	})
	assertGolden(t, "tunnel-autossh.plist", got)
}

func TestRenderTunnelPlist_Multiplex(t *testing.T) {
	got := renderForTest(t, tunnelPlistTemplate, tunnelSpec{
		Name:       "beta",
		SSHHost:    "beta-login",
		Label:      "io.shuttle.shuttle-tunnel-beta",
		LocalPort:  4004,
		RemotePort: 4200,
		Multiplex:  true,
	})
	assertGolden(t, "tunnel-multiplex.plist", got)
}

func TestRenderTunnelUnit_Autossh(t *testing.T) {
	got := renderForTest(t, tunnelServiceTemplate, tunnelSpec{
		Name:       "alpha",
		SSHHost:    "alpha-login",
		UnitName:   "shuttle-tunnel-alpha.service",
		LocalPort:  4001,
		RemotePort: 4000,
	})
	assertGolden(t, "tunnel-autossh.service", got)
}

func TestRenderTunnelUnit_Multiplex(t *testing.T) {
	got := renderForTest(t, tunnelServiceTemplate, tunnelSpec{
		Name:       "beta",
		SSHHost:    "beta-login",
		UnitName:   "shuttle-tunnel-beta.service",
		LocalPort:  4004,
		RemotePort: 4200,
		Multiplex:  true,
	})
	assertGolden(t, "tunnel-multiplex.service", got)
}

// TestRenderTunnelUnit_EscapesTheControlPathSpecifier — systemd expands
// %-specifiers in ExecStart before /bin/sh sees the line, so ssh's own `%C`
// ControlPath hash has to reach the unit doubled. A bare `%C` would silently
// point the multiplex tunnel at the unit's cache directory.
func TestRenderTunnelUnit_EscapesTheControlPathSpecifier(t *testing.T) {
	got := renderForTest(t, tunnelServiceTemplate, tunnelSpec{
		Name: "beta", SSHHost: "beta-login", LocalPort: 4004, RemotePort: 4200, Multiplex: true,
	})
	execStart := ""
	for _, line := range strings.Split(got, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			execStart = line
		}
	}
	if execStart == "" {
		t.Fatalf("no ExecStart in:\n%s", got)
	}
	if !strings.Contains(execStart, "/.ssh/ctl/%%C") {
		t.Errorf("ControlPath specifier must be doubled, got:\n%s", execStart)
	}
	// systemd expands $VAR in ExecStart too; a bare one would never reach sh.
	if strings.Contains(execStart, "$") {
		t.Errorf("ExecStart must carry no unescaped $, got:\n%s", execStart)
	}
}

// TestRenderTunnelJob_RemotePortReachesForward — the far-side daemon port used
// to be hardcoded in the template. Prove it now follows the file, on every arm
// of both templates.
func TestRenderTunnelJob_RemotePortReachesForward(t *testing.T) {
	for _, tmpl := range []struct {
		name, text string
	}{{"plist", tunnelPlistTemplate}, {"unit", tunnelServiceTemplate}} {
		for _, multiplex := range []bool{false, true} {
			got := renderForTest(t, tmpl.text, tunnelSpec{
				Name: "x", SSHHost: "x", Label: "l", UnitName: "u.service",
				LocalPort: 4001, RemotePort: 4200, Multiplex: multiplex,
			})
			if !strings.Contains(got, "4001:localhost:4200") {
				t.Errorf("%s multiplex=%v: forward should be 4001:localhost:4200\n%s", tmpl.name, multiplex, got)
			}
			if strings.Contains(got, "localhost:4000") {
				t.Errorf("%s multiplex=%v: stale hardcoded :4000 in the forward", tmpl.name, multiplex)
			}
		}
	}
}

// assertGolden compares against testdata, regenerating with -update.
func assertGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (regenerate with UPDATE_GOLDEN=1)", path, err)
	}
	if got != string(want) {
		t.Errorf("job differs from %s\n--- got ---\n%s\n--- want ---\n%s", path, got, want)
	}
}
