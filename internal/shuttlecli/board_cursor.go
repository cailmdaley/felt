package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pruneBoardCursors removes session cursors untouched for longer than the
// board's reach, which the daemon serves with every family read: past it the
// board holds nothing a cursor could still mark as seen.
func pruneBoardCursors(dir string, now time.Time, reach time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := now.Add(-reach)
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
