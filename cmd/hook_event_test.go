package cmd

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// updateGolden regenerates cmd/testdata/events_golden.jsonl instead of
// asserting against it: `go test ./cmd -run Golden -update-golden`.
var updateGolden = flag.Bool("update-golden", false, "rewrite the events golden file")

const goldenPath = "testdata/events_golden.jsonl"

// isolateEvents points every resolver tier at a temp tree, so no test can read
// or write the real ~/.shuttle stream. Returns the fake home.
func isolateEvents(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHUTTLE_EVENTS_FILE", "")
	t.Setenv("SHUTTLE_DATA_DIR", "")
	t.Setenv("SHUTTLE_EVENTS", "")
	t.Setenv("SHUTTLE_EVENTS_MAX_BYTES", "")
	t.Setenv("SHUTTLE_TMUX_SESSION", "test-session")
	t.Setenv("TMUX", "")
	// Pin identity: resolveOwnHost would otherwise reach os.Hostname().
	t.Setenv("SHUTTLE_HOST", "testhost")
	return home
}

// record feeds one payload to the hook and returns the lines the stream holds
// afterward.
func record(t *testing.T, path string, payload map[string]any) []map[string]any {
	t.Helper()
	writeEvent(t, payload)
	return readEventLines(t, path)
}

func writeEvent(t *testing.T, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if err := runEventHook(bytes.NewReader(raw)); err != nil {
		t.Fatalf("runEventHook: %v", err)
	}
}

func readEventLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line is not valid JSON: %v\n%s", err, line)
		}
		out = append(out, m)
	}
	return out
}

// TestEventTypeMapping pins the harness-name → stream-type table. The Elixir
// reader switches on these strings (waiting_tracker.ex category/1), so a
// renamed type silently reclassifies a worker's phase.
func TestEventTypeMapping(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	for name, want := range map[string]string{
		"PreToolUse":       "pre_tool_use",
		"PostToolUse":      "post_tool_use",
		"Stop":             "stop",
		"SubagentStop":     "subagent_stop",
		"SessionStart":     "session_start",
		"SessionEnd":       "session_end",
		"UserPromptSubmit": "user_prompt_submit",
		"Notification":     "notification",
	} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatalf("reset stream: %v", err)
		}
		lines := record(t, path, map[string]any{"hook_event_name": name, "session_id": "s1"})
		if len(lines) != 1 {
			t.Fatalf("%s: got %d lines, want 1", name, len(lines))
		}
		if lines[0]["type"] != want {
			t.Fatalf("%s: type = %v, want %q", name, lines[0]["type"], want)
		}
	}

	// An unlisted event name records nothing at all.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatalf("reset stream: %v", err)
	}
	if lines := record(t, path, map[string]any{"hook_event_name": "PreCompact"}); len(lines) != 0 {
		t.Fatalf("unknown event recorded %d lines, want 0", len(lines))
	}
}

