//go:build !integration

package shuttlecli

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// TestRunNilArgsIgnoresProcessArgs re-executes the test binary with process
// arguments no shuttle invocation accepts, and checks that Run(env, nil)
// behaves as Run(env, []string{}) there instead of parsing them.
func TestRunNilArgsIgnoresProcessArgs(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_RUN_ARGS_HELPER", "1")
	cmd := env.Command(os.Args[0], "-test.run=^TestRunArgsHelperProcess$", "shuttle-real-process-verb")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper: %v\n%s", err, out)
	}
	nilRun, emptyRun, ok := strings.Cut(string(out), "\n=====\n")
	if !ok {
		t.Fatalf("helper output has no separator:\n%s", out)
	}
	if nilRun != emptyRun {
		t.Fatalf("Run(env, nil) read the process arguments:\n--- nil ---\n%s\n--- empty ---\n%s", nilRun, emptyRun)
	}
}

func TestRunArgsHelperProcess(t *testing.T) {
	if os.Getenv("SHUTTLE_RUN_ARGS_HELPER") != "1" {
		return
	}
	run := func(args []string) string {
		env, streams := sysenvtest.FromProcess(t, nil)
		code := Run(env, args)
		return fmt.Sprintf("exit %d\nstdout:\n%s\nstderr:\n%s", code, streams.Stdout, streams.Stderr)
	}
	fmt.Print(run(nil) + "\n=====\n" + run([]string{}))
	os.Exit(0)
}
