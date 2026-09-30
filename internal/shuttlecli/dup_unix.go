//go:build !windows && !linux

package shuttlecli

import "syscall"

// dupOnto points fd newfd at oldfd's file.
func dupOnto(oldfd, newfd int) error { return syscall.Dup2(oldfd, newfd) }