// TestEventMachinePrompt: a prompt the harness injected is flagged; one a
// person typed is not. The flag is what lets the board stop drawing "you sent
// a message" over minutes nobody was awake for, and it can only be decided
// here — the daemon never sees the prompt text.
func TestEventMachinePrompt(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	for _, tc := range []struct {
		name   string
		prompt string
		want   bool
	}{
		{"task notification", "<task-notification> <task-id>abc</task-id> done", true},
		{"teammate message", `<teammate-message teammate_id="lead">go</teammate-message>`, true},
		{"relayed teammate message", "Another Claude session sent a message: <teammate-message>hi", true},
		{"system notification", "[SYSTEM NOTIFICATION] budget exhausted", true},
		{"leading whitespace still matches", "\n  <task-notification> x", true},
		// The dispatcher's opening prompt — the largest ongoing source of
		// spines claiming a message nobody wrote. All three variants share
		// this head; each is checked so a reworded tail cannot reopen the hole.
		{
			"dispatched onto a fiber",
			`The orchestration system Shuttle dispatched you on this fiber. The constitution describes what "done" looks like`,
			true,
		},
		{
			"dispatched for an ad-hoc role run",
			"The orchestration system Shuttle dispatched you for an ad-hoc run of this standing role — right-now work",
			true,
		},
		{
			"dispatched for a scheduled role run",
			"The orchestration system Shuttle dispatched you for a scheduled run of this standing role.",
			true,
		},
		// One keystroke, one spine: a slash command expands into up to three
		// submissions and only the `<command-name>` one is the person's act.
		{"slash-command caveat wrapper", "<local-command-caveat>Caveat: The messages below", true},
		{"slash-command stdout wrapper", "<local-command-stdout>(no content)</local-command-stdout>", true},
		{"the slash command itself is the person", "<command-name>/plugin</command-name>", false},
		// A human act with no words behind it — nothing a tooltip could show.
		{"interrupt marker", "[Request interrupted by user]", true},
		{"interrupt for tool use", "[Request interrupted by user for tool use]", true},
		{"loop tick", "# Autonomous loop tick (dynamic pacing)\n\nRun the autonomous check", true},
		// The dispatcher's other two injected openings — same module as the
		// dispatch preamble above, same defect if missed.
		{"resumed worker's wake-up prompt", "Shuttle resumed your previous session on this fiber. Skills and conventions", true},
		{"capture session framing", "Shuttle capture session. The user had an idea and spoke it", true},
		{"a person typing", "hey, can you look at the curve", false},
		// The reason this is a prefix test and not a search: quoting one of
		// these markers is something a person does all the time.
		{"a person quoting a marker", "i saw a <task-notification> in the logs", false},
		{"empty prompt", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				t.Fatalf("reset stream: %v", err)
			}
			lines := record(t, path, map[string]any{
				"hook_event_name": "UserPromptSubmit",
				"session_id":      "s1",
				"prompt":          tc.prompt,
			})
			if len(lines) != 1 {
				t.Fatalf("got %d lines, want 1", len(lines))
			}
			machine, present := lines[0]["machine"]
			if tc.want && machine != true {
				t.Fatalf("machine = %v (present %v), want true", machine, present)
			}
			// Omitted entirely when false, so an ordinary event's line is
			// byte-identical to what it has always been.
			if !tc.want && present {
				t.Fatalf("machine present on a typed prompt: %v", machine)
			}
		})
	}

	// Only prompts carry the flag: a tool event with the same text nearby must
	// not pick it up.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatalf("reset stream: %v", err)
	}
	lines := record(t, path, map[string]any{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
		"prompt":          "<task-notification> x",
		"tool_name":       "Bash",
	})
	if _, present := lines[0]["machine"]; present {
		t.Fatalf("machine flag leaked onto a tool event")
	}
}

// TestEventWriteGate: with no explicit path, the daemon's state directory is
// the opt-in. Absent, the hook writes nothing AND creates nothing — a felt
// user who never runs shuttle gets no surprise ~/.shuttle.
func TestEventWriteGate(t *testing.T) {
	home := isolateEvents(t)

	writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})

	if _, err := os.Stat(filepath.Join(home, ".shuttle")); !os.IsNotExist(err) {
		t.Fatalf("~/.shuttle was created (err=%v); the gate must not create it", err)
	}

	// Create it, and the same payload now lands.
	if err := os.Mkdir(filepath.Join(home, ".shuttle"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	if lines := readEventLines(t, filepath.Join(home, ".shuttle", "events.jsonl")); len(lines) != 1 {
		t.Fatalf("got %d lines after enabling, want 1", len(lines))
	}
}

// TestEventHookSeedsNothingWithoutStateDir pins the gate against the one path
// that can reach around it: renderEventLine resolves this machine's identity
// (for origin_name) BEFORE eventsSink consults the gate, and that resolution's
// last tier seeds ~/.shuttle/host. If the seed created its parent, one hook
// event on a felt-only machine would produce ~/.shuttle — and with it, from the
// next event on, a live stream nobody opted into.
func TestEventHookSeedsNothingWithoutStateDir(t *testing.T) {
	home := isolateEvents(t)
	// Undo the identity pin: this test needs the hostname tier, the only one
	// that writes.
	t.Setenv("SHUTTLE_HOST", "")
	t.Setenv("SHUTTLE_HOST_FILE", "")

	writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})

	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatalf("read fake home: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("hook created %v in a HOME with no ~/.shuttle; it must create nothing", names)
	}
}

