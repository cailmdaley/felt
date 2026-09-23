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

func configureCurrentBridgeProcess() error {
	if syscall.Getpgrp() == os.Getpid() {
		return nil
	}
	return syscall.Setpgid(0, 0)
}

func signalBridgeProcessGroup(pid int, sig syscall.Signal) error {
	return syscall.Kill(-pid, sig)
}

func sameUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint64(stat.Uid) == uint64(os.Getuid())
}
