package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the complete helper against a fake local/SSH host, including its exit status.
func TestDeployRitual(t *testing.T) {
	for _, tc := range []struct {
		name, host, fail string
		shipped, loop    bool
	}{
		{name: "local service", host: "local"},
		{name: "remote loop", host: "remote", loop: true},
		{name: "shipped UI", host: "remote", shipped: true},
		{name: "scheduler", host: "scheduled"},
		{name: "build failure", host: "remote", fail: "build"},
		{name: "harness failure still releases", host: "local", fail: "harness"},
		{name: "restart failure", host: "local", fail: "restart"},
		{name: "release failure", host: "local", fail: "release"},
		{name: "stale boot", host: "local", fail: "boot"},
		{name: "not ready", host: "local", fail: "ready"},
		{name: "wrong SHA", host: "local", fail: "sha"},
		{name: "wrong release version", host: "local", fail: "version"},
		{name: "owner refusal", host: "local", fail: "owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "fake-bin")
			repo := filepath.Join(root, "repo with spaces")
			for _, d := range []string{bin, filepath.Join(repo, "bin"), filepath.Join(repo, ".git"), filepath.Join(repo, "scripts")} {
				if err := os.MkdirAll(d, 0700); err != nil {
					t.Fatal(err)
				}
			}
			script, err := os.ReadFile("../../bin/shuttle-deploy")
			if err != nil {
				t.Fatal(err)
			}
			write := func(p, s string) {
				t.Helper()
				if err := os.WriteFile(p, []byte(s), 0755); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(repo, "bin", "shuttle-deploy"), string(script))
			write(filepath.Join(repo, "scripts", "ci-status-hook.sh"), "#!/bin/sh\necho 'CI advisory: red'\nexit 1\n")
			realBash, err := exec.LookPath("bash")
			if err != nil {
				t.Fatal(err)
			}
			write(filepath.Join(bin, "bash"), "#!/bin/sh\n[ \"$1\" != -lc ] || shift\nexec '"+realBash+"' -c \"$@\"\n")
			write(filepath.Join(bin, "ssh"), `#!/bin/sh
printf 'ssh %s\n' "$*" >> "$LOG"
for arg do cmd="$arg"; done
exec /bin/sh -c "$cmd"
`)
			write(filepath.Join(bin, "git"), `#!/bin/sh
printf 'git %s\n' "$*" >> "$LOG"
[ "$1" != -C ] || shift 2
case "$1" in
 rev-parse) case "$*" in *git-common-dir*) printf '%s/.git\n' "$SOURCE";; *) echo 1111111111111111111111111111111111111111;; esac;;
 fetch|push|status) exit 0;;
 worktree) if [ "$2" = add ]; then mkdir -p "$4/bin" "$4/ui/dist"; printf '#!/bin/sh\necho restart-loop >> "$LOG"\n[ "$FAIL" != restart ] || exit 1\ntouch "$STATE"\n' > "$4/bin/shuttle-launch"; chmod +x "$4/bin/shuttle-launch"; fi;;
 *) exit 2;;
esac
`)
			write(filepath.Join(bin, "make"), `#!/bin/sh
echo "make $*" >> "$LOG"
[ "$FAIL" != build ]
`)
			write(filepath.Join(bin, "srun"), `#!/bin/sh
echo scheduler >> "$LOG"
shift
exec "$@"
`)
			write(filepath.Join(bin, "rsync"), "#!/bin/sh\necho \"rsync $*\" >> \"$LOG\"\n")
			write(filepath.Join(bin, "sleep"), "#!/bin/sh\nexit 0\n")
			write(filepath.Join(bin, "felt"), `#!/bin/sh
echo "felt $*" >> "$LOG"
[ "$FAIL" != harness ]
`)
			write(filepath.Join(bin, "pi"), "#!/bin/sh\nexit 0\n")
			write(filepath.Join(bin, "shuttle"), `#!/bin/sh
echo "shuttle $*" >> "$LOG"
case "$*" in
 'host --json') echo '{"data_dir":"/tmp/fake","listen":"unix:///tmp/fake.sock"}';;
 'host check-owner') [ "$FAIL" != owner ];;
 'daemon loop-present') [ "$LOOP" = true ];;
 'daemon install --preserve') echo restart-service >> "$LOG"; [ "$FAIL" != restart ] || exit 1; touch "$STATE";;
 'daemon release') [ "$FAIL" != release ] || exit 1; echo '{ "ok": true }';;
 *) exit 2;;
esac
`)
			write(filepath.Join(bin, "curl"), `#!/bin/sh
boot=2026-01-01T00:00:00Z; ready=true; sha=1111111111111111111111111111111111111111; version=2.0.0
if [ -f "$STATE" ]; then boot=2026-01-02T00:00:00Z; fi
[ "$FAIL" != boot ] || boot=2026-01-01T00:00:00Z
[ "$FAIL" != ready ] || ready=false
[ "$FAIL" != sha ] || sha=2222222222222222222222222222222222222222
[ "$FAIL" != version ] || version=1.0.0
printf '{ "git_sha": "%s", "booted_at": "%s", "ready": %s, "mix_vsn": "%s" }\n' "$sha" "$boot" "$ready" "$version"
`)
			fleet := filepath.Join(root, "remotes.json")
			ui := "true"
			if tc.shipped {
				ui = "false"
			}
			write(fleet, `{"remotes":[{"name":"remote","ssh":"remote","checkout":"`+repo+`","build_ui":`+ui+`,"ssh_flags":["-o","ClearAllForwardings=yes"]},{"name":"scheduled","checkout":"`+repo+`","build_wrap":"srun --serial"}]}`)
			log := filepath.Join(root, "calls")
			state := filepath.Join(root, "restarted")
			cmd := exec.Command(realBash, filepath.Join(repo, "bin", "shuttle-deploy"), "--no-push", "--ref", "v2.0.0", "--hosts", tc.host)
			loop := "false"
			if tc.loop {
				loop = "true"
			}
			cmd.Env = append(os.Environ(), "HOME="+filepath.Join(root, "home"), "PATH="+bin+":"+os.Getenv("PATH"), "SOURCE="+repo, "LOG="+log, "STATE="+state, "FAIL="+tc.fail, "LOOP="+loop, "SHUTTLE_REMOTES_FILE="+fleet, "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0")
			out, err := cmd.CombinedOutput()
			if (err != nil) != (tc.fail != "") {
				t.Fatalf("exit=%v\n%s", err, out)
			}
			calls, _ := os.ReadFile(log)
			text := string(calls)
			restarts := strings.Count(text, "restart-service\n") + strings.Count(text, "restart-loop\n")
			wantRestarts := 1
			if tc.fail == "build" || tc.fail == "owner" {
				wantRestarts = 0
			}
			if restarts != wantRestarts {
				t.Fatalf("restarts=%d want %d\n%s\n%s", restarts, wantRestarts, text, out)
			}
			if !strings.Contains(string(out), "CI advisory: red") {
				t.Fatalf("missing advisory: %s", out)
			}
			if tc.fail != "" && !strings.Contains(string(out), tc.host+":") {
				t.Fatalf("failure doesn't name host: %s", out)
			}
			if tc.fail == "harness" && !strings.Contains(text, "shuttle daemon release") {
				t.Fatalf("harness failure skipped release: %s", text)
			}
			if tc.shipped {
				if !strings.Contains(text, "make build SKIP_UI=1") || !strings.Contains(text, "rsync -az --delete") || strings.Index(text, "rsync -az") > strings.Index(text, "make build") {
					t.Fatalf("bad shipped UI ordering: %s", text)
				}
			}
			if tc.host == "scheduled" && !strings.Contains(text, "scheduler\n") {
				t.Fatalf("missing scheduler: %s", text)
			}
			if tc.host == "remote" && !strings.Contains(text, "ssh -o ClearAllForwardings=yes") {
				t.Fatalf("missing SSH flags: %s", text)
			}
		})
	}
}

