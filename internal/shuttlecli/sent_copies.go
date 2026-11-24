package shuttlecli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A send takes a copy. The sending process, which can read the file, copies it
// into sent-files/ beside the event stream that records the send, and the
// event names each copy under its original path (`copies`). The owner's daemon
// serves a sent path from its copy when it cannot read the original: a folder
// macOS keeps from launchd processes, or a scratch directory a reboot cleared
// (daemon/lib/shuttle_web/controllers/file_controller.ex).
//
// Copies are content-addressed and named <sha256><ext>, so a copy keeps its
// file type and a re-send of the same bytes reuses it, refreshing its mtime.
// Each send removes copies untouched for sentCopyRetention; a send older than
// that, like a file over sentCopyMaxBytes, is served from its original alone.
const (
	sentCopiesDir     = "sent-files"
	sentCopyMaxBytes  = 256 << 20
	sentCopyRetention = 30 * 24 * time.Hour
)

// copySentFiles copies each of paths, which are absolute, into the copy store
// beside sink and returns each copied path's copy. A file over
// sentCopyMaxBytes is left uncopied; any other failure is returned.
func copySentFiles(sink string, paths []string) (map[string]string, error) {
	dir, err := sentCopyStore(sink)
	if err != nil {
		return nil, err
	}
	copies := map[string]string{}
	for _, path := range paths {
		stored, err := takeSentCopy(dir, path)
		if err != nil {
			return nil, err
		}
		if stored != "" {
			copies[path] = stored
		}
	}
	pruneSentCopies(dir, time.Now())
	return copies, nil
}

// copyToolFiles copies the files a harness's SendUserFile call sends. The hook
// runs inside the worker's harness, with its access to the files. A file it
// cannot copy is still recorded by the call, served from its original alone.
func (a *app) copyToolFiles(input eventHookInput) map[string]string {
	var tool struct {
		Files []string `json:"files"`
	}
	if json.Unmarshal(input.ToolInput, &tool) != nil || len(tool.Files) == 0 {
		return nil
	}
	sink, enabled := a.eventsSink()
	if !enabled {
		return nil
	}
	dir, err := sentCopyStore(sink)
	if err != nil {
		return nil
	}
	copies := map[string]string{}
	for _, file := range tool.Files {
		path := a.sentPath(file, input.CWD)
		if stored, err := takeSentCopy(dir, path); err == nil && stored != "" {
			copies[path] = stored
		}
	}
	pruneSentCopies(dir, time.Now())
	return copies
}

// sentCopyStore is the copy store beside the event stream sink, created
// private to this user.
func sentCopyStore(sink string) (string, error) {
	dir := filepath.Join(filepath.Dir(sink), sentCopiesDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("copy store: %w", err)
	}
	return dir, nil
}

// takeSentCopy copies one regular file into dir under its content digest, or
// returns "" for a file over sentCopyMaxBytes. A FIFO or directory is refused
// before it is opened, so a send never waits on a writer that never comes.
func takeSentCopy(dir, path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat artifact: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("artifact is not a regular file: %s", path)
	}
	if info.Size() > sentCopyMaxBytes {
		return "", nil
	}
	src, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("read artifact: %w", err)
	}
	defer src.Close()
	tmp, err := os.CreateTemp(dir, ".copy-")
	if err != nil {
		return "", fmt.Errorf("copy artifact: %w", err)
	}
	defer os.Remove(tmp.Name())
	digest := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, digest), src)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("copy artifact %s: %w", path, err)
	}
	stored := filepath.Join(dir, hex.EncodeToString(digest.Sum(nil))+filepath.Ext(path))
	if _, err := os.Stat(stored); err == nil {
		now := time.Now()
		return stored, os.Chtimes(stored, now, now)
	}
	if err := os.Rename(tmp.Name(), stored); err != nil {
		return "", fmt.Errorf("copy artifact %s: %w", path, err)
	}
	return stored, nil
}

// pruneSentCopies removes the copies, and any abandoned partial copy, last
// touched before the retention window.
func pruneSentCopies(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > sentCopyRetention {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}

// sentPath is a harness-sent path made absolute the way the daemon's
// Shuttle.SentFiles makes it: against the sender's cwd, with a leading ~
// naming the home directory.
func (a *app) sentPath(path, cwd string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := a.env.UserHomeDir(); err == nil {
			return filepath.Join(home, path[1:])
		}
	}
	if filepath.IsAbs(path) || cwd == "" {
		return path
	}
	return filepath.Join(cwd, path)
}
