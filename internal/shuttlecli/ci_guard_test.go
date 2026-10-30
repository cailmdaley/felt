package shuttlecli

import (
	"context"
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

type ciStatusHarness struct {
	t                *testing.T
	bin, cache, args string
	response, fail   string
	block, release   string
	module           string
}

func newCIStatusHarness(t *testing.T) *ciStatusHarness {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("optional CI warning hook requires Node")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	module, err := filepath.Abs("../../scripts/ci-status.mjs")
	if err != nil {
		t.Fatal(err)
	}
	h := &ciStatusHarness{t: t, bin: bin, cache: filepath.Join(dir, "felt-ci-status.json"), args: filepath.Join(dir, "args"), response: filepath.Join(dir, "response"), fail: filepath.Join(dir, "fail"), block: filepath.Join(dir, "block"), release: filepath.Join(dir, "release"), module: module}
	sysenvtest.LinkScript(t, filepath.Join(bin, "git"), `printf '%s\n' "$CI_COMMON_DIR"
`)
	sysenvtest.LinkScript(t, filepath.Join(bin, "gh"), `printf '%s\n' "$@" >> "$CI_ARGS"
[ ! -f "$CI_FAIL" ] || exit 1
if [ -f "$CI_BLOCK" ]; then
  while [ ! -f "$CI_RELEASE" ]; do sleep 0.02; done
fi
cat "$CI_RESPONSE"
`)
	h.write(h.response, `{"workflow_runs":[{"head_sha":"eeeeeeee12345678","conclusion":"success","html_url":"https://example.test/latest"}]}`)
	t.Cleanup(func() { _ = os.WriteFile(h.release, nil, 0o600) })
	return h
}

func (h *ciStatusHarness) write(path, body string) {
	h.t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *ciStatusHarness) run(args ...string) (string, time.Duration) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", append([]string{h.module}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+h.bin+":"+os.Getenv("PATH"), "CI_COMMON_DIR="+filepath.Dir(h.cache), "CI_ARGS="+h.args, "CI_RESPONSE="+h.response, "CI_FAIL="+h.fail, "CI_BLOCK="+h.block, "CI_RELEASE="+h.release)
	started := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(started)
	if err != nil {
		h.t.Fatalf("CI helper: %v: %s", err, out)
	}
	return string(out), elapsed
}

func (h *ciStatusHarness) awaitFreshCache() {
	h.t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(h.cache)
		if strings.Contains(string(data), "eeeeeeee12345678") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatal("detached refresh did not publish its successful result")
}

func TestCIStatusHookCachedResultsAndDetachedRefresh(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, cache, want string }{
		{"red", `{"sha":"0123456789abcdef","conclusion":"failure","url":"https://example.test/1","checked_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`, "CI is red on main at 01234567: https://example.test/1\n"},
		{"old-red", `{"sha":"0123456789abcdef","conclusion":"failure","url":"https://example.test/1","checked_at":"` + time.Now().Add(-49*time.Hour).UTC().Format(time.RFC3339) + `"}`, "CI is red on main at 01234567: https://example.test/1 (cached 2 days ago)\n"},
		{"green", `{"sha":"0123456789abcdef","conclusion":"success","url":"https://example.test/1","checked_at":"2026-01-01T00:00:00Z"}`, ""},
		{"malformed", "not json", ""},
		{"invalid-date", `{"sha":"abc","conclusion":"failure","url":"https://example.test/1","checked_at":"broken"}`, ""},
		{"missing", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newCIStatusHarness(t)
			if tc.cache != "" {
				h.write(h.cache, tc.cache)
			}
			// Network work cannot complete until after the foreground hook returns.
			h.write(h.block, "")
			out, elapsed := h.run()
			if out != tc.want {
				t.Fatalf("cached warning=%q; want %q", out, tc.want)
			}
			t.Logf("cached foreground returned in %v while gh was blocked", elapsed)
			h.write(h.release, "")
			h.awaitFreshCache()
			args, err := os.ReadFile(h.args)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"api\n", "actions/workflows/ci.yml/runs\n", "branch=main\n", "event=push\n", "status=completed\n", "per_page=1\n"} {
				if !strings.Contains(string(args), want) {
					t.Fatalf("query lacks %q: %s", want, args)
				}
			}
			if strings.Count(string(args), "api\n") != 1 || strings.Contains(string(args), "head_sha=") {
				t.Fatalf("latest-main refresh must make one query without target filter: %s", args)
			}
			info, err := os.Stat(h.cache)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("cache must be private: %v %v", info, err)
			}
		})
	}
}

func TestCIStatusRefreshPreservesCacheOfflineOrMalformed(t *testing.T) {
	t.Parallel()
	h := newCIStatusHarness(t)
	cached := `{"sha":"main-sha","conclusion":"failure","url":"https://example.test/main","checked_at":"2026-01-01T00:00:00Z"}`
	h.write(h.cache, cached)
	for _, response := range []string{"offline", "broken", `{"workflow_runs":[]}`} {
		if response == "offline" {
			h.write(h.fail, "")
		} else {
			_ = os.Remove(h.fail)
			h.write(h.response, response)
		}
		out, _ := h.run("--refresh", h.cache)
		data, err := os.ReadFile(h.cache)
		if out != "" || err != nil || string(data) != cached {
			t.Fatalf("unsuccessful refresh must preserve last known cache: out=%q data=%q err=%v", out, data, err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(h.cache))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatal("refresh left a partial cache file")
		}
	}
}

func TestCIStatusDeployTargetDoesNotReadOrWriteMainCache(t *testing.T) {
	t.Parallel()
	h := newCIStatusHarness(t)
	cached := `{"sha":"main-sha","conclusion":"success","url":"https://example.test/main","checked_at":"2026-01-01T00:00:00Z"}`
	h.write(h.cache, cached)
	h.write(h.response, `{"workflow_runs":[{"head_sha":"abcdef0123456789","conclusion":"failure","html_url":"https://example.test/old"}]}`)
	out, _ := h.run("abcdef0123456789")
	if out != "CI is red on main at abcdef01: https://example.test/old\n" {
		t.Fatalf("target warning=%q", out)
	}
	data, err := os.ReadFile(h.cache)
	if err != nil || string(data) != cached {
		t.Fatalf("old target must not poison main cache: %s %v", data, err)
	}
	args, _ := os.ReadFile(h.args)
	if !strings.Contains(string(args), "head_sha=abcdef0123456789\n") {
		t.Fatalf("target query lacks exact SHA: %s", args)
	}
	// A mismatched response cannot warn about a different deployment target.
	out, _ = h.run("0123456789abcdef")
	if out != "" {
		t.Fatalf("mismatched target response must stay quiet: %s", out)
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
