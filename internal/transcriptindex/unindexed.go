package transcriptindex

import (
	"context"
	"os"
	"path/filepath"
)

// Marker is the file that keeps a directory's sessions out of the index. A
// session whose working directory is the marked directory, or anywhere under
// it, keeps its file row (so catch-up stays a stat) and has no messages, so
// search, recent activity and reads through the index never see its content.
// The marker is read on every catch-up: adding one drops already-indexed
// messages, and removing one lets the next change to a transcript index it.
const Marker = ".no-transcript-search"

// unindexed reports whether project, a session's working directory, is at or
// under a directory holding Marker.
func unindexed(project string) bool {
	if project == "" || !filepath.IsAbs(project) {
		return false
	}
	for dir := filepath.Clean(project); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, Marker)); err == nil {
			return true
		}
		if dir == filepath.Dir(dir) {
			return false
		}
	}
}

// dropUnindexed removes the messages of every indexed session whose working
// directory is now marked.
func (i *Index) dropUnindexed(ctx context.Context) error {
	rows, err := i.db.QueryContext(ctx, "SELECT DISTINCT project FROM files WHERE messages > 0")
	if err != nil {
		return err
	}
	var marked []string
	for rows.Next() {
		var project string
		if err = rows.Scan(&project); err != nil {
			rows.Close()
			return err
		}
		if unindexed(project) {
			marked = append(marked, project)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(marked) == 0 {
		return err
	}
	conn, err := i.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	for _, project := range marked {
		if _, err = conn.ExecContext(ctx, "DELETE FROM messages WHERE file_id IN (SELECT id FROM files WHERE project=?)", project); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, "UPDATE files SET messages=0 WHERE project=?", project); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
