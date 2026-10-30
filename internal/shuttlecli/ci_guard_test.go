package shuttlecli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestDeployCIWarningNeverGatesTarget(t *testing.T) {
	t.Parallel()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(t.TempDir(), "sha")
	sysenvtest.LinkScript(t, filepath.Join(repo, "scripts", "ci-status-hook.sh"), `printf '%s' "$1" > "$CI_ARGS"
echo 'CI is red on main at 01234567: https://example.test/1'
exit 1
`)
	cmd := exec.Command("bash", "-c", shellFunction(t, string(script), "warn_target_ci")+"warn_target_ci")
	cmd.Env = append(os.Environ(), "REPO="+repo, "TARGET_COMMIT=0123456789012345678901234567890123456789", "CI_ARGS="+capture)
	out, err := cmd.CombinedOutput()
	if err != nil || string(out) != "CI is red on main at 01234567: https://example.test/1\n" {
		t.Fatalf("red CI must warn without gating deployment: %v: %s", err, out)
	}
	got, err := os.ReadFile(capture)
	if err != nil || string(got) != "0123456789012345678901234567890123456789" {
		t.Fatalf("warning must select exact target SHA: %v: %s", err, got)
	}
	if strings.Contains(string(script), "allow-failed-ci") || strings.Contains(string(script), "ALLOW_FAILED_CI") || !strings.Contains(string(script), "\nwarn_target_ci\n") {
		t.Fatal("deploy must call the warning without a CI override or refusal gate")
	}
}

func TestCIStatusHookOneBoundedWarning(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("optional CI warning hook requires Node")
	}
	for _, tc := range []struct {
		name, result, sha, exit, want string
	}{
		{"red-main", `{"workflow_runs":[{"conclusion":"failure","head_sha":"0123456789abcdef","html_url":"https://example.test/1"}]}`, "", "0", "CI is red on main at 01234567: https://example.test/1\n"},
		{"red-target", `{"workflow_runs":[{"conclusion":"failure","head_sha":"abcdef0123456789","html_url":"https://example.test/2"}]}`, "abcdef0123456789", "0", "CI is red on main at abcdef01: https://example.test/2\n"},
		{"green", `{"workflow_runs":[{"conclusion":"success"}]}`, "", "0", ""},
		{"pending-or-absent", `{"workflow_runs":[]}`, "", "0", ""},
		{"cancelled", `{"workflow_runs":[{"conclusion":"cancelled"}]}`, "", "0", ""},
		{"offline", "", "", "1", ""},
		{"malformed", "not json", "", "0", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			bin := t.TempDir()
			capture := filepath.Join(t.TempDir(), "args")
			sysenvtest.LinkScript(t, filepath.Join(bin, "gh"), `printf '%s\n' "$@" > "$CI_ARGS"
printf '%s' "$CI_RESULT"
exit "$CI_EXIT"
`)
			cmd := exec.Command("/bin/sh", "../../scripts/ci-status-hook.sh", tc.sha)
			cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "CI_ARGS="+capture, "CI_RESULT="+tc.result, "CI_EXIT="+tc.exit)
			out, err := cmd.CombinedOutput()
			if err != nil || string(out) != tc.want {
				t.Fatalf("hook: %v: %q; want %q", err, out, tc.want)
			}
			got, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"api\n", "actions/workflows/ci.yml/runs\n", "branch=main\n", "event=push\n", "status=completed\n", "per_page=1\n"} {
				if !strings.Contains(string(got), want) {
					t.Fatalf("single latest-completed-main query lacks %q: %s", want, got)
				}
			}
			if tc.sha != "" && !strings.Contains(string(got), "head_sha="+tc.sha+"\n") {
				t.Fatalf("query must select target SHA: %s", got)
			}
		})
	}
}

func TestCIStatusHookTimeoutAndMissingToolsStayQuiet(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("optional CI warning hook requires Node")
	}
	bin := t.TempDir()
	sysenvtest.LinkScript(t, filepath.Join(bin, "gh"), "exec /bin/sleep 10\n")
	cmd := exec.Command("/bin/sh", "../../scripts/ci-status-hook.sh")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	started := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(started)
	if err != nil || len(out) != 0 || elapsed > 3*time.Second {
		t.Fatalf("hung gh must time out silently: elapsed=%v err=%v output=%s", elapsed, err, out)
	}
	t.Logf("hung-gh wall time: %v (900ms subprocess deadline)", elapsed)
	cmd = exec.Command("/bin/sh", "../../scripts/ci-status-hook.sh")
	cmd.Env = append(os.Environ(), "PATH="+t.TempDir())
	out, err = cmd.CombinedOutput()
	if err != nil || len(out) != 0 {
		t.Fatalf("missing tools must stay quiet: %v: %s", err, out)
	}
}

func TestRepoSessionStartCIHookHasShortOuterDeadline(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../.claude/settings.json")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	for _, group := range config.Hooks["SessionStart"] {
		for _, hook := range group.Hooks {
			if strings.Contains(hook.Command, "scripts/ci-status-hook.sh") && hook.Timeout == 2 {
				return
			}
		}
	}
	t.Fatal("repo SessionStart must run bounded CI warning with a 2-second outer deadline")
}
