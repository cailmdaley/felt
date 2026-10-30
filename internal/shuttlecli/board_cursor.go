package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

const boardRetention = 14 * 24 * time.Hour

// pruneBoardCursors removes inactive session cursors after the board's retention.
func pruneBoardCursors(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := now.Add(-boardRetention)
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
