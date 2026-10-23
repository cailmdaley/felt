package transcriptindex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pruneMissing only runs after a complete root enumeration. A missing or
// inaccessible root must not erase searchable history during an unmount.
func (i *Index) pruneMissing(ctx context.Context, root Root, seen map[string]bool) error {
	rows, err := i.db.QueryContext(ctx, "SELECT path FROM files WHERE harness=?", root.Harness)
	if err != nil {
		return err
	}
	var missing []string
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			rows.Close()
			return err
		}
		rel, e := filepath.Rel(root.Path, path)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || seen[path] {
			continue
		}
		if _, e = os.Stat(path); errors.Is(e, os.ErrNotExist) {
			missing = append(missing, path)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(missing) == 0 {
		return nil
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
	for _, path := range missing {
		if _, e := os.Stat(path); !errors.Is(e, os.ErrNotExist) {
			continue
		}
		if _, err = conn.ExecContext(ctx, "DELETE FROM messages WHERE file_id=(SELECT id FROM files WHERE path=?)", path); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, "DELETE FROM files WHERE path=?", path); err != nil {
			return err
		}
	}
	if _, err = conn.ExecContext(ctx, `INSERT INTO state(key,value) VALUES('updated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
