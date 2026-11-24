package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
	"net/http"
	"net/http/httptest"
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
			sysenvtest.LinkScript(t, bin, script)
			env.Set("SHUTTLE_REX_BIN", bin)
			env.Set("SHUTTLE_REX_SERVER", "unix:///doctor-test.sock")
			a := newApp(env)
			a.hostGOOS = "darwin"
			a.rexTitleHelper = func() string { return rexTitleHelperGranted }
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

func TestRexTitleHelperProbeReadsExitStatus(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, script, want string
		warning            bool
	}{
		{"granted", "exit 0", rexTitleHelperGranted, false},
		{"not granted", "exit 3", rexTitleHelperNotGranted, true},
		{"failed", "exit 1", rexTitleHelperFailed, true},
		{"missing", "", rexTitleHelperMissing, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			home := t.TempDir()
			env.Set("HOME", home)
			if tc.script != "" {
				dir := filepath.Join(home, ".local", "bin")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				sysenvtest.LinkScript(t, filepath.Join(dir, "shuttle-rex-title"), "#!/bin/sh\n"+tc.script+"\n")
			}
			got := probeRexTitleHelper(env)
			if got != tc.want || (rexTitleHelperWarning(got) != "") != tc.warning {
				t.Fatalf("helper state = %q, warning %q", got, rexTitleHelperWarning(got))
			}
		})
	}
}

