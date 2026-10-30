// Package progstatus encodes OSC 7501 program status reports and writes them
// to terminal devices without waiting for output space.
package progstatus

import (
	"encoding/base64"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// Report describes one terminal program status record. An empty ID addresses
// the root record. Title and Msg are plain text, not base64.
type Report struct {
	State, Kind, App, ID, Title, Msg string
}

// Encode returns an OSC 7501 report terminated by ESC backslash, or nil for an
// unknown state. Invalid app and id values are omitted. Kind is emitted only
// for a blocked state and a recognized kind. Text is single-line UTF-8, bounded
// to 192 decoded bytes for Title and 2048 for Msg.
func (r Report) Encode() []byte {
	switch r.State {
	case "idle", "working", "done", "blocked", "error", "clear":
	default:
		return nil
	}

	var b strings.Builder
	b.WriteString("\x1b]7501;state=")
	b.WriteString(r.State)
	if r.State == "blocked" {
		switch r.Kind {
		case "permission", "question", "auth":
			b.WriteString(":kind=")
			b.WriteString(r.Kind)
		}
	}
	if validSegment(r.App) {
		b.WriteString(":app=")
		b.WriteString(r.App)
	}
	if validID(r.ID) {
		b.WriteString(":id=")
		b.WriteString(r.ID)
	}
	if r.Title != "" {
		b.WriteString(":title=")
		b.WriteString(base64.StdEncoding.EncodeToString([]byte(singleLine(r.Title, 192))))
	}
	if r.Msg != "" {
		b.WriteString(":msg=")
		b.WriteString(base64.StdEncoding.EncodeToString([]byte(singleLine(r.Msg, 2048))))
	}
	b.WriteString("\x1b\\")
	return []byte(b.String())
}

func validSegment(s string) bool {
	if len(s) == 0 || len(s) > 32 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '.' || c == '+' || c == '-') {
			return false
		}
	}
	return true
}

func validID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	segments := strings.Split(s, "/")
	if len(segments) > 8 {
		return false
	}
	for _, segment := range segments {
		if !validSegment(segment) {
			return false
		}
	}
	return true
}

func singleLine(s string, limit int) string {
	var b strings.Builder
	for _, r := range s {
		if r <= 0x1f || r >= 0x7f && r <= 0x9f {
			r = ' '
		}
		if b.Len()+utf8.RuneLen(r) > limit {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

// WrapTmux wraps seq in a tmux DCS passthrough, doubling each embedded ESC.
func WrapTmux(seq []byte) []byte {
	b := make([]byte, 0, len(seq)+16)
	b = append(b, "\x1bPtmux;"...)
	for _, c := range seq {
		b = append(b, c)
		if c == 0x1b {
			b = append(b, c)
		}
	}
	return append(b, '\x1b', '\\')
}

// Write opens path independently of the agent's descriptors and attempts one
// nonblocking write. It returns EAGAIN for a full terminal and io.ErrShortWrite
// for a partial report; it never retries. Raw Unix I/O avoids os.File.Write's
// readiness polling, which can wait for space even with O_NONBLOCK.
func Write(path string, b []byte) error {
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer unix.Close(fd)
	n, err := unix.Write(fd, b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return &os.PathError{Op: "write", Path: path, Err: err}
	}
	return nil
}