func shellFunction(t *testing.T, script, name string) string {
	t.Helper()
	start := strings.Index(script, name+"() {")
	if start < 0 {
		t.Fatalf("missing %s", name)
	}
	end := strings.Index(script[start:], "\n}\n")
	if end < 0 {
		t.Fatalf("unterminated %s", name)
	}
	return script[start:start+end+3] + "\n"
}

func TestDeployCacheSeedReinstallsChangedLockfile(t *testing.T) {
	t.Parallel()
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "same lock", true: "changed lock"}[changed], func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "source")
			previous := filepath.Join(root, "previous")
			gitTest := func(dir string, args ...string) string {
				t.Helper()
				out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
				if err != nil {
					t.Fatalf("git %v: %v %s", args, err, out)
				}
				return strings.TrimSpace(string(out))
			}
			for _, dir := range []string{filepath.Join(source, "ui"), filepath.Join(previous, "ui", "node_modules"), filepath.Join(previous, "daemon", "_build")} {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			write := func(path, body string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(previous, "ui", "package-lock.json"), "old")
			lock := "old"
			if changed {
				lock = "new"
			}
			write(filepath.Join(source, "ui", "package-lock.json"), lock)
			write(filepath.Join(previous, "ui", "node_modules", ".npm-ci-stamp"), "")
			beam := filepath.Join(previous, "daemon", "_build", "cache")
			write(beam, "cache")
			old := time.Unix(100000, 0)
			if err := os.Chtimes(beam, old, old); err != nil {
				t.Fatal(err)
			}
			gitTest(source, "init", "-b", "main")
			gitTest(source, "config", "user.email", "test@example.invalid")
			gitTest(source, "config", "user.name", "Test")
			gitTest(source, "add", ".")
			gitTest(source, "commit", "-m", "source")
			gitTest(source, "remote", "add", "origin", source)
			sha := gitTest(source, "rev-parse", "HEAD")
			script, err := os.ReadFile("../../bin/shuttle-deploy")
			if err != nil {
				t.Fatal(err)
			}
			harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "prepare_tree") + "\nprepare_tree \"$SOURCE\" \"$PREVIOUS\" | bash\n"
			cmd := exec.Command("bash", "-c", harness)
			cmd.Env = append(os.Environ(), "SOURCE="+source, "PREVIOUS="+previous, "TARGET_COMMIT="+sha)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("seed: %v %s", err, out)
			}
			tree := source + ".deploy/" + sha
			_, err = os.Stat(filepath.Join(tree, "ui", "node_modules", ".npm-ci-stamp"))
			if (err == nil) == changed {
				t.Fatalf("changed=%v stamp error=%v", changed, err)
			}
			info, err := os.Stat(filepath.Join(tree, "daemon", "_build", "cache"))
			if err != nil || !info.ModTime().Equal(old) {
				t.Fatalf("cache mtime not preserved: %v %v", info, err)
			}
		})
	}
}