// TestEventExplicitFileOverridesGate: SHUTTLE_EVENTS_FILE is explicit intent,
// so it creates its parent rather than declining to write. This is also what
// makes the bootstrap probe and these tests possible on a bare host.
func TestEventExplicitFileOverridesGate(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "nested", "deeper", "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	if lines := record(t, path, map[string]any{"hook_event_name": "Stop", "session_id": "s1"}); len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
}

// TestEventDataDirTier: SHUTTLE_DATA_DIR is the middle tier and is still
// gated — it names a directory the daemon owns, not a path the caller asked
// for.
func TestEventDataDirTier(t *testing.T) {
	isolateEvents(t)
	dataDir := filepath.Join(t.TempDir(), "shuttle-data")
	t.Setenv("SHUTTLE_DATA_DIR", dataDir)

	writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("SHUTTLE_DATA_DIR was created (err=%v); it is gated like the default", err)
	}

	if err := os.Mkdir(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	if lines := readEventLines(t, filepath.Join(dataDir, "events.jsonl")); len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
}

// TestEventKillSwitch: SHUTTLE_EVENTS=off wins over everything, including an
// explicit file — it is the "this host records nothing" switch.
func TestEventKillSwitch(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)
	t.Setenv("SHUTTLE_EVENTS", "off")

	if lines := record(t, path, map[string]any{"hook_event_name": "Stop", "session_id": "s1"}); len(lines) != 0 {
		t.Fatalf("kill switch recorded %d lines, want 0", len(lines))
	}
}

// TestEventFilePathNormalization pins the precedence the bash hook expressed
// in jq (file_path // path // filePath // files[0]). The board's thumbnail
// route and every raw-stream reader key on the normalized field.
func TestEventFilePathNormalization(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	cases := []struct {
		name      string
		toolInput map[string]any
		want      any // nil = no file_path key at all
	}{
		{"file_path wins", map[string]any{"file_path": "/a", "path": "/b", "filePath": "/c", "files": []string{"/d"}}, "/a"},
		{"path next", map[string]any{"path": "/b", "filePath": "/c", "files": []string{"/d"}}, "/b"},
		{"filePath next", map[string]any{"filePath": "/c", "files": []string{"/d"}}, "/c"},
		{"files[0] last", map[string]any{"files": []string{"/d", "/e"}}, "/d"},
		{"empty strings skipped", map[string]any{"file_path": "", "path": "/b"}, "/b"},
		{"no path at all", map[string]any{"command": "ls"}, nil},
		{"empty files array", map[string]any{"files": []string{}}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				t.Fatalf("reset: %v", err)
			}
			lines := record(t, path, map[string]any{
				"hook_event_name": "PreToolUse",
				"session_id":      "s1",
				"tool_name":       "Write",
				"tool_input":      tc.toolInput,
			})
			if len(lines) != 1 {
				t.Fatalf("got %d lines, want 1", len(lines))
			}
			ti, ok := lines[0]["toolInput"].(map[string]any)
			if !ok {
				t.Fatalf("toolInput is not an object: %v", lines[0]["toolInput"])
			}
			got, present := ti["file_path"]
			if tc.want == nil {
				if present {
					t.Fatalf("file_path = %v, want absent", got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("file_path = %v, want %v", got, tc.want)
			}
			// Non-path keys survive normalization.
			for k, v := range tc.toolInput {
				if k == "file_path" {
					continue
				}
				if _, ok := ti[k]; !ok {
					t.Fatalf("normalization dropped %q (was %v)", k, v)
				}
			}
		})
	}
}

