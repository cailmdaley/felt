package cmd

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"text/template"
)

// TestInstallTunnels_MacOSOnly — the tunnels are launchd autossh jobs, so
// `install` must refuse off macOS rather than writing plists into a ~/Library
// it just created. Everything else about Shuttle runs on Linux; this is the one
// platform-bound verb, and the refusal is what keeps that claim honest.
func TestInstallTunnels_MacOSOnly(t *testing.T) {
	writeRemotes(t, `[{"name":"alpha","port":4001,"tunnel":{"manager":"launchd"}}]`)

	// Keep the macOS arm from touching the real ~/Library/LaunchAgents or
	// calling launchctl: write-only, into a temp dir, with a stub autossh path.
	dir := t.TempDir()
	defer func(pd, ld, as string, wo bool) {
		tunnelsPlistDir, tunnelsLogDir, tunnelsAutoSSH, tunnelsWriteOnly = pd, ld, as, wo
	}(tunnelsPlistDir, tunnelsLogDir, tunnelsAutoSSH, tunnelsWriteOnly)
	tunnelsPlistDir = filepath.Join(dir, "LaunchAgents")
	tunnelsLogDir = filepath.Join(dir, "logs")
	tunnelsAutoSSH = "/usr/bin/autossh"
	tunnelsWriteOnly = true

	err := installTunnels([]string{"alpha"})

	if runtime.GOOS == "darwin" {
		if err != nil {
			t.Fatalf("installTunnels on darwin should not refuse: %v", err)
		}
		return
	}
	if err == nil {
		t.Fatalf("installTunnels on %s should refuse", runtime.GOOS)
	}
	if !strings.Contains(err.Error(), "macOS-only") {
		t.Fatalf("refusal should name the platform limit, got %q", err)
	}
	if _, statErr := os.Stat(tunnelsPlistDir); statErr == nil {
		t.Errorf("refusal must not create the plist dir %s", tunnelsPlistDir)
	}
}

// The tunnels command had no tests while the fleet lived in a hardcoded map.
// Now that every name, port, and label comes from the fleet file, these lock the
// two things a wrong plist breaks silently: the exact ProgramArguments the fleet
// runs, and the launchd label the Elixir recovery cascade kickstarts.

func renderForTest(t *testing.T, spec tunnelSpec) string {
	t.Helper()
	tmpl, err := template.New("shuttle-tunnel").Parse(tunnelPlistTemplate)
	if err != nil {
		t.Fatalf("parse template: %v", err)
	}
	out, err := renderTunnelPlist(tmpl, tunnelTemplateData{
		Label:       spec.Label,
		SSHHost:     spec.SSHHost,
		LocalPort:   spec.LocalPort,
		RemotePort:  spec.RemotePort,
		Multiplex:   spec.Multiplex,
		AutoSSHPath: "/usr/bin/autossh",
		LogPath:     "/tmp/tunnel.log",
		Home:        "/home/tester",
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return string(out)
}

// TestResolveTunnelSpecs_FromFleetFile — the fleet file is the only source, and
// every field the plist needs comes from it.
func TestResolveTunnelSpecs_FromFleetFile(t *testing.T) {
	writeRemotes(t, `{"version":1,"launchd_label_prefix":"com.example","remotes":[
	  {"name":"beta","port":4004,"ssh":"beta-login","remote_port":4200,
	   "tunnel":{"manager":"launchd","multiplex":true}},
	  {"name":"alpha","port":4001,"tunnel":{"manager":"launchd"}}
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
	if beta.SSHHost != "beta-login" || beta.RemotePort != 4200 || !beta.Multiplex {
		t.Errorf("beta = %+v", beta)
	}
}

// TestResolveTunnelSpecs_DefaultLabelPrefix — a fleet file with no prefix gets
// io.shuttle, matching the daemon's own launchd identifier.
func TestResolveTunnelSpecs_DefaultLabelPrefix(t *testing.T) {
	writeRemotes(t, `[{"name":"x","port":4001,"tunnel":{"manager":"launchd"}}]`)
	specs, err := resolveTunnelSpecs([]string{"x"})
	if err != nil {
		t.Fatalf("resolveTunnelSpecs: %v", err)
	}
	if specs[0].Label != "io.shuttle.shuttle-tunnel-x" {
		t.Fatalf("label = %q, want io.shuttle.shuttle-tunnel-x", specs[0].Label)
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

	t.Run("manager none is not a launchd tunnel", func(t *testing.T) {
		writeRemotes(t, `[{"name":"direct","port":4001,"tunnel":{"manager":"none"}}]`)
		_, err := resolveTunnelSpecs(nil)
		if err == nil || !strings.Contains(err.Error(), "launchd-managed") {
			t.Fatalf("want a launchd-managed error, got %v", err)
		}
	})
}

// TestRenderTunnelPlist_Autossh is a golden test: it pins the exact argument
// vector the fleet's tunnels run under. A template edit that changes behavior
// has to change this file too.
func TestRenderTunnelPlist_Autossh(t *testing.T) {
	got := renderForTest(t, tunnelSpec{
		Name:       "alpha",
		SSHHost:    "alpha-login",
		Label:      "io.shuttle.shuttle-tunnel-alpha",
		LocalPort:  4001,
		RemotePort: 4000,
	})
	assertGolden(t, "tunnel-autossh.plist", got)
}

func TestRenderTunnelPlist_Multiplex(t *testing.T) {
	got := renderForTest(t, tunnelSpec{
		Name:       "beta",
		SSHHost:    "beta-login",
		Label:      "io.shuttle.shuttle-tunnel-beta",
		LocalPort:  4004,
		RemotePort: 4200,
		Multiplex:  true,
	})
	assertGolden(t, "tunnel-multiplex.plist", got)
}

// TestRenderTunnelPlist_RemotePortReachesForward — the far-side daemon port used
// to be hardcoded in the template on both arms. Prove it now follows the file.
func TestRenderTunnelPlist_RemotePortReachesForward(t *testing.T) {
	for _, multiplex := range []bool{false, true} {
		got := renderForTest(t, tunnelSpec{
			Name: "x", SSHHost: "x", Label: "l", LocalPort: 4001, RemotePort: 4200,
			Multiplex: multiplex,
		})
		if !strings.Contains(got, "4001:localhost:4200") {
			t.Errorf("multiplex=%v: forward should be 4001:localhost:4200\n%s", multiplex, got)
		}
		if strings.Contains(got, "localhost:4000") {
			t.Errorf("multiplex=%v: stale hardcoded :4000 in the forward", multiplex)
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
		t.Errorf("plist differs from %s\n--- got ---\n%s\n--- want ---\n%s", path, got, want)
	}
}