func TestDeployPruneKeepsCurrentPreviousNewestAndPi(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	bin := t.TempDir()
	names := []string{"discard", "pi-root", "previous", "current", "new-one", "new-two"}
	for i, name := range names {
		p := filepath.Join(root, name)
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
		stamp := time.Unix(int64(i+1)*1000, 0)
		if err := os.Chtimes(p, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write("pi", "[ \"$FAIL_PI\" != 1 ] || exit 1\nprintf '  local\\n    %s/pi-root\\n' \"$ROOT\"\n")
	write("git", "printf '%s\\n' \"$*\" >> \"$LOG\"\n")
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "prune_cmd") + "\nprune_cmd \"$ROOT/current\" \"$ROOT/previous\" | bash\n"
	for _, fail := range []string{"0", "1"} {
		log := filepath.Join(root, "prune-"+fail)
		cmd := exec.Command("bash", "-c", harness)
		cmd.Env = append(os.Environ(), "ROOT="+root, "LOG="+log, "FAIL_PI="+fail, "PATH="+bin+":"+os.Getenv("PATH"))
		out, err := cmd.CombinedOutput()
		if (err != nil) != (fail == "1") {
			t.Fatalf("prune exit: %v %s", err, out)
		}
		calls, _ := os.ReadFile(log)
		if fail == "1" {
			if len(calls) > 0 {
				t.Fatalf("pruned despite unknown Pi roots: %s", calls)
			}
		} else if strings.Count(string(calls), "worktree remove") != 1 || !strings.Contains(string(calls), filepath.Join(root, "discard")) {
			t.Fatalf("unexpected removal: %s", calls)
		}
	}
}
