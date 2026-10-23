package shuttlecli

import (
	"time"
)

// SessionEnd indexing is advisory: the hook never waits for the file walk or
// reports a failure to the harness.
func (a *app) startTranscriptIndexHook(input eventHookInput) error {
	harness := input.Harness
	if harness != "claude" && harness != "codex" && harness != "pi" {
		harness = a.messageHookHarness(input)
	}
	if harness == "" {
		return nil
	}
	binary, err := a.env.LookPath("shuttle")
	if err != nil {
		return err
	}
	cmd := a.env.Command(binary, "transcript", "index", "--file", input.TranscriptPath, "--harness", harness)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = nil, nil, nil
	cmd.WaitDelay = 2 * time.Second
	configureTranscriptIndexProcess(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
