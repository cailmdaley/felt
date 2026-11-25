package shuttlecli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A send takes a copy. The sending process, which can read the file, copies it
// into sent-files/ beside the event stream that records the send, and the
// event names each copy's basename under its original path (`copies`). The
// owner's daemon serves a sent path from its copy when it cannot read the
// original: a folder macOS keeps from launchd processes, or a scratch
// directory a reboot cleared
// (daemon/lib/shuttle_web/controllers/file_controller.ex).
//
// Copies are content-addressed and named <sha256><ext>, so a re-send of the
// same bytes replaces one copy with a fresh one. The extension is kept when it
// is a short alphanumeric one, and dropped otherwise. A send, at most once per
// sentCopyPruneEvery, removes copies untouched for sentCopyRetention; a send
// older than that, like a file over sentCopyMaxBytes, is served from its
// original alone. Renames into the store and the prune hold the store's lock,
// so a prune never removes a copy a concurrent send has just renewed.
const (
	sentCopiesDir      = "sent-files"
	sentCopyMaxBytes   = 256 << 20
	sentCopyRetention  = 30 * 24 * time.Hour
	sentCopyPruneEvery = time.Hour
	// sentCopyNameMax is the longest copy name: a digest and a dot with
	// sixteen extension characters.
	sentCopyNameMax = sha256.Size*2 + 17
	// hookCopyBudget bounds the copying a SendUserFile hook does before its
	// harness's tool call goes ahead; a file it has not copied by then is
	// recorded without a copy.
	hookCopyBudget = 10 * time.Second
)

var sentCopyExt = regexp.MustCompile(`^\.[A-Za-z0-9]{1,16}$`)

// stagedCopy is a file copied into the store under a temporary name, with
// the name it is kept under.
type stagedCopy struct{ tmp, name string }

// copySentFiles copies each of paths, which are absolute, into the copy store
// beside sink and returns each copied path's copy name. A file over
// sentCopyMaxBytes is left uncopied; any other failure is returned.
func (a *app) copySentFiles(sink string, paths []string) (map[string]string, error) {
	dir, err := sentCopyStore(sink)
	if err != nil {
		return nil, err
	}
	staged := map[string]stagedCopy{}
	defer discardStaged(staged)
	for _, path := range paths {
		staging, err := stageSentCopy(dir, path, time.Time{})
		if err != nil {
			return nil, err
		}
		if staging.tmp != "" {
			staged[path] = staging
		}
	}
	return a.keepSentCopies(dir, staged)
}

// copyToolFiles copies the files a harness's SendUserFile call sends. The hook
// runs inside the worker's harness, with its access to the files, and before
// the tool call goes ahead, so it copies within hookCopyBudget. A file it
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
	deadline := time.Now().Add(hookCopyBudget)
	staged := map[string]stagedCopy{}
	defer discardStaged(staged)
	for _, file := range tool.Files {
		path := a.sentPath(file, input.CWD)
		if time.Now().After(deadline) {
			break
		}
		if !filepath.IsAbs(path) {
			continue
		}
		if staging, err := stageSentCopy(dir, path, deadline); err == nil && staging.tmp != "" {
			staged[path] = staging
		}
	}
	copies, _ := a.keepSentCopies(dir, staged)
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

