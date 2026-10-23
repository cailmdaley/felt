//go:build windows

package shuttlecli

import (
	"os/exec"
	"syscall"
)

func configureTranscriptIndexProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200}
}
