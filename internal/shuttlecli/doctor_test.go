package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCombineDoctorReceiptStatusPriorities(t *testing.T) {
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
			got, _ := combineDoctorReceiptStatus(tc.statuses...)
			if got != tc.want {
				t.Fatalf("status = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCollectDaemonReceiptUsesListenerResolutionError(t *testing.T) {
	hostFile := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, hostFile, nil, nil)
	if err := os.WriteFile(hostFile, []byte("{malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := collectDaemonReceipt()
	if got.Status != receiptMismatch || !strings.Contains(got.Repair, hostFile) || strings.Contains(got.Repair, "<nil>") {
		t.Fatalf("daemon listener repair = %+v, want the host-file resolution error", got)
	}
}

func TestDaemonReceiptOwnerCheckRepairIsActionable(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  *daemonTCPOwnerCheckError
		want string
	}{
		{"foreign owner", &daemonTCPOwnerCheckError{address: "127.0.0.1:4000", uid: 2000, foreign: true}, "stop the process holding 127.0.0.1:4000 (uid 2000), then restart the daemon"},
		{"accept timeout", &daemonTCPOwnerCheckError{address: "[::1]:4000", pending: true}, "the listener did not accept within 2 s; retry, and if it persists inspect what holds [::1]:4000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := fmt.Errorf("reaching daemon at http://127.0.0.1:4000: %w", tc.err)
			got := daemonReceiptOnTransportError(ReceiptDaemon{Status: receiptMissing, Repair: "start the daemon"}, err)
			if got.Status != receiptMismatch || got.Repair != tc.want {
				t.Fatalf("daemon owner-check repair = %+v, want %q", got, tc.want)
			}
		})
	}
}

func TestBootingDaemonSuppressesHostMismatchAndRestartAdvice(t *testing.T) {
	ready := false
	daemon := ReceiptDaemon{
		Ready:  &ready,
		Status: receiptBooting,
		Repair: "Shuttle daemon is still booting; retry when /api/v1/version reports ready:true",
		Listen: "tcp://127.0.0.1:4000", HostClass: "shared-multi-user",
	}
	host := collectHostReceiptWhenReady(daemon)
	if host.Status != receiptBooting || host.Repair != daemon.Repair || host.Listen != "" || len(host.Problems) != 0 {
		t.Fatalf("host receipt should defer listener checks until readiness: %+v", host)
	}
	status, repair := combineDoctorReceiptStatus(receiptMismatch, receiptBooting)
	if status != receiptBooting || !strings.Contains(repair, "ready:true") {
		t.Fatalf("booting should outrank incomplete boot-time mismatches: %s (%s)", status, repair)
	}
}

func TestCollectDaemonReceiptRequiresMatchingContract(t *testing.T) {
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
		{"mismatch", map[string]any{"contract": map[string]any{"expected": 2, "observed": 1, "ok": false}}, receiptMismatch},
		{"booting ignores incomplete contract and listener evidence", map[string]any{
			"ready": false, "listen": "tcp://127.0.0.1:4000", "host_class": "shared-multi-user",
			"peer_gate": "none", "contract": map[string]any{"expected": 3, "observed": 4, "ok": false},
		}, receiptBooting},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(tc.body)
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			got := collectDaemonReceipt()
			if got.Status != tc.want {
				t.Fatalf("daemon receipt = %#v, want status %q", got, tc.want)
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
