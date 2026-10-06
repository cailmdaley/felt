package feltcli

import (
	"os/exec"
	"strings"
)

// claudePluginCommand runs plugin maintenance in bare mode: Claude does not
// read subscription OAuth credentials or the system keychain. These flags are
// scoped to the child process; normal worker sessions retain their own settings.
func (a *app) claudePluginCommand(args ...string) *exec.Cmd {
	command := a.env.Command("claude", append([]string{"plugin"}, args...)...)
	var environ []string
	for _, entry := range a.env.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER":
			continue
		}
		environ = append(environ, entry)
	}
	command.Env = append(environ,
		"CLAUDE_CODE_SIMPLE=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
	)
	return command
}
