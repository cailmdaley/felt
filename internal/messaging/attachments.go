package messaging

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"
)

const (
	MaxAttachmentBytes = 20 << 20
	MaxAttachments     = 8
	MaxRequestFrame    = 32 << 20
)

func ReadAttachments(paths []string) ([]Attachment, error) {
	if len(paths) > MaxAttachments {
		return nil, errCode("invalid_request", "at most %d attachments are allowed", MaxAttachments)
	}
	attachments := make([]Attachment, 0, len(paths))
	remaining := int64(MaxAttachmentBytes)
	for _, path := range paths {
		name := filepath.Base(path)
		if err := validateAttachmentName(name); err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("inspect attachment %q: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return nil, errCode("invalid_request", "attachment %q is not a regular file", path)
		}
		fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, fmt.Errorf("read attachment %q: %w", path, err)
		}
		f := os.NewFile(uintptr(fd), path)
		if f == nil {
			syscall.Close(fd)
			return nil, fmt.Errorf("read attachment %q", path)
		}
		info, statErr := f.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			f.Close()
			if statErr != nil {
				return nil, fmt.Errorf("inspect attachment %q: %w", path, statErr)
			}
			return nil, errCode("invalid_request", "attachment %q is not a regular file", path)
		}
		if info.Size() > remaining {
			f.Close()
			return nil, errCode("invalid_request", "attachments exceed %d bytes", MaxAttachmentBytes)
		}
		data, readErr := io.ReadAll(io.LimitReader(f, remaining+1))
		closeErr := f.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read attachment %q: %w", path, readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close attachment %q: %w", path, closeErr)
		}
		if int64(len(data)) > remaining {
			return nil, errCode("invalid_request", "attachments exceed %d bytes", MaxAttachmentBytes)
		}
		remaining -= int64(len(data))
		digest := sha256.Sum256(data)
		attachments = append(attachments, Attachment{Name: name, Data: data, SHA256: hex.EncodeToString(digest[:])})
	}
	return attachments, nil
}

func validateAttachments(attachments []Attachment) error {
	if len(attachments) > MaxAttachments {
		return errCode("invalid_request", "at most %d attachments are allowed", MaxAttachments)
	}
	total := 0
	for _, attachment := range attachments {
		if err := validateAttachmentName(attachment.Name); err != nil {
			return err
		}
		if len(attachment.Data) > MaxAttachmentBytes-total {
			return errCode("invalid_request", "attachments exceed %d bytes", MaxAttachmentBytes)
		}
		total += len(attachment.Data)
		digest := sha256.Sum256(attachment.Data)
		if len(attachment.SHA256) != sha256.Size*2 || attachment.SHA256 != hex.EncodeToString(digest[:]) {
			return errCode("invalid_request", "attachment %q has an invalid sha256", attachment.Name)
		}
	}
	return nil
}

func validateAttachmentName(name string) error {
	if name == "" || len(name) > 255 || !utf8.ValidString(name) || name == "." || name == ".." || strings.ContainsAny(name, `/\\`) {
		return errCode("invalid_request", "invalid attachment name %q", name)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return errCode("invalid_request", "invalid attachment name %q", name)
		}
	}
	return nil
}

func materializeAttachments(messageID string, attachments []Attachment) ([]ReceivedFile, error) {
	if len(attachments) == 0 {
		return nil, nil
	}
	idHash := sha256.Sum256([]byte(messageID))
	root, err := filepath.Abs(dataDir())
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "message-files", hex.EncodeToString(idHash[:]))
	if err := ensureDir(dir, 0700); err != nil {
		return nil, err
	}
	files := make([]ReceivedFile, 0, len(attachments))
	for i, attachment := range attachments {
		attachmentDir := filepath.Join(dir, fmt.Sprintf("%02d", i+1))
		if err := ensureDir(attachmentDir, 0700); err != nil {
			return files, err
		}
		path := filepath.Join(attachmentDir, attachment.Name)
		if err := materializeAttachment(path, attachmentDir, attachment); err != nil {
			return files, err
		}
		files = append(files, ReceivedFile{Name: attachment.Name, Path: path, SHA256: attachment.SHA256, Size: int64(len(attachment.Data))})
	}
	return files, nil
}

func materializeAttachment(path, dir string, attachment Attachment) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("attachment destination %q is not a regular file", path)
		}
		return verifyMaterialized(path, attachment)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".attachment-")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(attachment.Data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Link(tmpPath, path); errors.Is(err, os.ErrExist) {
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("attachment destination %q is not a regular file", path)
		}
		return verifyMaterialized(path, attachment)
	}
	if err != nil {
		return err
	}
	if err = os.Remove(tmpPath); err != nil {
		return err
	}
	return syncDir(dir)
}

func verifyMaterialized(path string, attachment Attachment) error {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), path)
	if f == nil {
		syscall.Close(fd)
		return fmt.Errorf("open attachment destination %q", path)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("attachment destination %q is not a regular file", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(MaxAttachmentBytes)+1))
	if err != nil {
		return err
	}
	if len(b) > MaxAttachmentBytes {
		return fmt.Errorf("attachment destination %q exceeds bound", path)
	}
	digest := sha256.Sum256(b)
	if len(b) != len(attachment.Data) || hex.EncodeToString(digest[:]) != attachment.SHA256 {
		return fmt.Errorf("attachment destination %q has different content", path)
	}
	return nil
}

func renderAttachmentText(text string, files []ReceivedFile) (string, error) {
	if len(files) == 0 {
		return text, nil
	}
	var b strings.Builder
	if text != "" {
		b.WriteString(text)
		b.WriteString("\n\n")
	}
	b.WriteString("[Attached files available on this receiver]\n")
	for _, file := range files {
		fmt.Fprintf(&b, "- %s (%d bytes, sha256 %s): %s\n", file.Name, file.Size, file.SHA256, file.Path)
	}
	rendered := strings.TrimSuffix(b.String(), "\n")
	if len(rendered) > 64<<10 || strings.ContainsRune(rendered, 0) {
		return "", errCode("invalid_request", "message text with attachment references exceeds 65536 bytes")
	}
	return rendered, nil
}
