package shuttlecli

import (
	"os"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// testApp is an app on a copy of the test process's environment, taken when
// it is called, writing to the process's standard streams.
func testApp(t testing.TB) *app {
	t.Helper()
	env, _ := sysenvtest.FromProcess(t, nil)
	env.Stdin, env.Stdout, env.Stderr = os.Stdin, os.Stdout, os.Stderr
	a := newApp(env)
	if goos, ok := testGOOS.Load(t); ok {
		a.hostGOOS = goos.(string)
	}
	return a
}

// testGOOS holds the platform useHostGOOS gave each test.
var testGOOS sync.Map // testing.TB → string

// useHostGOOS makes every testApp(t) of this test run as if this machine were
// goos.
func useHostGOOS(t testing.TB, goos string) {
	t.Helper()
	testGOOS.Store(t, goos)
	t.Cleanup(func() { testGOOS.Delete(t) })
}

// executeCLI runs one shuttle invocation in a fresh command tree with dir as
// the -C default and returns what it wrote.
func executeCLI(t *testing.T, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return executeApp(t, testApp(t), dir, args...)
}

// executeIn is executeCLI in an env the test configured.
func executeIn(t testing.TB, env *sysenv.Env, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return executeApp(t, newApp(env), dir, args...)
}

// executeApp is executeCLI on an app the test configured.
func executeApp(t testing.TB, a *app, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	streams := sysenvtest.Capture(a.env)
	root := a.rootCmd()
	a.dir = dir
	root.SetArgs(args)
	err = root.Execute()
	return streams.Stdout.String(), streams.Stderr.String(), err
}

func runCommand(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	stdout, _, err := executeCLI(t, dir, args...)
	return stdout, err
}
