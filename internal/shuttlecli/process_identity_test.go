package shuttlecli

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestProcessIdentityCommandCurrentKernelProcess(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	out, stderr, err := executeIn(t, testEnv(t), dir, "process-identity", strconv.Itoa(os.Getpid()))
	if err != nil || stderr != "" {
		t.Fatalf("probe: %q %q %v", out, stderr, err)
	}
	var got messaging.ProcessIdentity
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if want := messaging.ProbeProcessIdentity(os.Getpid()); got != want || got.Status != "present" || got.Start == "" {
		t.Fatalf("probe = %#v, want %#v", got, want)
	}
}

func TestProcessIdentityCommandRejectsInvalidPID(t *testing.T) {
	t.Parallel()
	for _, pid := range []string{"0", "-1", "no-pid", "999999999999999999999999"} {
		out, _, err := executeIn(t, testEnv(t), t.TempDir(), "process-identity", "--", pid)
		if err == nil || out != "" {
			t.Fatalf("invalid PID %q: %q %v", pid, out, err)
		}
	}
}
