package shuttlecli

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeployCapturedValuesWithRealLoginBash(t *testing.T) {
	t.Parallel()
	source, e := os.ReadFile("../../bin/shuttle-deploy")
	if e != nil {
		t.Fatal(e)
	}
	bash, e := exec.LookPath("bash")
	if e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"noise-and-read", "early-zero-exit"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			profile := filepath.Join(root, "profile")
			text := `shopt -q login_shell || exit 77
printf 'login stdout without a newline'
printf 'login-stderr-token\n' >&2
read -r ignored || :
[ -z "$ignored" ] || exit 78
`
			if mode == "early-zero-exit" {
				text += "exit 0\n"
			}
			if e := os.WriteFile(profile, []byte(text), 0600); e != nil {
				t.Fatal(e)
			}
			// Exercise real -l startup, never the operator's /etc or home profiles.
			harness := shellFunction(t, string(source), "shell_quote") + shellFunction(t, string(source), "run_value") + `
run_on_visible() { ` + shellQuote(bash) + ` --noprofile -l -c '. "$PROFILE"; eval "$1"' fixture "$2" </dev/null; }
run_value '' "printf '%s\\n' \"/a b's/c\""
`
			cmd := exec.Command(bash, "-c", harness)
			cmd.Env = append(os.Environ(), "PROFILE="+profile)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			out, e := cmd.Output()
			if mode == "early-zero-exit" {
				if e == nil || !strings.Contains(stderr.String(), "missing value completion frame") {
					t.Fatalf("profile zero exit accepted: %v %s %s", e, out, &stderr)
				}
			} else if e != nil || string(out) != "/a b's/c\n" {
				t.Fatalf("login output/input corrupted value: %v %q %s", e, out, &stderr)
			}
			if !strings.Contains(stderr.String(), "login-stderr-token") {
				t.Fatalf("lost native stderr: %s", &stderr)
			}
		})
	}
}

func TestDeployLoginNoiseAndReadsCannotConsumeBootstrap(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	profile := `umask 027
shopt -q login_shell || exit 77
printf 'profile stdout notice'
printf 'profile stderr notice\n' >&2
read -r ignored || :
[ -z "$ignored" ] || exit 78
export LOGIN_PROFILE_LOADED=yes
`
	if e := os.WriteFile(filepath.Join(f.home, ".bash_profile"), []byte(profile), 0600); e != nil {
		t.Fatal(e)
	}
	cmd, log := f.start(t, "noisy-login")
	if e := cmd.Wait(); e != nil {
		t.Fatalf("deployment under noisy, reading profile: %v %s", e, fleetRead(log))
	}
	if strings.Count(fleetRead(f.events), "cycle\n") != 1 {
		t.Fatalf("bootstrap did not complete: %s", fleetRead(f.events))
	}
}

func TestDeployLoginProfileZeroExitCannotFakeCompletion(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	if e := os.WriteFile(filepath.Join(f.home, ".bash_profile"), []byte("case $0 in bootstrap) exit 0;; esac\n"), 0600); e != nil {
		t.Fatal(e)
	}
	cmd, log := f.start(t, "profile-exit")
	if e := cmd.Wait(); e == nil {
		t.Fatalf("profile exit accepted as deployment: %s", fleetRead(log))
	}
	if !strings.Contains(fleetRead(log), "missing deployment completion sentinel") {
		t.Fatalf("missing completion diagnostic: %s", fleetRead(log))
	}
	if strings.Contains(fleetRead(f.events), "build ") {
		t.Fatal("bootstrap ran after profile exit")
	}
}
