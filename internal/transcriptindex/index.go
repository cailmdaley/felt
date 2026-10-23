package transcriptindex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Index struct {
	db   *sql.DB
	path string
}
type Stats struct {
	Path      string `json:"path"`
	Sessions  int64  `json:"sessions"`
	Messages  int64  `json:"messages"`
	UpdatedAt string `json:"updated_at"`
}

const schema = `
CREATE TABLE IF NOT EXISTS files (
 id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, harness TEXT NOT NULL,
 identity TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
 offset INTEGER NOT NULL, line INTEGER NOT NULL, tail TEXT NOT NULL,
 session TEXT NOT NULL, project TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, line INTEGER NOT NULL,
 timestamp TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_file ON messages(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, content='messages', content_rowid='id', tokenize="unicode61 remove_diacritics 2 tokenchars '_'");
CREATE TRIGGER IF NOT EXISTS messages_insert AFTER INSERT ON messages BEGIN
 INSERT INTO search(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_delete AFTER DELETE ON messages BEGIN
 INSERT INTO search(search,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version=1;
`

func Open(path string) (*Index, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// Transcripts can contain private content. The database and its WAL live in
	// a private cache directory and the database itself is owner-readable only.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	_ = f.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		if err = os.Chmod(path+suffix, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*Index, error) { db.Close(); return nil, err }
	if _, err = db.Exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768;`); err != nil {
		return fail(err)
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fail(err)
	}
	if version > 1 {
		return fail(fmt.Errorf("transcript index schema %d is newer than this CLI", version))
	}
	if _, err = db.Exec(schema); err != nil {
		return fail(err)
	}
	return &Index{db: db, path: path}, nil
}
func (i *Index) Close() error { return i.db.Close() }

// Ready reports a completed root scan. A hook-created single-file index is
// useful with --no-index but doesn't authorize an implicit first full build.
func (i *Index) Ready(ctx context.Context) (bool, error) {
	var value string
	err := i.db.QueryRowContext(ctx, "SELECT value FROM state WHERE key='scan_completed'").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return value == "1", err
}

func (i *Index) Stats(ctx context.Context) (Stats, error) {
	s := Stats{Path: i.path}
	err := i.db.QueryRowContext(ctx, `SELECT count(DISTINCT session), coalesce(sum(messages),0) FROM files WHERE session != ''`).Scan(&s.Sessions, &s.Messages)
	if err != nil {
		return s, err
	}
	err = i.db.QueryRowContext(ctx, `SELECT value FROM state WHERE key='updated_at'`).Scan(&s.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return s, err
}

// CatchUp walks only the configured native roots. Unchanged files require a
// stat, not a transcript read. A missing root is normal on a single-harness host.
func (i *Index) CatchUp(ctx context.Context, roots []Root, rebuild bool) ([]string, error) {
	if rebuild {
		// BEGIN IMMEDIATE serializes rebuild with hook writers before any rows change.
		conn, err := i.db.Conn(ctx)
		if err != nil {
			return nil, err
		}
		_, err = conn.ExecContext(ctx, `BEGIN IMMEDIATE; DELETE FROM messages; DELETE FROM files; DELETE FROM state; COMMIT;`)
		if err != nil {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
		conn.Close()
		if err != nil {
			return nil, err
		}
	}
	problems := []string{}
	for _, root := range roots {
		complete := true
		seen := map[string]bool{}
		err := filepath.WalkDir(root.Path, func(path string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				complete = false
				if !errors.Is(err, os.ErrNotExist) {
					problems = append(problems, fmt.Sprintf("%s: %v", path, err))
				}
				return nil
			}
			if d.IsDir() {
				return nil
			}
			if !d.Type().IsRegular() || !strings.HasSuffix(path, ".jsonl") {
				return nil
			}
			if root.Harness == "codex" && !strings.HasPrefix(d.Name(), "rollout-") {
				return nil
			}
			seen[path] = true
			if err := i.IndexFile(ctx, path, root.Harness); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				problems = append(problems, fmt.Sprintf("%s: %v", path, err))
			}
			return nil
		})
		if err != nil {
			return problems, err
		}
		if complete {
			if err := i.pruneMissing(ctx, root, seen); err != nil {
				return problems, err
			}
		}
	}
	ready, err := i.Ready(ctx)
	if err != nil {
		return problems, err
	}
	if !ready {
		_, err = i.db.ExecContext(ctx, `INSERT INTO state(key,value) VALUES('scan_completed','1') ON CONFLICT(key) DO NOTHING`)
		if err != nil {
			return problems, err
		}
		_, err = i.db.ExecContext(ctx, `INSERT INTO state(key,value) VALUES('updated_at',?) ON CONFLICT(key) DO NOTHING`, time.Now().UTC().Format(time.RFC3339))
		if err != nil {
			return problems, err
		}
	}
	return problems, nil
}

type fileState struct {
	id, size, mtime, offset, line, messages int64
	identity, tail                          string
	meta                                    metadata
}

func identity(info os.FileInfo) string {
	v := reflect.ValueOf(info.Sys())
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return ""
	}
	dev, ino := v.FieldByName("Dev"), v.FieldByName("Ino")
	if !dev.IsValid() || !ino.IsValid() {
		return ""
	}
	return fmt.Sprintf("%v:%v", dev.Interface(), ino.Interface())
}
func tailHash(f *os.File, offset int64) (string, error) {
	n := int64(256)
	if offset < n {
		n = offset
	}
	b := make([]byte, n)
	if _, err := f.ReadAt(b, offset-n); err != nil {
		return "", err
	}
	// A bounded fingerprint detects prefix and checkpoint-tail rewrites without
	// rereading append-only history. Arbitrary in-place edits to the middle of
	// a growing file require --rebuild; native harnesses append their records.
	h := sha256.New()
	_, _ = h.Write(b)
	if _, err := f.ReadAt(b, 0); err != nil {
		return "", err
	}
	_, _ = h.Write(b)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// IndexFile checkpoints messages and the complete-line byte offset atomically.
// A writer acquires SQLite's lock before reading the checkpoint, so concurrent
// hook/manual catch-ups cannot insert the same appended messages twice.
func (i *Index) IndexFile(ctx context.Context, path, harness string) error {
	if harness != "claude" && harness != "codex" && harness != "pi" {
		return fmt.Errorf("unknown harness %q", harness)
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file")
	}
	// The optimistic read avoids a write lock and file open on a no-op scan.
	var old fileState
	err = i.db.QueryRowContext(ctx, `SELECT size,mtime,identity FROM files WHERE path=?`, path).Scan(&old.size, &old.mtime, &old.identity)
	if err == nil && old.size == info.Size() && old.mtime == info.ModTime().UnixNano() && old.identity == identity(info) {
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
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
	old = fileState{}
	err = conn.QueryRowContext(ctx, `SELECT id,size,mtime,identity,offset,line,tail,session,project,messages FROM files WHERE path=?`, path).Scan(&old.id, &old.size, &old.mtime, &old.identity, &old.offset, &old.line, &old.tail, &old.meta.Session, &old.meta.Project, &old.messages)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return err
	}
	ident := identity(info)
	reset := old.id != 0 && (old.identity != ident || info.Size() < old.size || info.Size() < old.offset || (info.Size() == old.size && info.ModTime().UnixNano() != old.mtime))
	if !reset && old.offset > 0 {
		hash, e := tailHash(f, old.offset)
		reset = e != nil || hash != old.tail
	}
	if reset {
		if _, err = conn.ExecContext(ctx, "DELETE FROM messages WHERE file_id=?", old.id); err != nil {
			return err
		}
		old.offset = 0
		old.line = 0
		old.messages = 0
		old.meta = metadata{}
	}
	if old.id == 0 {
		result, e := conn.ExecContext(ctx, `INSERT INTO files(path,harness,identity,size,mtime,offset,line,tail,session,project) VALUES(?,?,?,0,0,0,0,'','','')`, path, harness, ident)
		if e != nil {
			return e
		}
		old.id, err = result.LastInsertId()
		if err != nil {
			return err
		}
	}
	if old.meta.Session == "" {
		old.meta.Session = sessionFromPath(path)
	}
	if _, err = f.Seek(old.offset, io.SeekStart); err != nil {
		return err
	}
	// Snapshot the size: live appends are left for the next catch-up. ReadBytes
	// has no Scanner token ceiling, including on lines containing image payloads.
	r := bufio.NewReaderSize(io.LimitReader(f, info.Size()-old.offset), 128<<10)
	stmt, err := conn.PrepareContext(ctx, `INSERT INTO messages(file_id,line,timestamp,role,text) VALUES(?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	malformed := 0
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		line, readErr := r.ReadBytes('\n')
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
		old.offset += int64(len(line))
		old.line++
		msgs, e := parseLine(harness, line, &old.meta)
		if e != nil {
			malformed++
			continue
		}
		for _, m := range msgs {
			if _, err = stmt.ExecContext(ctx, old.id, old.line, m.Timestamp, m.Role, m.Text); err != nil {
				return err
			}
			old.messages++
		}
	}
	hash, err := tailHash(f, old.offset)
	if err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, `UPDATE files SET harness=?,identity=?,size=?,mtime=?,offset=?,line=?,tail=?,session=?,project=?,messages=? WHERE id=?`, harness, ident, info.Size(), info.ModTime().UnixNano(), old.offset, old.line, hash, old.meta.Session, old.meta.Project, old.messages, old.id)
	if err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, `INSERT INTO state(key,value) VALUES('updated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	if malformed > 0 {
		return fmt.Errorf("skipped %d malformed complete JSONL lines", malformed)
	}
	return nil
}
func sessionFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	// Both rollout and Pi names end in a native UUID; Claude filenames are UUIDs.
	if len(name) >= 36 {
		return name[len(name)-36:]
	}
	return name
}
