package felt

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"

	"github.com/cailmdaley/felt/internal/atomicfile"
)

// A move journal retains reference-resolution context rather than document
// images. Replaying it patches current documents and cannot restore an old body.
type moveJournal struct {
	OldID   string
	NewID   string
	Inside  moveRewriteGroup
	Outside moveRewriteGroup
}
type moveRewriteGroup struct {
	Context *moveRewriteContext
	Writes  []moveRewrite
}
type moveRewrite struct {
	ID           string
	Path         string
	SourceOld    string
	BeforeSHA256 string
	AfterSHA256  string
	Done         bool
}

func moveDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (s *Storage) moveJournalPath() string { return filepath.Join(s.root, ".move-pending.json") }
func (s *Storage) saveMove(oldID, newID string, inside, outside []pendingWrite) error {
	convert := func(writes []pendingWrite) moveRewriteGroup {
		result := moveRewriteGroup{}
		for _, w := range writes {
			result.Context = w.context
			result.Writes = append(result.Writes, moveRewrite{ID: w.id, Path: w.path, SourceOld: w.sourceOld})
		}
		return result
	}
	journal := &moveJournal{oldID, newID, convert(inside), convert(outside)}
	return s.writeMoveJournal(journal)
}

func (s *Storage) writeMoveJournal(journal *moveJournal) error {
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	return atomicfile.Write(s.moveJournalPath(), data, 0644)
}
func (s *Storage) finishMove() error { return os.Remove(s.moveJournalPath()) }

// PendingMove returns the canonical endpoints of an unfinished move, or empty
// endpoints when no journal exists.
func (s *Storage) PendingMove() (string, string, error) {
	data, err := os.ReadFile(s.moveJournalPath())
	if os.IsNotExist(err) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	var journal moveJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return "", "", err
	}
	return journal.OldID, journal.NewID, nil
}

// AbandonMove removes only the recovery journal. It neither rolls back the
// subtree nor edits references; the caller takes responsibility for those.
func (s *Storage) AbandonMove() error {
	unlock, err := LockFiberFile(s.moveJournalPath())
	if err != nil {
		return err
	}
	defer unlock()
	return s.finishMove()
}

// An interrupted move is resumed by repeating the same move command. A different
// move is refused while its reference rewrites are pending.
func (s *Storage) recoverMove(oldID, newID string) (*MoveResult, bool, error) {
	data, err := os.ReadFile(s.moveJournalPath())
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	var journal moveJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return nil, true, err
	}
	if journal.OldID != oldID || journal.NewID != newID {
		return nil, true, fmt.Errorf("unfinished move %s -> %s; repeat that move to finish its rewrites", journal.OldID, journal.NewID)
	}
	oldRoot := filepath.Join(s.root, filepath.FromSlash(oldID))
	newRoot := filepath.Join(s.root, filepath.FromSlash(newID))
	if _, err := os.Stat(oldRoot); err == nil {
		if err := os.Rename(oldRoot, newRoot); err != nil {
			return nil, true, err
		}
	} else if !os.IsNotExist(err) {
		return nil, true, err
	}
	// A leaf change also changes the fiber document's basename. Keep this
	// step replayable independently of the directory rename.
	if path.Base(oldID) != path.Base(newID) {
		oldDocument := filepath.Join(newRoot, path.Base(oldID)+".md")
		if _, err := os.Stat(oldDocument); err == nil {
			if err := os.Rename(oldDocument, s.Path(newID)); err != nil {
				return nil, true, err
			}
		} else if !os.IsNotExist(err) {
			return nil, true, err
		}
	}
	s.forgetWalk()
	result := &MoveResult{}
	for _, group := range []struct {
		rewrites *moveRewriteGroup
		ids      *[]string
	}{{&journal.Inside, &result.Rewritten}, {&journal.Outside, &result.Outside}} {
		for i := range group.rewrites.Writes {
			w := &group.rewrites.Writes[i]
			if !w.Done {
				if err := (pendingWrite{w.ID, w.Path, w.SourceOld, group.rewrites.Context}).writeJournaled(s, w, &journal); err != nil {
					return result, true, fmt.Errorf("unfinished move; repeat %s -> %s: %w", oldID, newID, err)
				}
				w.Done = true
				if err := s.writeMoveJournal(&journal); err != nil {
					return result, true, err
				}
			}
			*group.ids = append(*group.ids, w.ID)
		}
		sort.Strings(*group.ids)
	}
	if err := s.finishMove(); err != nil {
		return result, true, err
	}
	return result, true, s.pruneEmptyDirs(filepath.Dir(oldRoot))
}