// stageSentCopy copies one regular file into dir under a temporary name and
// returns it with the name it is to be kept under, or a zero stagedCopy for a
// file over sentCopyMaxBytes. A FIFO or directory is refused before it is
// opened, so a send never waits on a writer that never comes; the opened file
// is checked again, so a file swapped in between is refused too. Copying stops
// at deadline, when it is not zero.
func stageSentCopy(dir, path string, deadline time.Time) (stagedCopy, error) {
	if info, err := os.Stat(path); err != nil {
		return stagedCopy{}, fmt.Errorf("stat artifact: %w", err)
	} else if !info.Mode().IsRegular() {
		return stagedCopy{}, fmt.Errorf("artifact is not a regular file: %s", path)
	}
	src, err := os.Open(path)
	if err != nil {
		return stagedCopy{}, fmt.Errorf("read artifact: %w", err)
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return stagedCopy{}, fmt.Errorf("stat artifact: %w", err)
	}
	if !info.Mode().IsRegular() {
		return stagedCopy{}, fmt.Errorf("artifact is not a regular file: %s", path)
	}
	if info.Size() > sentCopyMaxBytes {
		return stagedCopy{}, nil
	}
	tmp, err := os.CreateTemp(dir, ".copy-")
	if err != nil {
		return stagedCopy{}, fmt.Errorf("copy artifact: %w", err)
	}
	digest := sha256.New()
	var from io.Reader = io.LimitReader(src, sentCopyMaxBytes+1)
	if !deadline.IsZero() {
		from = deadlineReader{from, deadline}
	}
	n, err := io.Copy(io.MultiWriter(tmp, digest), from)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil || n > sentCopyMaxBytes {
		_ = os.Remove(tmp.Name())
		if err != nil {
			return stagedCopy{}, fmt.Errorf("copy artifact %s: %w", path, err)
		}
		return stagedCopy{}, nil
	}
	name := hex.EncodeToString(digest.Sum(nil))
	if ext := filepath.Ext(path); sentCopyExt.MatchString(ext) {
		name += ext
	}
	return stagedCopy{tmp: tmp.Name(), name: name}, nil
}

// keepSentCopies renames each staged copy to its name, replacing any copy of
// the same bytes with a fresh one, and prunes the store when a prune is due,
// all under the store's lock. It returns each path's copy name.
func (a *app) keepSentCopies(dir string, staged map[string]stagedCopy) (map[string]string, error) {
	if len(staged) == 0 {
		return nil, nil
	}
	unlock, locked := lockEventsRotation(filepath.Join(dir, ".lock"), a.eventsLockWait)
	if locked {
		defer unlock()
	}
	copies := map[string]string{}
	for path, staging := range staged {
		if err := os.Rename(staging.tmp, filepath.Join(dir, staging.name)); err != nil {
			return nil, fmt.Errorf("copy artifact %s: %w", path, err)
		}
		copies[path] = staging.name
	}
	if locked {
		pruneSentCopies(dir, time.Now())
	}
	return copies, nil
}

// discardStaged removes the temporary files of copies never kept.
func discardStaged(staged map[string]stagedCopy) {
	for _, staging := range staged {
		_ = os.Remove(staging.tmp)
	}
}

// pruneSentCopies removes the copies, and any abandoned partial copy, last
// touched before the retention window, at most once per sentCopyPruneEvery.
// The caller holds the store's lock.
func pruneSentCopies(dir string, now time.Time) {
	marker := filepath.Join(dir, ".pruned")
	if info, err := os.Stat(marker); err == nil && now.Sub(info.ModTime()) < sentCopyPruneEvery {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(name, ".copy-") {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > sentCopyRetention {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
	if os.Chtimes(marker, now, now) != nil {
		_ = os.WriteFile(marker, nil, 0o600)
	}
}

// deadlineReader fails a read once its deadline has passed.
type deadlineReader struct {
	r        io.Reader
	deadline time.Time
}

var errCopyBudget = errors.New("copy budget spent")

func (d deadlineReader) Read(p []byte) (int, error) {
	if time.Now().After(d.deadline) {
		return 0, errCopyBudget
	}
	return d.r.Read(p)
}

// sentPath is a harness-sent path made absolute the way the daemon's
// Shuttle.SentFiles makes it: against the sender's cwd, with a leading ~
// naming the home directory, and cleaned.
func (a *app) sentPath(path, cwd string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := a.env.UserHomeDir(); err == nil {
			return filepath.Join(home, path[1:])
		}
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	if cwd == "" {
		return path
	}
	return filepath.Join(cwd, path)
}
