package felt

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/cailmdaley/felt/internal/atomicfile"
)

// A move journal retains reference substitutions rather than document images.
// Replaying it patches the current documents and cannot restore an old body.
type moveJournal struct {
	OldID   string
	NewID   string
	Inside  []moveRewrite
	Outside []moveRewrite
}
type moveRewrite struct {
	ID           string
	Path         string
	Replacements map[string]string
}

func (s *Storage) moveJournalPath() string { return filepath.Join(s.root, ".move-pending.json") }
func (s *Storage) saveMove(oldID, newID string, inside, outside []pendingWrite) error {
	convert := func(writes []pendingWrite) []moveRewrite {
		result := make([]moveRewrite, 0, len(writes))
		for _, w := range writes {
			result = append(result, moveRewrite{w.id, w.path, w.replacements})
		}
		return result
	}
	data, err := json.Marshal(moveJournal{oldID, newID, convert(inside), convert(outside)})
	if err != nil {
		return err
	}
	return atomicfile.Write(s.moveJournalPath(), data, 0644)
}
func (s *Storage) finishMove() error { return os.Remove(s.moveJournalPath()) }

// An interrupted move is resumed by repeating the same nest command. A different
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
	s.forgetWalk()
	result := &MoveResult{}
	for _, group := range []struct {
		writes []moveRewrite
		ids    *[]string
	}{{journal.Inside, &result.Rewritten}, {journal.Outside, &result.Outside}} {
		for _, w := range group.writes {
			if err := (pendingWrite{w.ID, w.Path, w.Replacements}).write(s); err != nil {
				return result, true, fmt.Errorf("unfinished move; repeat %s -> %s: %w", oldID, newID, err)
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