// TestEventToolInputPresence: PreToolUse carries the one shared copy of a
// tool's payload, while PostToolUse carries the tool name that closes activity
// without duplicating paths/content. A non-tool event carries neither key.
func TestEventToolInputPresence(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	lines := record(t, path, map[string]any{
		"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Bash",
	})
	v, present := lines[0]["toolInput"]
	if !present || v != nil {
		t.Fatalf("toolInput = %v (present=%v), want present and null", v, present)
	}

	if err := os.Remove(path); err != nil {
		t.Fatalf("reset: %v", err)
	}
	lines = record(t, path, map[string]any{
		"hook_event_name": "PostToolUse", "session_id": "s1", "tool_name": "Bash",
		"tool_input": map[string]any{"command": "echo secret"},
	})
	if lines[0]["tool"] != "Bash" {
		t.Fatalf("post tool name = %v, want Bash", lines[0]["tool"])
	}
	if _, present := lines[0]["toolInput"]; present {
		t.Fatalf("post tool duplicated toolInput: %v", lines[0]["toolInput"])
	}

	if err := os.Remove(path); err != nil {
		t.Fatalf("reset: %v", err)
	}
	lines = record(t, path, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	if _, present := lines[0]["tool"]; present {
		t.Fatal("non-tool event carries a tool key")
	}
	if _, present := lines[0]["toolInput"]; present {
		t.Fatal("non-tool event carries a toolInput key")
	}
}

// TestEventHarnessDetection: the transcript path is the only discriminator the
// harnesses give us, and the PreToolUse gate reads it the same way.
func TestEventHarnessDetection(t *testing.T) {
	home := isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	for _, tc := range []struct {
		transcript string
		want       string
	}{
		{filepath.Join(home, ".claude", "projects", "x", "t.jsonl"), "claude-code"},
		{"", "codex"},
		{"/tmp/elsewhere/t.jsonl", "codex"},
		{filepath.Join(home, ".codex", "sessions", "t.jsonl"), "codex"},
	} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatalf("reset: %v", err)
		}
		lines := record(t, path, map[string]any{
			"hook_event_name": "Stop", "session_id": "s1", "transcript_path": tc.transcript,
		})
		if lines[0]["harness"] != tc.want {
			t.Fatalf("transcript %q → harness %v, want %q", tc.transcript, lines[0]["harness"], tc.want)
		}
	}
}

// TestEventOversizeToolInputTrimmed: a Write of a large file must not park its
// body in the stream. What a reader consumes — files, file_path — survives,
// and `truncated` says the rest did not.
func TestEventOversizeToolInputTrimmed(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	lines := record(t, path, map[string]any{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
		"tool_name":       "Write",
		"tool_input": map[string]any{
			"file_path": "/repo/big.txt",
			"files":     []string{"/repo/big.txt"},
			"content":   strings.Repeat("x", 64<<10),
		},
	})
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	ti := lines[0]["toolInput"].(map[string]any)
	if ti["truncated"] != true {
		t.Fatalf("truncated = %v, want true", ti["truncated"])
	}
	if ti["file_path"] != "/repo/big.txt" {
		t.Fatalf("file_path = %v, want /repo/big.txt", ti["file_path"])
	}
	if _, ok := ti["files"]; !ok {
		t.Fatal("files did not survive trimming — SentFiles reads it")
	}
	if _, ok := ti["content"]; ok {
		t.Fatal("content survived trimming")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(raw) > eventMaxLineBytes {
		t.Fatalf("trimmed line is %d bytes, want <= %d", len(raw), eventMaxLineBytes)
	}
}

// TestEventRotation: past the size bound the live file is renamed to .1 and a
// fresh one starts, so the stream is bounded without a cron job.
func TestEventRotation(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)
	t.Setenv("SHUTTLE_EVENTS_MAX_BYTES", "10")

	for i := 0; i < 3; i++ {
		writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": fmt.Sprintf("s%d", i)})
	}
	// Every line is over 10 bytes, so every write after the first rotates, and
	// each rotation replaces the previous .1 — the bound is two files, always.
	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("live file holds %d lines, want 1 (the newest)", len(lines))
	}
	if lines[0]["sessionId"] != "s2" {
		t.Fatalf("live line is %v, want the newest (s2)", lines[0]["sessionId"])
	}
	rotated := readEventLines(t, path+eventsRotatedSuffix)
	if len(rotated) != 1 || rotated[0]["sessionId"] != "s1" {
		t.Fatalf("rotated file = %v, want exactly the previous line (s1)", rotated)
	}
}

