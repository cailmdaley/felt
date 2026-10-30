package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeployChecksExactCommitCI(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	guard := shellFunction(t, string(script), "check_target_ci")
	for _, tc := range []struct {
		name, result, override, want string
		fail                         bool
	}{
		{"green", "completed\tsuccess\thttps://example.test/1", "0", "CI passed", false},
		{"red", "completed\tfailure\thttps://example.test/1", "0", "refusing CI failure", true},
		{"cancelled", "completed\tcancelled\thttps://example.test/1", "0", "refusing CI cancelled", true},
		{"override", "completed\tfailure\thttps://example.test/1", "1", "overriding CI failure", false},
		{"pending", "in_progress\t\thttps://example.test/1", "0", "is in_progress", false},
		{"absent", "", "0", "no CI run yet", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			args := filepath.Join(t.TempDir(), "args")
			cmd := exec.Command("bash", "-c", `
TARGET_COMMIT=0123456789012345678901234567890123456789
TARGET_SHA=0123456
REPO=$PWD
ok() { echo "$1"; }
gh() { printf '%s\n' "$@" > "$CI_ARGS"; printf '%s\n' "$CI_RESULT"; }
`+guard+`check_target_ci`)
			cmd.Env = append(os.Environ(), "CI_ARGS="+args, "CI_RESULT="+tc.result, "ALLOW_FAILED_CI="+tc.override)
			out, err := cmd.CombinedOutput()
			if (err != nil) != tc.fail || !strings.Contains(string(out), tc.want) {
				t.Fatalf("got %v, %s; want failure=%v, %q", err, out, tc.fail, tc.want)
			}
			got, err := os.ReadFile(args)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"--commit\n0123456789012345678901234567890123456789\n", "--workflow\nCI\n", "--event\npush\n"} {
				if !strings.Contains(string(got), want) {
					t.Fatalf("gh arguments lack %q: %s", want, got)
				}
			}
		})
	}
	for _, setup := range []string{`gh() { return 1; }`, `PATH=/no-executables`} {
		cmd := exec.Command("bash", "-c", "TARGET_COMMIT=abc\nREPO=$PWD\n"+setup+"\n"+guard+"check_target_ci")
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.Contains(string(out), "unknown") {
			t.Fatalf("unavailable CI must be explicit: %v: %s", err, out)
		}
	}
	call := strings.Index(string(script), "\ncheck_target_ci || exit 1\n")
	build := strings.Index(string(script), "\n# Exact-ref worktrees")
	if call < 0 || call > build || !strings.Contains(string(script), "--allow-failed-ci) ALLOW_FAILED_CI=1;") {
		t.Fatal("CI must guard ordinary and exact-ref builds, with an explicit override flag")
	}
}
