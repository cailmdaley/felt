package cmd

import "syscall"

// dupOnto points fd newfd at oldfd's file. linux/arm64 has no dup2 syscall,
// so Linux uses dup3 everywhere.
func dupOnto(oldfd, newfd int) error { return syscall.Dup3(oldfd, newfd, 0) }
