package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDoctorRexReceipt(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, whoami, privacy, clients string
		want                           receiptStatus
		reachable, app, warning        bool
	}{
		{"granted", `{"rex_version":"test-version"}`, `{"services":[{"service":"full_disk_access","status":"granted"},{"service":"microphone","status":"not_determined"}]}`, `{"clients":[{"info":{"kind":"cli"}},{"info":{"kind":"app"}}]}`, receiptHealthy, true, true, false},
		{"denied is advisory", `{"rex_version":"test-version"}`, `{"services":[{"service":"full_disk_access","status":"denied"}]}`, `{"clients":[]}`, receiptHealthy, true, false, true},
		{"not determined is advisory", `{"rex_version":"test-version"}`, `{"services":[{"service":"full_disk_access","status":"not_determined"}]}`, `{"clients":[]}`, receiptHealthy, true, false, true},
		{"absent", "ABSENT", `{}`, `{}`, receiptMissing, false, false, false},
		{"transport error", "FAIL", `{}`, `{}`, receiptPartial, false, false, false},
		{"malformed whoami", `{}`, `{}`, `{}`, receiptPartial, false, false, false},
		{"malformed privacy", `{"rex_version":"test-version"}`, `{}`, `{"clients":[]}`, receiptPartial, true, false, true},
		{"empty privacy", `{"rex_version":"test-version"}`, `{"services":[]}`, `{"clients":[]}`, receiptPartial, true, false, true},
		{"malformed clients", `{"rex_version":"test-version"}`, `{"services":[{"service":"full_disk_access","status":"granted"}]}`, `{}`, receiptPartial, true, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(t.TempDir(), "rex")
			log := filepath.Join(t.TempDir(), "calls")
			// Reject any invocation that could autostart or select another endpoint.
			script := "#!/bin/sh\n[ \"$1 $2 $3 $4 $5\" = '--autostart=false --timeout 5s -S unix:///doctor-test.sock' ] || exit 9\nshift 5\nprintf '%s\\n' \"$*\" >> " + shellQuote(log) + "\ncase \"$*\" in\n" +
				"'whoami --json') reply=" + shellQuote(tc.whoami) + ";;\n" +
				"'api call server.apple.privacy_status -') [ \"$(/bin/cat)\" = '{}' ] || exit 8; reply=" + shellQuote(tc.privacy) + ";;\n" +
				"'client ls --json') reply=" + shellQuote(tc.clients) + ";;\n*) exit 7;;\nesac\n" +
				"[ \"$reply\" != ABSENT ] || { echo 'server is not running' >&2; exit 4; }\n[ \"$reply\" != FAIL ] || exit 1\nprintf '%s\\n' \"$reply\"\n"
			if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			env.Set("SHUTTLE_REX_BIN", bin)
			env.Set("SHUTTLE_REX_SERVER", "unix:///doctor-test.sock")
			a := newApp(env)
			rec := a.collectRexReceipt()
			if rec == nil || rec.Status != tc.want || rec.Reachable != tc.reachable || rec.AppClient != tc.app || (rec.Warning != "") != tc.warning {
				t.Fatalf("Rex receipt = %+v", rec)
			}
			if tc.reachable && rec.Version != "test-version" {
				t.Fatalf("missing version: %+v", rec)
			}
			if tc.want != receiptHealthy && rec.Repair == "" {
				t.Fatal("failed receipt needs a repair")
			}
			if tc.name == "granted" && rec.Privacy["microphone"] != "not_determined" {
				t.Fatalf("privacy services = %v", rec.Privacy)
			}
			var stdout bytes.Buffer
			env.Stdout = &stdout
			a.printRexReceipt(rec)
			if !strings.Contains(stdout.String(), "Rex:") || (strings.Contains(stdout.String(), "warning:")) != tc.warning {
				t.Fatalf("Rex text = %s", &stdout)
			}
			data, err := json.Marshal(DoctorReceipt{Rex: rec})
			if err != nil || !strings.Contains(string(data), `"rex":{"status":`) {
				t.Fatalf("Rex JSON: %s (%v)", data, err)
			}
			calls, err := os.ReadFile(log)
			if err != nil || !strings.HasPrefix(string(calls), "whoami --json\n") {
				t.Fatalf("read-only commands: %s (%v)", calls, err)
			}
		})
	}
}

func TestDoctorOmitsRexOnTmuxHosts(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_REX_BIN", "/must-not-run/rex")
	if got := newApp(env).collectRexReceipt(); got != nil {
		t.Fatalf("tmux host probed Rex: %+v", got)
	}
	data, err := json.Marshal(DoctorReceipt{})
	if err != nil || strings.Contains(string(data), `"rex"`) {
		t.Fatalf("tmux receipt includes Rex: %s (%v)", data, err)
	}
}