// TestEventDegenerateInput: a tracking hook must never fail a tool call. Every
// unusable payload is a silent, writeless pass.
func TestEventDegenerateInput(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	for _, in := range []string{"", "   ", "not json", "{", `{"hook_event_name":`, `[]`, `"a string"`, `{"hook_event_name":123}`} {
		if err := runEventHook(strings.NewReader(in)); err != nil {
			t.Fatalf("runEventHook(%q) = %v, want nil", in, err)
		}
	}
	if lines := readEventLines(t, path); len(lines) != 0 {
		t.Fatalf("degenerate payloads recorded %d lines, want 0", len(lines))
	}

	// A missing session_id still records — the stream is per-session, and
	// "unknown" is how the bash hook labeled an anonymous one.
	lines := record(t, path, map[string]any{"hook_event_name": "Stop"})
	if len(lines) != 1 || lines[0]["sessionId"] != "unknown" {
		t.Fatalf("sessionId = %v, want \"unknown\"", lines)
	}
}

// TestEventCommandIsSilent: the hook prints nothing on stdout. Claude Code
// parses hook stdout as an envelope; any stray byte is a protocol error.
func TestEventCommandIsSilent(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	out := captureStdout(t, func() {
		writeEvent(t, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	})
	if out != "" {
		t.Fatalf("hook wrote %q to stdout, want nothing", out)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	fn()
	os.Stdout = old
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatalf("read: %v", err)
	}
	return buf.String()
}

// TestEventConcurrentAppends: 50 real processes append at once. Single-write
// O_APPEND is atomic on Darwin and Linux, which is the whole reason the writer
// takes no lock — and the reason lines are size-bounded.
func TestEventConcurrentAppends(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns 50 processes")
	}
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)
	// Keep rotation out of it: this test is about append atomicity.
	t.Setenv("SHUTTLE_EVENTS_MAX_BYTES", "1000000000")

	const n = 50
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload := fmt.Sprintf(`{"hook_event_name":"PreToolUse","session_id":"s%d","tool_name":"Bash","tool_input":{"command":"%s"}}`,
				i, strings.Repeat("c", 200))
			cmd := exec.Command(os.Args[0], "-test.run=^TestEventHookHelperProcess$")
			cmd.Env = append(os.Environ(), "FELT_EVENT_HELPER=1")
			cmd.Stdin = strings.NewReader(payload)
			if out, err := cmd.CombinedOutput(); err != nil {
				errs <- fmt.Errorf("child %d: %v\n%s", i, err, out)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	lines := readEventLines(t, path) // fails the test on any non-JSON line
	if len(lines) != n {
		t.Fatalf("got %d lines, want %d", len(lines), n)
	}
	seen := map[string]bool{}
	for _, l := range lines {
		seen[l["sessionId"].(string)] = true
	}
	if len(seen) != n {
		t.Fatalf("got %d distinct sessions, want %d — a write was interleaved", len(seen), n)
	}
}

// TestEventHookHelperProcess is the child half of TestEventConcurrentAppends:
// a real `felt hook event` invocation, reached by re-execing the test binary
// so no build step is needed. It is inert unless FELT_EVENT_HELPER is set.
//
// "No build step" is a property of this binary's TestMain, not of re-exec, and
// the integration build tag once broke it: that TestMain compiles the CLI, so
// each of the 50 children compiled it again. cmd/integration_test.go now
// returns early when it sees FELT_EVENT_HELPER — if this variable is ever
// renamed, rename it there too.
func TestEventHookHelperProcess(t *testing.T) {
	if os.Getenv("FELT_EVENT_HELPER") != "1" {
		return
	}
	_ = runEventHook(os.Stdin)
	os.Exit(0)
}

// ----------------------------------------------------------------------------
// Cross-language parity
// ----------------------------------------------------------------------------

// goldenEvent is one recorded payload plus the tmux session it fired inside.
type goldenEvent struct {
	tmux    string
	payload map[string]any
}

