package feltcli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecorderHookSchedule(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "claude-plugin", "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
				Async   bool   `json:"async"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	for event, groups := range config.Hooks {
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if strings.Contains(hook.Command, "commit.sh") {
					t.Fatal("commit hook must not be registered")
				}
				wantAsync := strings.Contains(hook.Command, "event.sh") && event == "SubagentStop"
				if hook.Async != wantAsync {
					t.Fatalf("%s %s: async=%v", event, hook.Command, hook.Async)
				}
			}
		}
	}
}

func TestReminderShellGate(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "must-not-run")
	calls := filepath.Join(dir, "calls")
	if err := os.WriteFile(binary, []byte("#!/bin/bash\nprintf x >> \"$CALLS\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "felt-reminded-activated"), preToolActivationMarker("/transcript/current.jsonl"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "felt-reminded-legacy"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		payload string
		skipped bool
	}{
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","tool_name":"Read"}`, true},
		{`{ "session_id" : "activated", "transcript_path" : "/transcript/current.jsonl", "tool_name":"Read" }`, true},
		{`{"SESSION_ID":"activated","TRANSCRIPT_PATH":"/transcript/current.jsonl"}`, true},
		{`{"session_id":"activated","transcript_path":"/transcript/fresh.jsonl"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/CURRENT.jsonl"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","session_id":"not-activated"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","SESSION_ID":"not-activated"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","\\u0073ession_id":"not-activated"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","transcript_path":"/transcript/fresh.jsonl"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","TRANSCRIPT_PATH":"/transcript/fresh.jsonl"}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","tool_input":{"session_id":"not-activated"}}`, false},
		{`{"session_id":"activated","transcript_path":"/transcript/current.jsonl","tool_input":{"transcript_path":"/transcript/fresh.jsonl"}}`, false},
		{`{"session_id":"activated","tool_name":"Read"}`, false},
		{`{"session_id":"legacy","transcript_path":"/transcript/current.jsonl"}`, false},
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
	for _, hook := range []string{"event.sh", "remind.sh", "touch.sh", "handoff.sh"} {
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
