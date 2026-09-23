//go:build !windows

package cmd

import (
	"os"
	"os/exec"
	"syscall"
)

func configureBridgeChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func signalBridgeChild(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	// Setpgid makes the child's process group private to this invocation. A
	// negative pid therefore reaches descendants without touching the wrapper
	// process or an unrelated Codex instance.
	return syscall.Kill(-cmd.Process.Pid, sig)
}

func sameUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint64(stat.Uid) == uint64(os.Getuid())
}
