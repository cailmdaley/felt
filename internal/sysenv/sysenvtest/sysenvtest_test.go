package sysenvtest

import (
	"os"
	"strings"
	"testing"
)

func TestFakeCommandShadowsOnlyItsOwnEnv(t *testing.T) {
	t.Parallel()
	env, streams := FromProcess(t, map[string]string{"MARK": "one"})
	other, _ := FromProcess(t, nil)
	FakeCommand(t, env, "git", `printf 'fake git %s' "$MARK"`)

	cmd := env.Command("git", "status")
	cmd.Stdout = env.Stdout
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if got := streams.Stdout.String(); got != "fake git one" {
		t.Fatalf("stdout = %q", got)
	}
	if path, _ := other.LookPath("git"); strings.HasPrefix(path, FakeBin(t, env)) {
		t.Fatal("another env saw the fake")
	}
	if os.Getenv("MARK") != "" {
		t.Fatal("an override reached the process environment")
	}

	OnlyPath(env)
	if path, err := env.LookPath("git"); err != nil || !strings.HasPrefix(path, FakeBin(t, env)) {
		t.Fatalf("OnlyPath dropped the fake bin: %q, %v", path, err)
	}
}
