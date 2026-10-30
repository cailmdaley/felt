package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
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

func TestCINoticeAcknowledgesOnlyDeliveredRunAttempts(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"gh": `printf '%s\n' "$@" > "$CI_ARGS"
[ ! -f "$CI_GH_FAIL" ] || exit 1
cat "$CI_RUNS"
`,
		"shuttle": `[ ! -f "$CI_DELIVERY_FAIL" ] || exit 1
printf '%s\n' "$@" >> "$CI_MESSAGES"
`,
	} {
		sysenvtest.LinkScript(t, filepath.Join(bin, name), "#!/bin/sh\nset -eu\n"+body)
	}
	runs := filepath.Join(dir, "runs")
	messages := filepath.Join(dir, "messages")
	state := filepath.Join(dir, "state")
	args := filepath.Join(dir, "args")
	deliveryFail := filepath.Join(dir, "delivery-fail")
	ghFail := filepath.Join(dir, "gh-fail")
	write := func(path, data string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	poll := func(wantFailure bool) string {
		t.Helper()
		cmd := exec.Command("/bin/sh", "../../scripts/ci-notice.sh", "owner/repo", "/store", "debug/desk", state, "2026-10-30T00:00:00Z")
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "CI_RUNS="+runs, "CI_MESSAGES="+messages, "CI_ARGS="+args, "CI_DELIVERY_FAIL="+deliveryFail, "CI_GH_FAIL="+ghFail)
		out, err := cmd.CombinedOutput()
		if (err != nil) != wantFailure {
			t.Fatalf("poll: %v: %s (want failure %v)", err, out, wantFailure)
		}
		return string(out)
	}
	write(runs, "42\t1\tabcdef\thttps://example.test/42\tBuild failed\n43\t1\t123456\thttps://example.test/43\tTests failed\n")
	poll(false)
	first, err := os.ReadFile(messages)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"-C\n/store\nmessage\ndebug/desk\n", "https://example.test/42", "https://example.test/43", "--log-failed"} {
		if !strings.Contains(string(first), want) {
			t.Fatalf("messages lack %q: %s", want, first)
		}
	}
	if out := poll(false); out != "" {
		t.Fatalf("acknowledged runs must be quiet: %s", out)
	}
	after, _ := os.ReadFile(messages)
	if string(after) != string(first) {
		t.Fatal("repeat poll duplicated notices")
	}
	write(runs, "42\t2\tabcdef\thttps://example.test/42\tBuild failed again\n")
	write(deliveryFail, "")
	poll(true)
	if _, err := os.Stat(filepath.Join(state, "42-2")); !os.IsNotExist(err) {
		t.Fatal("failed queue write must not acknowledge a run")
	}
	if err := os.Remove(deliveryFail); err != nil {
		t.Fatal(err)
	}
	if out := poll(false); !strings.Contains(out, "attempt 2") {
		t.Fatalf("a new failed attempt needs its own notice: %s", out)
	}
	write(ghFail, "")
	poll(true)
	got, _ := os.ReadFile(args)
	for _, want := range []string{"--paginate", "branch=main", "event=push", "status=failure", "created=>=2026-10-30T00:00:00Z"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("query must cover every failed main push since activation; lacks %q: %s", want, got)
		}
	}
}