func TestDoctorRexMissingBinary(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_REX_BIN", "/does-not-exist/rex")
	rec := newApp(env).collectRexReceipt()
	if rec == nil || rec.Status != receiptMissing || rec.Repair == "" || rec.Reachable {
		t.Fatalf("missing Rex binary = %+v", rec)
	}
}

func TestShuttleBinaryReceiptReportsShadowingAndHookResolution(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := t.TempDir()
	home := filepath.Join(root, "home")
	currentPath := filepath.Join(home, ".local", "bin", "shuttle")
	currentTarget := filepath.Join(root, "current", "shuttle")
	writeShuttleVersion(t, currentTarget, "build-current")
	if err := os.MkdirAll(filepath.Dir(currentPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(currentTarget, currentPath); err != nil {
		t.Fatal(err)
	}
	pathDir := filepath.Join(root, "path")
	pathShuttle := filepath.Join(pathDir, "shuttle")
	writeShuttleVersion(t, pathShuttle, "build-stale")
	goBinShuttle := filepath.Join(home, "go", "bin", "shuttle")
	writeShuttleVersion(t, goBinShuttle, "build-old")

	a := newApp(env)
	// The fake --version probes share the machine with every parallel test's
	// subprocesses; a slow one is not a broken one.
	a.versionProbeTimeout = time.Minute
	receipt := a.collectShuttleBinaryReceiptAt(currentPath, "build-current", home, pathDir, "")
	if receipt.ResolvedPath != newApp(env).resolveBinaryPath(currentTarget) || receipt.Build != "build-current" {
		t.Fatalf("running binary receipt = %+v", receipt)
	}
	if receipt.HookResolution != newApp(env).resolveBinaryPath(pathShuttle) || receipt.HooksWouldPickIt {
		t.Fatalf("PATH should shadow the running binary in hook resolution: %+v", receipt)
	}
	if len(receipt.Executables) != 2 {
		t.Fatalf("other executables = %+v, want PATH and ~/go/bin candidates", receipt.Executables)
	}
	for _, executable := range receipt.Executables {
		if !executable.Shadowing || executable.Build == "" || executable.Error != "" {
			t.Fatalf("different build was not flagged as shadowing: %+v", executable)
		}
	}

	fallback := newApp(env).collectShuttleBinaryReceiptAt(currentPath, "build-current", home, "", "")
	if fallback.HookResolution != newApp(env).resolveBinaryPath(currentPath) || !fallback.HooksWouldPickIt {
		t.Fatalf("hook fallback should select the running binary: %+v", fallback)
	}
}

func writeShuttleVersion(t *testing.T, path, build string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 2\nprintf 'shuttle version %%s\\n' %q\n", build)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestCombineDoctorReceiptStatusPriorities(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		statuses []receiptStatus
		want     receiptStatus
	}{
		{"healthy", []receiptStatus{receiptHealthy, receiptHealthy}, receiptHealthy},
		{"missing", []receiptStatus{receiptHealthy, receiptMissing}, receiptMissing},
		{"partial", []receiptStatus{receiptHealthy, receiptPartial}, receiptPartial},
		{"mismatch", []receiptStatus{receiptMismatch, receiptMissing}, receiptMismatch},
		{"booting", []receiptStatus{receiptMismatch, receiptBooting}, receiptBooting},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, _ := combineDoctorReceiptStatus(tc.statuses...)
			if got != tc.want {
				t.Fatalf("status = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCollectDaemonReceiptUsesListenerResolutionError(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	hostFile := filepath.Join(t.TempDir(), "host.json")
	setHostEnvIn(t, env, hostFile, nil, nil)
	if err := os.WriteFile(hostFile, []byte("{malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := newApp(env).collectDaemonReceipt()
	if got.Status != receiptMismatch || !strings.Contains(got.Repair, hostFile) || strings.Contains(got.Repair, "<nil>") {
		t.Fatalf("daemon listener repair = %+v, want the host-file resolution error", got)
	}
}

func TestDaemonReceiptOwnerCheckRepairIsActionable(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		err  *daemonTCPOwnerCheckError
		want string
	}{
		{"foreign owner", &daemonTCPOwnerCheckError{address: "127.0.0.1:4000", uid: 2000, foreign: true}, "stop the process holding 127.0.0.1:4000 (uid 2000), then restart the daemon"},
		{"accept timeout", &daemonTCPOwnerCheckError{address: "[::1]:4000", pending: true}, "the listener did not accept within 2 s; retry, and if it persists inspect what holds [::1]:4000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := fmt.Errorf("reaching daemon at http://127.0.0.1:4000: %w", tc.err)
			got := daemonReceiptOnTransportError(ReceiptDaemon{Status: receiptMissing, Repair: "start the daemon"}, err)
			if got.Status != receiptMismatch || got.Repair != tc.want {
				t.Fatalf("daemon owner-check repair = %+v, want %q", got, tc.want)
			}
		})
	}
}

func TestBootingDaemonSuppressesHostMismatchAndRestartAdvice(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ready := false
	daemon := ReceiptDaemon{
		Ready:  &ready,
		Status: receiptBooting,
		Repair: "Shuttle daemon is still booting; retry when /api/v1/version reports ready:true",
		Listen: "tcp://127.0.0.1:4000", HostClass: "shared-multi-user",
	}
	host := newApp(env).collectHostReceiptWhenReady(daemon)
	if host.Status != receiptBooting || host.Repair != daemon.Repair || host.Listen != "" || len(host.Problems) != 0 {
		t.Fatalf("host receipt should defer listener checks until readiness: %+v", host)
	}
	status, repair := combineDoctorReceiptStatus(receiptMismatch, receiptBooting)
	if status != receiptBooting || !strings.Contains(repair, "ready:true") {
		t.Fatalf("booting should outrank incomplete boot-time mismatches: %s (%s)", status, repair)
	}
}

func TestCollectDaemonReceiptRequiresMatchingContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		body map[string]any
		want receiptStatus
	}{
		{"healthy", map[string]any{
			"listen": "tcp://127.0.0.1:4000", "host_class": "shared-multi-user", "peer_gate": "uid",
			"peer_gate_uid": 1000, "peer_gate_uid_source": "euid",
			"tailnet_dial": map[string]any{"configured": true, "socket": "/run/tailscale.sock", "bridges": []any{map[string]any{
				"name": "hub-a", "host": "hub-a.example.ts.net", "port": 443,
				"socket": "/run/shuttle/sock/dial-name-hub-a.sock", "status": "ready",
			}}},
			"contract": map[string]any{"expected": 2, "observed": 2, "ok": true},
		}, receiptHealthy},
		{"migration hold", map[string]any{
			"ready": true, "contract": map[string]any{"expected": 2, "observed": 2, "ok": true},
			"reconciliation_hold": "journal_unreadable /state/migrations/broken.json: invalid schema",
		}, receiptMismatch},
		{"mismatch", map[string]any{"contract": map[string]any{"expected": 2, "observed": 1, "ok": false}}, receiptMismatch},
		{"booting ignores incomplete contract and listener evidence", map[string]any{
			"ready": false, "listen": "tcp://127.0.0.1:4000", "host_class": "shared-multi-user",
			"peer_gate": "none", "contract": map[string]any{"expected": 3, "observed": 4, "ok": false},
		}, receiptBooting},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(tc.body)
			}))
			got := newApp(env).collectDaemonReceipt()
			if got.Status != tc.want {
				t.Fatalf("daemon receipt = %#v, want status %q", got, tc.want)
			}
			if tc.name == "migration hold" && (!got.Contract || got.ReconciliationHold != tc.body["reconciliation_hold"] || !strings.Contains(got.Repair, "/state/migrations/broken.json") || !strings.Contains(got.Repair, "daemon release cannot clear")) {
				t.Fatalf("migration hold must remain visible with a matching contract: %+v", got)
			}
			if tc.want == receiptHealthy && !got.Contract {
				t.Fatal("matching daemon contract was not accepted")
			}
			if tc.want == receiptBooting && (got.Ready == nil || *got.Ready || got.Contract || got.Expected != nil || !strings.Contains(got.Repair, "ready:true")) {
				t.Fatalf("booting receipt should defer contract judgment and advise waiting: %+v", got)
			}
			if tc.name == "healthy" && (got.Listen != "tcp://127.0.0.1:4000" || got.HostClass != "shared-multi-user" || got.PeerGate != "uid" || got.PeerGateUID == nil || *got.PeerGateUID != 1000 || got.PeerGateUIDSource != "euid") {
				t.Fatalf("version listener fields = %+v", got)
			}
			if tc.name == "healthy" && (got.TailnetDial == nil || !got.TailnetDial.Configured || got.TailnetDial.Socket != "/run/tailscale.sock" || len(got.TailnetDial.Bridges) != 1 || got.TailnetDial.Bridges[0].Status != "ready") {
				t.Fatalf("version tailnet dial fields = %+v", got.TailnetDial)
			}
		})
	}
}
