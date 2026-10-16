package feltcli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReminderShellGate(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "must-not-run")
	calls := filepath.Join(dir, "calls")
	if err := os.WriteFile(binary, []byte("#!/bin/bash\nprintf x >> \"$CALLS\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "felt-reminded-activated"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		payload string
		skipped bool
	}{
		{`{"session_id":"activated","tool_name":"Read"}`, true},
		{`{ "session_id" : "activated", "tool_name":"Read" }`, true},
		{`{"session_id":"not-activated","tool_name":"Read"}`, false},
		{`{"tool_input":{"session_id":"activated"},"session_id":"not-activated"}`, false},
		{`{"session_id":"../activated"}`, false},
	} {
		_ = os.Remove(calls)
		cmd := exec.Command("bash", filepath.Join("..", "..", "claude-plugin", "hooks", "remind.sh"))
		cmd.Env = append(os.Environ(), "FELT_BIN="+binary, "TMPDIR="+dir, "CALLS="+calls, "PATH=/nonexistent")
		cmd.Stdin = strings.NewReader(tc.payload)
		if out, err := cmd.CombinedOutput(); err != nil || len(out) > 0 {
			t.Fatalf("%s: %v", out, err)
		}
		_, err := os.Stat(calls)
		if os.IsNotExist(err) != tc.skipped {
			t.Fatalf("payload %s: skipped=%v, stat=%v", tc.payload, tc.skipped, err)
		}
	}
}

func TestHookShimsOneInvocationAndOldBinary(t *testing.T) {
	for _, hook := range []string{"event.sh", "commit.sh", "remind.sh", "touch.sh"} {
		for _, status := range []string{"0", "1", "127"} {
			t.Run(hook+status, func(t *testing.T) {
				dir := t.TempDir()
				binary := filepath.Join(dir, "binary")
				calls := filepath.Join(dir, "calls")
				script := "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$CALLS\"\nexit " + status + "\n"
				if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command("bash", filepath.Join("..", "..", "claude-plugin", "hooks", hook))
				cmd.Env = append(os.Environ(), "FELT_BIN="+binary, "SHUTTLE_BIN="+binary, "CALLS="+calls)
				cmd.Stdin = strings.NewReader("{}")
				if out, err := cmd.CombinedOutput(); err != nil || len(out) > 0 {
					t.Fatalf("%s: %v", out, err)
				}
				data, err := os.ReadFile(calls)
				if err != nil || strings.Count(string(data), "\n") != 1 || strings.Contains(string(data), "--help") {
					t.Fatalf("calls %q: %v", data, err)
				}
			})
		}
	}
}
