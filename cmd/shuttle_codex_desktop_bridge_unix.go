//go:build !windows

package cmd

import (
	"os"
	"syscall"
)

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
