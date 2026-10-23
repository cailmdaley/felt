//go:build !windows

package shuttlecli

import (
	"os/exec"
	"syscall"
)

func configureTranscriptIndexProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
