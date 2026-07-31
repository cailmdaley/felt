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

// TestEventWriteGate: with no explicit path, the daemon's state directory is
// the opt-in. Absent, the hook writes nothing AND creates nothing — a felt
// user who never runs Shuttle gets no surprise ~/.shuttle.
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

// TestEventToolInputPresence: `toolInput` tracks the TOOL's presence, not the
// input's — a tool event with no tool_input records null, matching jq's
// `.tool_input // null`. A non-tool event carries neither key.
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
// that ends blocked on a human; and a subagent that finishes.
//
// The Elixir side asserts the phases and the sent-files trail these produce
// (test/shuttle/events_parity_test.exs). Keep the two in step.
func goldenEvents(home string) []goldenEvent {
	const workerA = "depersonalize-01KVC1N5XMAAMYXDAGR4V6QA9G-shuttle"
	const workerB = "codex-01KVC1N5XMAAMYXDAGR4V6QAAA-shuttle"
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
		// A subagent finishing in its own (untracked) session.
		{"", map[string]any{
			"hook_event_name": "SubagentStop", "session_id": "sess-c",
			"cwd": "/repo/felt", "transcript_path": claudeTranscript,
		}},
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
