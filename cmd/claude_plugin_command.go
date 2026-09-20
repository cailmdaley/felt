package cmd

import (
	"os"
	"os/exec"
	"strings"
)

// claudePluginCommand runs plugin maintenance in bare mode: Claude does not
// read subscription OAuth credentials or the system keychain. These flags are
// scoped to the child process; normal worker sessions retain their own settings.
func claudePluginCommand(args ...string) *exec.Cmd {
	command := exec.Command("claude", append([]string{"plugin"}, args...)...)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER":
			continue
		}
		command.Env = append(command.Env, entry)
	}
	command.Env = append(command.Env,
		"CLAUDE_CODE_SIMPLE=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
	)
	return command
}