func TestDoctorJoinsRexWarnings(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "rex")
	sysenvtest.LinkScript(t, bin, `#!/bin/sh
case "$*" in
 *'whoami --json') echo '{"rex_version":"test-version"}' ;;
 *'privacy_status -') echo '{"services":[{"service":"full_disk_access","status":"denied"}]}' ;;
 *'client ls --json') echo '{"clients":[]}' ;;
esac
`)
	env.Set("SHUTTLE_REX_BIN", bin)
	a := newApp(env)
	a.hostGOOS = "darwin"
	a.rexTitleHelper = func() string { return rexTitleHelperNotGranted }
	rec := a.collectRexReceipt()
	if rec.TitleHelper != rexTitleHelperNotGranted || !strings.Contains(rec.Warning, "Full Disk Access") || !strings.Contains(rec.Warning, "shuttle-rex-title") {
		t.Fatalf("Rex receipt = %+v", rec)
	}
	var stdout bytes.Buffer
	env.Stdout = &stdout
	a.printRexReceipt(rec)
	if !strings.Contains(stdout.String(), "Rex session following: not_granted") {
		t.Fatal(stdout.String())
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
	a := newApp(env)
	a.rexTailnetListener = func() bool { return false }
	rec := a.collectRexReceipt()
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
	sysenvtest.LinkScript(t, path, script)
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
			"contract": map[string]any{"expected": ShuttleContractLevel, "observed": ShuttleContractLevel, "ok": true},
		}, receiptHealthy},
		{"migration hold", map[string]any{
			"ready": true, "contract": map[string]any{"expected": ShuttleContractLevel, "observed": ShuttleContractLevel, "ok": true},
			"reconciliation_hold": "journal_unreadable /state/migrations/broken.json: invalid schema",
		}, receiptMismatch},
		{"boot hold", map[string]any{
			"ready":     false,
			"boot_hold": map[string]any{"stage": "thread_baseline", "reason": "corrupt /state/mailboxes/threads.json"},
		}, receiptMismatch},
		{"mismatch", map[string]any{"contract": map[string]any{"expected": ShuttleContractLevel, "observed": 1, "ok": false}}, receiptMismatch},
		{"check could not run after a match", map[string]any{"contract": map[string]any{
			"expected": ShuttleContractLevel, "observed": ShuttleContractLevel, "ok": true, "error": "shuttle contract could not run: eagain",
		}}, receiptHealthy},
		{"check never ran", map[string]any{"contract": map[string]any{
			"expected": ShuttleContractLevel, "observed": nil, "ok": true, "error": "shuttle contract could not run: eagain",
		}}, receiptMismatch},
		{"daemon built for another CLI", map[string]any{"ready": true, "contract": map[string]any{
			"expected": ShuttleContractLevel - 11, "observed": ShuttleContractLevel - 11, "ok": true,
		}}, receiptMismatch},
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
			if tc.name == "boot hold" {
				if got.BootHold == nil || got.BootHold.Stage != "thread_baseline" || !strings.Contains(got.Repair, "/state/mailboxes/threads.json") || !strings.Contains(got.Repair, "daemon release cannot clear") {
					t.Fatalf("boot hold must name the failure rather than advise waiting: %+v", got)
				}
				host := newApp(env).collectHostReceiptWhenReady(got)
				status, repair := combineDoctorReceiptStatus(got.Status, host.Status)
				if status != receiptMismatch || repair == "" {
					t.Fatalf("held daemon must not be downgraded to transient booting: %s %s", status, repair)
				}
			}
			if tc.name == "daemon built for another CLI" && (!strings.Contains(got.Repair, "shuttle daemon upgrade") || !strings.Contains(got.Repair, "until they match, `shuttle message <fiber>` refuses and messages already waiting in a fiber's inbox are not delivered")) {
				t.Fatalf("a daemon built for another CLI must name what brings it level: %+v", got)
			}
			if strings.HasPrefix(tc.name, "check") && got.ContractError != "shuttle contract could not run: eagain" {
				t.Fatalf("a check that could not run must say why: %+v", got)
			}
			if tc.name == "check never ran" && !strings.Contains(got.Repair, "has not run yet (shuttle contract could not run: eagain)") {
				t.Fatalf("an unchecked contract must not read as a skew: %+v", got)
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

func TestDoctorLinuxRexReceipt(t *testing.T) {
	t.Parallel()
	for _, up := range []bool{false, true} {
		t.Run(fmt.Sprint(up), func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0600); err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(t.TempDir(), "rex")
			sysenvtest.LinkScript(t, bin, `#!/bin/sh
case "$*" in
 *'whoami --json') echo '{"rex_version":"linux-test"}' ;;
 *) exit 99 ;;
esac
`)
			env.Set("SHUTTLE_REX_BIN", bin)
			a := newApp(env)
			a.hostGOOS = "linux"
			a.rexTailnetListener = func() bool { return up }
			rec := a.collectRexReceipt()
			if rec.Status != receiptHealthy || !rec.Reachable || rec.Version != "linux-test" || rec.TailnetListener == nil || *rec.TailnetListener != up || rec.Warning != "" || rec.Repair != "" || len(rec.Privacy) != 0 {
				t.Fatalf("Linux receipt: %+v", rec)
			}
			var stdout bytes.Buffer
			env.Stdout = &stdout
			a.printRexReceipt(rec)
			if !strings.Contains(stdout.String(), fmt.Sprintf("tailnet listener :7297=%t", up)) || strings.Contains(stdout.String(), "app client") || strings.Contains(stdout.String(), "Full Disk") {
				t.Fatal(stdout.String())
			}
		})
	}
}

