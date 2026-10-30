package messaging

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

func unlockProcessPTY(t *testing.T, master int) string {
	t.Helper()
	for _, req := range []uint{unix.TIOCPTYGRANT, unix.TIOCPTYUNLK} {
		if err := unix.IoctlSetInt(master, req, 0); err != nil {
			t.Fatal(err)
		}
	}
	var name [128]byte
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(master), unix.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		t.Fatal(errno)
	}
	return unix.ByteSliceToString(name[:])
}
