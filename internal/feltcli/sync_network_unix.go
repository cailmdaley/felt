//go:build unix

package feltcli

import (
	"os/exec"
	"syscall"
)

// Network cancellation reaps SSH/transport children as well as git. Local
// merges never install this cancellation hook or a CommandContext deadline.
func cancelSyncNetworkTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