func TestDoctorLinuxRexEmbeddedTailscaleReceipt(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name           string
		whoami         string
		wantState      string
		wantURL        string
		wantWarning    string
		wantListener   bool
		wantText       string
		rejectText     string
		expectProbeHit bool
	}{
		{
			name:       "running with available https",
			whoami:     `{"rex_version":"linux-test","tailscale":{"state":"running","dns_name":"rex-box.example.ts.net","https":{"state":"available","url":"https://rex-box.example.ts.net"}}}`,
			wantState:  "running",
			wantURL:    "https://rex-box.example.ts.net",
			wantText:   "Rex: healthy (reachable=true, version=linux-test, tailscale=running https://rex-box.example.ts.net)",
			rejectText: "tailnet listener",
		},
		{
			name:        "running with pending https warns and omits url",
			whoami:      `{"rex_version":"linux-test","tailscale":{"state":"running","dns_name":"rex-box.example.ts.net","https":{"state":"pending","url":"https://rex-box.example.ts.net"}}}`,
			wantState:   "running",
			wantWarning: "Rex embedded Tailscale HTTPS is not ready yet; check 'rex server status'",
			wantText:    "Rex: healthy (reachable=true, version=linux-test, tailscale=running)",
			rejectText:  "tailnet listener",
		},
		{
			name:        "needs_login with auth_url",
			whoami:      `{"rex_version":"linux-test","tailscale":{"state":"needs_login","auth_url":"https://login.tailscale.com/a/example"}}`,
			wantState:   "needs_login",
			wantWarning: "Rex embedded Tailscale needs sign-in: https://login.tailscale.com/a/example",
			wantText:    "Rex: healthy (reachable=true, version=linux-test, tailscale=needs_login)",
			rejectText:  "tailnet listener",
		},
		{
			name:        "needs_login without auth_url",
			whoami:      `{"rex_version":"linux-test","tailscale":{"state":"needs_login"}}`,
			wantState:   "needs_login",
			wantWarning: "Rex embedded Tailscale needs sign-in; run 'rex server tailscale login'",
			wantText:    "Rex: healthy (reachable=true, version=linux-test, tailscale=needs_login)",
			rejectText:  "tailnet listener",
		},
		{
			name:        "needs_machine_approval",
			whoami:      `{"rex_version":"linux-test","tailscale":{"state":"needs_machine_approval"}}`,
			wantState:   "needs_machine_approval",
			wantWarning: "Rex embedded Tailscale is waiting for tailnet machine approval",
			wantText:    "Rex: healthy (reachable=true, version=linux-test, tailscale=needs_machine_approval)",
			rejectText:  "tailnet listener",
		},
		{
			name:        "disabled with error warns without probing port 7297",
			whoami:      `{"rex_version":"linux-test","tailscale":{"state":"disabled","error":"tsnet failed to start"}}`,
			wantState:   "disabled",
			wantWarning: "Rex embedded Tailscale failed: tsnet failed to start",
			wantText:    "Rex: healthy (reachable=true, version=linux-test, tailscale=disabled)",
			rejectText:  "tailnet listener",
		},
		{
			name:           "disabled without error falls back to port 7297 probe",
			whoami:         `{"rex_version":"linux-test","tailscale":{"state":"disabled"}}`,
			wantListener:   true,
			wantText:       "Rex: healthy (reachable=true, version=linux-test, tailnet listener :7297=true)",
			rejectText:     "tailscale=",
			expectProbeHit: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(t.TempDir(), "rex")
			script := "#!/bin/sh\ncase \"$*\" in\n *'whoami --json') printf '%s\\n' " + shellQuote(tc.whoami) + " ;;\n *) exit 99 ;;\nesac\n"
			sysenvtest.LinkScript(t, bin, script)
			env.Set("SHUTTLE_REX_BIN", bin)
			a := newApp(env)
			a.hostGOOS = "linux"
			probed := false
			a.rexTailnetListener = func() bool {
				probed = true
				return true
			}
			rec := a.collectRexReceipt()
			if probed != tc.expectProbeHit {
				t.Fatalf("rexTailnetListener called=%t, want %t", probed, tc.expectProbeHit)
			}
			if rec.Status != receiptHealthy || !rec.Reachable || rec.Version != "linux-test" {
				t.Fatalf("unexpected receipt: %+v", rec)
			}
			if rec.TailscaleState != tc.wantState || rec.TailscaleURL != tc.wantURL || rec.Warning != tc.wantWarning {
				t.Fatalf("tailscale = (state=%q, url=%q, warn=%q), want (%q, %q, %q)", rec.TailscaleState, rec.TailscaleURL, rec.Warning, tc.wantState, tc.wantURL, tc.wantWarning)
			}
			if tc.wantListener {
				if rec.TailnetListener == nil || !*rec.TailnetListener {
					t.Fatalf("want tailnet_listener=true, got %+v", rec.TailnetListener)
				}
			} else if rec.TailnetListener != nil {
				t.Fatalf("want tailnet_listener=nil, got %v", *rec.TailnetListener)
			}
			var stdout bytes.Buffer
			env.Stdout = &stdout
			a.printRexReceipt(rec)
			if !strings.Contains(stdout.String(), tc.wantText) || strings.Contains(stdout.String(), tc.rejectText) {
				t.Fatalf("stdout = %q, want %q and not %q", stdout.String(), tc.wantText, tc.rejectText)
			}
			if tc.wantWarning != "" && !strings.Contains(stdout.String(), "warning: "+tc.wantWarning) {
				t.Fatalf("stdout missing warning %q:\n%s", tc.wantWarning, stdout.String())
			}
			raw, err := json.Marshal(rec)
			if err != nil {
				t.Fatal(err)
			}
			s := string(raw)
			if (tc.wantState != "") != strings.Contains(s, `"tailscale_state"`) {
				t.Fatalf("tailscale_state json mismatch: %s", s)
			}
			if (tc.wantURL != "") != strings.Contains(s, `"tailscale_url"`) {
				t.Fatalf("tailscale_url json mismatch: %s", s)
			}
			if tc.wantListener != strings.Contains(s, `"tailnet_listener"`) {
				t.Fatalf("tailnet_listener json mismatch: %s", s)
			}
		})
	}
}

