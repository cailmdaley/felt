package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestShuttleDeployWaitsForFreshReadyVersion(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	wait := shellFunction(t, string(script), "wait_for_sha")
	callsFile := filepath.Join(t.TempDir(), "version-calls")

	harness := `TARGET_SHA=abc123
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=2
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
CALLS_FILE='` + callsFile + `'
version_json() {
  calls=$(cat "$CALLS_FILE" 2>/dev/null || printf '0')
  calls=$((calls + 1))
  printf '%s' "$calls" > "$CALLS_FILE"
  if [ "$calls" -eq 1 ]; then
    printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":false}'
  else
    printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":true}'
  fi
}
sleep() { :; }
` + shellFunction(t, string(script), "version_ready") + wait + `
wait_for_sha ""
printf 'polls=%s\n' "$(cat "$CALLS_FILE")"
`
	cmd := exec.Command("bash", "-c", harness)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wait_for_sha failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "still booting") || !strings.Contains(string(out), "polls=2") {
		t.Fatalf("did not wait through ready:false before success: %s", out)
	}
}

func TestShuttleDeployReportsBootingAtReadyTimeout(t *testing.T) {
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}

	harness := `TARGET_SHA=abc123
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":false}'; }
sleep() { :; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "wait_for_sha") + `
wait_for_sha ""
`
	cmd := exec.Command("bash", "-c", harness)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("wait_for_sha unexpectedly accepted a booting daemon: %s", out)
	}
	if !strings.Contains(string(out), "still booting") || !strings.Contains(string(out), "ready:true") {
		t.Fatalf("timeout did not explain readiness requirement: %s", out)
	}
}

func shellFunction(t *testing.T, script, name string) string {
	t.Helper()
	start := strings.Index(script, name+"() {")
	if start < 0 {
		t.Fatalf("function %s not found", name)
	}
	end := strings.Index(script[start:], "\n}")
	if end < 0 {
		t.Fatalf("function %s is unterminated", name)
	}
	return script[start:start+end+2] + "\n"
}
