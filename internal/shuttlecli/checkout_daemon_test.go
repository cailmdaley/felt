package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestDaemonAssemblyOutputsAreIgnored(t *testing.T) {
	env := testEnv(t)
	for _, path := range []string{"bin/rel-built", "bin/rel.generation-fixture/bin/shuttled"} {
		if out, err := env.Command("git", "-C", "../..", "check-ignore", path).CombinedOutput(); err != nil {
			t.Errorf("assembly output %s is not ignored: %v %s", path, err, out)
		}
	}
}

func TestCheckoutBuildsAndLinkedRestartsNeverSelectOrCycleHostDaemon(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	base := t.TempDir()
	main, linked := filepath.Join(base, "main checkout"), filepath.Join(base, "linked checkout")
	if err := os.MkdirAll(filepath.Join(main, "scripts"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(main, "daemon"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(main, "daemon", "fixture"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{"Makefile", "scripts/checkout-daemon.sh", "scripts/build-lock.sh"} {
		data, err := os.ReadFile(filepath.Join("../..", relative))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(main, relative), data, 0755); err != nil {
			t.Fatal(err)
		}
	}
	// The actual daemon assembly recipe runs against a fake Mix. No service
	// command is stubbed out of that recipe, so an accidental selection fails.
	overrides := `
cli:
	@echo local-cli >> "$$EVENTS"
cli-install:
	@echo explicit-cli-install >> "$$EVENTS"
start-selected:
	@echo started-selected >> "$$EVENTS"
`
	makefile, err := os.OpenFile(filepath.Join(main, "Makefile"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := makefile.WriteString(overrides); err != nil {
		t.Fatal(err)
	}
	makefile.Close()
	git := func(args ...string) {
		t.Helper()
		command := env.Command("git", append([]string{"-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid"}, args...)...)
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init")
	git("add", ".")
	git("commit", "-m", "fixture")
	git("worktree", "add", "-b", "linked", linked)
	events := filepath.Join(base, "events")
	env.Set("EVENTS", events)
	env.Set("SHELL", "/bin/sh")
	env.Set("SKIP_UI", "1")
	fakeMix := sysenvtest.FakeCommand(t, env, "mix", `#!/bin/sh
case "$1" in release)
 while [ "$1" != --path ]; do shift; done
 shift; mkdir -p "$1/bin"
 printf '#!/bin/sh\n# build %s\nexit 0\n' "$BUILD_ID" > "$1/bin/shuttled"
 chmod +x "$1/bin/shuttled"
 ;; esac
exit 0
`)
	// An older installed CLI must never be asked to select or migrate releases.
	sysenvtest.FakeCommand(t, env, "shuttle", "#!/bin/sh\necho BAD-installed-cli >> \"$EVENTS\"\nexit 99\n")
	localCLI := `#!/bin/sh
printf 'checkout-cli:%s\n' "$*" >> "$EVENTS"
case "$1 $2" in
 'daemon activate-release')
  printf '%s\n' "$3" > "$HOME/.shuttle/repo"
  shift 3; [ "$1" = -- ] || exit 8; shift; exec "$@" ;;
 'daemon stop') exit 0 ;;
 'daemon install') [ -x "$SHUTTLE_RELEASE/bin/shuttled" ] ;;
 'daemon select-release') [ -x "$3/bin/shuttled" ] ;;
 *) exit 9 ;;
esac
`
	for _, root := range []string{main, linked} {
		if err := os.WriteFile(filepath.Join(root, "shuttle"), []byte(localCLI), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, ".shuttle"), 0700); err != nil {
		t.Fatal(err)
	}
	pointer := filepath.Join(home, ".shuttle", "repo")
	initial := "/already/selected/release\n"
	if err := os.WriteFile(pointer, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(root string, args ...string) string {
		t.Helper()
		arguments := append([]string{"-C", root, "MIX=" + fakeMix, "INSTALL_DIR=" + filepath.Dir(fakeMix)}, args...)
		command := env.Command("make", arguments...)
		out, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("make %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	// A deployed pathname from a directory-based build remains untouched too.
	legacy := writeTestDaemonRelease(t, filepath.Join(main, "bin", "rel"))
	legacyBefore, _ := os.ReadFile(legacy.Launcher)
	for _, root := range []string{main, linked} {
		run(root, "build")
	}
	legacyAfter, err := os.ReadFile(legacy.Launcher)
	if err != nil || string(legacyAfter) != string(legacyBefore) {
		t.Fatalf("build replaced an existing directory-based release: %v", err)
	}
	// A selection retains one assembled generation across subsequent builds.
	a := newApp(env)
	release, err := a.validateDaemonRelease(filepath.Join(main, "bin", "rel-built"))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.selectDaemonRelease(release); err != nil {
		t.Fatal(err)
	}
	selected, _ := os.ReadFile(pointer)
	before, _ := os.ReadFile(release.Launcher)
	env.Set("BUILD_ID", "second")
	run(main, "daemon")
	after, err := os.ReadFile(release.Launcher)
	if err != nil || string(after) != string(before) {
		t.Fatalf("ordinary build replaced selected generation %s: %q -> %q (%v)", selected, before, after, err)
	}
	latest, err := a.validateDaemonRelease(filepath.Join(main, "bin", "rel-built"))
	if err != nil || latest.Dir == release.Dir {
		t.Fatalf("build did not publish a distinct generation: %v, %s", err, latest.Dir)
	}
	if err := os.WriteFile(pointer, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	output := run(linked, "restart")
	if !strings.Contains(output, "daemon is selected elsewhere") || !strings.Contains(output, "--hosts local --ref") {
		t.Fatalf("linked restart missing guidance: %s", output)
	}
	data, _ := os.ReadFile(pointer)
	if string(data) != initial {
		t.Fatalf("build or linked restart changed pointer: %q", data)
	}
	calls, _ := os.ReadFile(events)
	if strings.Contains(string(calls), "checkout-cli") || strings.Contains(string(calls), "explicit-cli-install") || strings.Contains(string(calls), "BAD") || strings.Contains(string(calls), "started-selected") {
		t.Fatalf("build or linked restart touched host lifecycle: %s", calls)
	}
	run(linked, "stop")
	calls, _ = os.ReadFile(events)
	canonicalLinked, _ := filepath.EvalSymlinks(linked)
	if !strings.Contains(string(calls), "daemon stop --within "+canonicalLinked) {
		t.Fatalf("linked stop was not scoped: %s", calls)
	}
	// Both installer entry points must consume the generation just assembled,
	// not an old directory-based release left in this checkout.
	if err := os.RemoveAll(legacy.Dir); err != nil {
		t.Fatal(err)
	}
	run(main, "install-agent")
	bootstrap, err := os.ReadFile("../../scripts/bootstrap.sh")
	if err != nil {
		t.Fatal(err)
	}
	function := strings.Split(strings.Split(string(bootstrap), "start_respawn_loop() {")[1], "\n}\n")[0]
	sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 0\n")
	env.Set("REPO", main)
	env.Set("SHUTTLE_BIN", filepath.Join(main, "shuttle"))
	command := env.Command("bash", "-c", "ok() { :; }; note() { :; }; die() { exit 1; }; "+function)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("bootstrap release selection: %v\n%s", err, out)
	}
	run(main, "restart")
	calls, _ = os.ReadFile(events)
	if strings.Contains(string(calls), "BAD") || !strings.Contains(string(calls), "explicit-cli-install") || !strings.Contains(string(calls), "daemon activate-release") || !strings.Contains(string(calls), "started-selected") {
		t.Fatalf("main restart did not use checkout CLI: %s", calls)
	}
}