// goldenEvents is the recorded session the parity fixture replays: a Claude
// worker that sends two files, writes a large file, and stops; a Codex worker
// that ends blocked on a human; a Claude worker that stops with two detached
// shells still running and is then hit by the idle timer; and a subagent that
// finishes.
//
// The Elixir side asserts the phases and the sent-files trail these produce
// (test/shuttle/events_parity_test.exs). Keep the two in step.
func goldenEvents(home string) []goldenEvent {
	const workerA = "depersonalize-01KVC1N5XMAAMYXDAGR4V6QA9G-shuttle"
	const workerB = "codex-01KVC1N5XMAAMYXDAGR4V6QAAA-shuttle"
	const workerC = "background-01KVC1N5XMAAMYXDAGR4V6QABB-shuttle"
	claudeTranscript := filepath.Join(home, ".claude", "projects", "felt", "t.jsonl")

	return []goldenEvent{
		{workerA, map[string]any{
			"hook_event_name": "SessionStart", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
		}},
		{workerA, map[string]any{
			"hook_event_name": "UserPromptSubmit", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
		}},
		{workerA, map[string]any{
			"hook_event_name": "PreToolUse", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
			"tool_name": "SendUserFile",
			// One relative path (the common case — SentFiles absolutizes it
			// against cwd) and one already-absolute.
			"tool_input": map[string]any{"files": []string{"results/frame.png", "/tmp/report.html"}},
		}},
		{workerA, map[string]any{
			"hook_event_name": "PreToolUse", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
			"tool_name": "Write",
			"tool_input": map[string]any{
				"file_path": "/repo/felt/big.md",
				"content":   strings.Repeat("y", 32<<10),
			},
		}},
		{workerA, map[string]any{
			"hook_event_name": "PostToolUse", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
			"tool_name":  "Edit",
			"tool_input": map[string]any{"path": "/repo/felt/small.md"},
		}},
		{workerA, map[string]any{
			"hook_event_name": "Stop", "session_id": "sess-a",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
		}},
		// Codex: no transcript_path, so harness is codex.
		{workerB, map[string]any{
			"hook_event_name": "SessionStart", "session_id": "sess-b", "cwd": "/repo/felt",
		}},
		{workerB, map[string]any{
			"hook_event_name": "PreToolUse", "session_id": "sess-b", "cwd": "/repo/felt",
			"tool_name": "Bash", "tool_input": map[string]any{"command": "ls"},
		}},
		{workerB, map[string]any{
			"hook_event_name": "Notification", "session_id": "sess-b", "cwd": "/repo/felt",
		}},
		// Worker C: a turn that ENDS WITH DETACHED WORK STILL RUNNING, then the
		// harness's own idle timer firing over it. Neither event means a human
		// is needed, and the two fields that say so — `background_tasks` on the
		// stop, `notification_type` on the notification — are what
		// WaitingTracker reads to keep it out of the attention column.
		{workerC, map[string]any{
			"hook_event_name": "Stop", "session_id": "sess-d",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
			"background_tasks": []map[string]any{
				{"id": "bc0hgilwx", "type": "local_bash", "status": "running"},
				{"id": "bczpx3urx", "type": "local_bash", "status": "running"},
			},
		}},
		{workerC, map[string]any{
			"hook_event_name": "Notification", "session_id": "sess-d",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
			"notification_type": "idle_prompt",
			"message":           "Claude is waiting for your input",
		}},
		// A subagent finishing in its own (untracked) session.
		{"", map[string]any{
			"hook_event_name": "SubagentStop", "session_id": "sess-c",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
		}},
	}
}

