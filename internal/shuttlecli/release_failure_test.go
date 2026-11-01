package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestMissingSelectedReleaseBacksOffInRespawnLoop(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	if err := os.MkdirAll(filepath.Join(home, ".shuttle"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".shuttle", "repo"), []byte("/deleted/checkout/bin/rel\n"), 0600); err != nil {
		t.Fatal(err)
	}
	events := filepath.Join(home, "events")
	env.Set("TEST_EVENTS", events)
	sysenvtest.FakeCommand(t, env, "shuttle", `#!/bin/sh
case "$1 $2" in
 'daemon status') exit 1 ;;
 'daemon start') echo start >> "$TEST_EVENTS"; echo 'selected daemon release is missing; use bin/shuttle-deploy --hosts local' >&2; exit 1 ;;
 *) exit 1 ;;
esac
`)
	sysenvtest.FakeCommand(t, env, "sleep", `#!/bin/sh
printf 'sleep:%s\n' "$1" >> "$TEST_EVENTS"
if [ "$1" = 4 ]; then kill -TERM "$PPID"; fi
`)
	env.Set("SHUTTLE_LOG", filepath.Join(home, "daemon.log"))
	launcher, err := filepath.Abs("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	_ = env.Command("bash", launcher, "--loop").Run()
	got, _ := os.ReadFile(events)
	if string(got) != "start\nsleep:2\nstart\nsleep:4\n" {
		t.Fatalf("missing release tight-looped or stopped instead of backing off: %q", got)
	}
	log, _ := os.ReadFile(env.Getenv("SHUTTLE_LOG"))
	if !strings.Contains(string(log), "selected daemon release is missing") || !strings.Contains(string(log), "bin/shuttle-deploy --hosts local") {
		t.Fatalf("diagnostic absent: %s", log)
	}
}

func TestDeployRejectsMatchingSHABootedFromAnotherRelease(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	harness := `TARGET_SHA=abc123
EXPECTED_RELEASE=/expected/bin/rel
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
version_json() { printf '%s\n' '{"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","ready":true,"release_path":"/competing/bin/rel"}'; }
` + shellFunction(t, string(script), "version_ready") + shellFunction(t, string(script), "wait_for_sha") + "\nwait_for_sha ''\n"
	out, err := env.Command("bash", "-c", harness).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "/competing/bin/rel") || !strings.Contains(string(out), "/expected/bin/rel") {
		t.Fatalf("matching SHA hid wrong release: %v %s", err, out)
	}
}