func TestRexTailnetListenerProbe(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		code int
		body string
		want bool
	}{
		{"Rex gate", 403, `{"error":"connection was not classified by its listener"}`, true},
		{"other forbidden", 403, `{"error":"forbidden"}`, false},
		{"other service", 200, `{}`, false},
		{"invalid response", 403, `not json`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.code); fmt.Fprint(w, tc.body) }))
			defer srv.Close()
			if got := probeRexTailnetListener(srv.URL); got != tc.want {
				t.Fatalf("probe = %t", got)
			}
			srv.Close()
			if probeRexTailnetListener(srv.URL) {
				t.Fatal("closed listener reported up")
			}
		})
	}
}

func TestDoctorStoreSyncWarnings(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/version" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ready":true,"contract":{"expected":%d,"observed":%d,"ok":true},"store_sync":{"enabled":true,"state":"idle","repos":[{"path":"/stores/clean","status":"up_to_date","ahead":0,"behind":0},{"path":"/stores/dirty","status":"stale_dirty","ahead":0,"behind":2,"reason":"working tree has uncommitted changes"},{"path":"/stores/diverged","status":"stale_diverged","ahead":1,"behind":3,"reason":"branch has diverged (1 ahead, 3 behind origin/main)"},{"path":"/stores/broken","status":"fetch_failed","reason":"fatal: could not read from remote"}]}}`, ShuttleContractLevel, ShuttleContractLevel)
	}))
	a := newApp(env)
	d := a.collectDaemonReceipt()
	if d.Status != receiptHealthy {
		t.Fatalf("daemon status = %s (%s)", d.Status, d.Repair)
	}
	if d.StoreSync == nil || len(d.StoreSync.Repos) != 4 {
		t.Fatalf("store_sync = %+v", d.StoreSync)
	}
	var stdout bytes.Buffer
	env.Stdout = &stdout
	a.printStoreSyncReceipt(d.StoreSync)
	out := stdout.String()
	if strings.Contains(out, "/stores/clean") {
		t.Fatalf("up_to_date repo should not warn: %s", out)
	}
	for _, want := range []string{
		"warning: store /stores/dirty is stale_dirty (2 behind upstream): working tree has uncommitted changes",
		"warning: store /stores/diverged is stale_diverged: branch has diverged",
		"warning: store /stores/broken is fetch_failed: fatal: could not read from remote",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}