// TestBackgroundTaskCount: every shape the harness could send that we did not
// expect must yield a line, not a dropped event. A `stop` that fails to record
// is worse than a wrong count — a session whose stops vanish never reads as
// idle at all.
func TestBackgroundTaskCount(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tasks any
		want  float64
	}{
		{"two shells", []map[string]any{{"type": "local_bash"}, {"type": "local_bash"}}, 2},
		{"every running kind counts; the reader's bound limits a long-lived one",
			[]map[string]any{{"type": "monitor_ws"}, {"type": "local_agent"}}, 2},
		{"an entry with no type counts", []map[string]any{{"id": "x"}}, 1},
		{"empty", []map[string]any{}, 0},
		{"a reshaped payload counts nothing rather than dropping the line",
			map[string]any{"bc0hgilwx": "running"}, 0},
		{"a bare count counts nothing rather than dropping the line", 3, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolateEvents(t)
			path := filepath.Join(t.TempDir(), "events.jsonl")
			t.Setenv("SHUTTLE_EVENTS_FILE", path)

			lines := record(t, path, map[string]any{
				"hook_event_name": "Stop", "session_id": "s1", "background_tasks": tc.tasks,
			})
			got, present := lines[0]["backgroundTasks"]
			if tc.want == 0 {
				if present {
					t.Fatalf("backgroundTasks = %v, want omitted", got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("backgroundTasks = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestSubagentStopCarriesBackgroundTasks: SubagentStop carries the same field,
// and a worker whose last event is its subagent finishing is exactly the case
// the count exists to cover.
func TestSubagentStopCarriesBackgroundTasks(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	lines := record(t, path, map[string]any{
		"hook_event_name": "SubagentStop", "session_id": "s1",
		"background_tasks": []map[string]any{{"type": "local_bash"}},
	})
	if lines[0]["backgroundTasks"] != float64(1) {
		t.Fatalf("backgroundTasks = %v, want 1", lines[0]["backgroundTasks"])
	}
}

// TestNotificationKindRecorded: the harness's own discriminator, passed
// through. Without it the idle timer and a permission request are one event.
func TestNotificationKindRecorded(t *testing.T) {
	isolateEvents(t)
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	lines := record(t, path, map[string]any{
		"hook_event_name": "Notification", "session_id": "s1",
		"notification_type": "permission_prompt",
	})
	if lines[0]["notificationKind"] != "permission_prompt" {
		t.Fatalf("notificationKind = %v", lines[0]["notificationKind"])
	}

	// A harness that names nothing leaves the field off entirely.
	bare := record(t, path, map[string]any{"hook_event_name": "Notification", "session_id": "s2"})
	if _, present := bare[1]["notificationKind"]; present {
		t.Fatalf("notificationKind present on an unnamed notification")
	}
}

// TestEventGoldenParity pins the wire bytes. The same checked-in file is read
// by the Elixir readers in test/shuttle/events_parity_test.exs — one fixture,
// two languages, so writer drift fails a test instead of quietly emptying the
// board.
func TestEventGoldenParity(t *testing.T) {
	home := isolateEvents(t)

	// Freeze everything the line would otherwise pick up from the machine.
	base := time.UnixMilli(1753900000000).UTC()
	tick := 0
	oldNow, oldRand := eventNow, eventRand
	t.Cleanup(func() { eventNow, eventRand = oldNow, oldRand })
	eventNow = func() time.Time { return base.Add(time.Duration(tick) * time.Second) }
	eventRand = func() int { return 1000 + tick }
	// A generic host id: the fixture is tracked, and a real machine name in it
	// is exactly the thing this change removed from the rest of the tree.
	t.Setenv("SHUTTLE_HOST", "hub-a")

	var got bytes.Buffer
	for _, ev := range goldenEvents(home) {
		t.Setenv("SHUTTLE_TMUX_SESSION", ev.tmux)
		raw, err := json.Marshal(ev.payload)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		line, ok := renderEventLine(bytes.NewReader(raw))
		if !ok {
			t.Fatalf("payload recorded nothing: %v", ev.payload)
		}
		got.WriteString(line)
		tick++
	}

	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(goldenPath, got.Bytes(), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden (regenerate with -update-golden): %v", err)
	}
	if got.String() != string(want) {
		t.Fatalf("event stream drifted from %s.\n--- got ---\n%s\n--- want ---\n%s",
			goldenPath, got.String(), want)
	}
}

// TestEmptyTmuxSessionWithoutTmux: outside tmux the field is empty rather than
// absent — WaitingTracker keys on it, and a missing key is not a nil string.
func TestEmptyTmuxSessionWithoutTmux(t *testing.T) {
	isolateEvents(t)
	t.Setenv("SHUTTLE_TMUX_SESSION", "")
	t.Setenv("TMUX", "")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", path)

	lines := record(t, path, map[string]any{"hook_event_name": "Stop", "session_id": "s1"})
	v, present := lines[0]["tmuxSession"]
	if !present || v != "" {
		t.Fatalf("tmuxSession = %v (present=%v), want present and empty", v, present)
	}
}
