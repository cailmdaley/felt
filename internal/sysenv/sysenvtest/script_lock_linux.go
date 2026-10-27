package sysenvtest

import "syscall"

// A concurrent fork can inherit a close-on-exec writer until its child execs,
// making a freshly closed script fail with ETXTBSY. Exclude Go forks while
// the writer is open; ForkLock's write side is held during fork.
func lockScriptWrite() func() {
	syscall.ForkLock.RLock()
	return syscall.ForkLock.RUnlock
}
