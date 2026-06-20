package felt

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const indexFileName = "index.db"

// ErrIndexBusy is returned when the SQLite index is locked by a concurrent
// process and cannot be synced after retries. Commands may catch this error
// to degrade gracefully (skip index-backed data) rather than failing.
var ErrIndexBusy = fmt.Errorf("index busy")

type Index struct {
	db *sql.DB
}

type Citation struct {
	SourceID   string
	TargetID   string
	Fragment   string
	SourceName string
}

type DataFlowConsumer struct {
	SourceID   string
	TargetID   string
	OutputID   string
	InputID    string
	SourceName string
}

type indexOpenMode int

const (
	indexOpenWrite indexOpenMode = iota
	indexOpenReadOnly
)

// openIndex opens the SQLite index at the given project root.
//
// Pragmas are applied via DSN parameters so the modernc.org/sqlite driver
// guarantees busy_timeout is installed before journal_mode is changed.
// _txlock=immediate makes db.Begin() use BEGIN IMMEDIATE, which acquires
// the write lock up-front rather than deferring it — this way SQLITE_BUSY
// surfaces at Begin() time and busy_timeout retries before returning an
// error, rather than surfacing deep inside the Sync transaction.
func openIndex(projectRoot string, mode indexOpenMode) (*Index, error) {
	dbPath := filepath.Join(projectRoot, DirName, indexFileName)
	// Use a file: URI so the driver processes _pragma and _txlock params.
	// busy_timeout is sorted first by the driver (see modernc.org/sqlite#198).
	q := url.Values{}
	q.Set("_pragma", fmt.Sprintf("busy_timeout(%d)", indexBusyTimeout.Milliseconds()))
	if mode == indexOpenReadOnly {
		q.Set("mode", "ro")
	} else {
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Set("_txlock", "immediate")
	}
	dsn := "file:" + dbPath + "?" + q.Encode()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite index: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	idx := &Index{db: db}
	if mode == indexOpenWrite {
		if err := idx.init(); err != nil {
			_ = db.Close()
			return nil, err
		}
	} else if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open sqlite index read-only: %w", err)
	}
	return idx, nil
}

// isSQLiteBusyErr reports whether err (or any error in its chain) is a
// SQLite busy/locked error. The modernc.org/sqlite driver annotates the
// error message with "(SQLITE_BUSY)" for error code 5.
func isSQLiteBusyErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "SQLITE_BUSY") ||
		strings.Contains(msg, "database is locked") ||
		strings.Contains(msg, "database table is locked")
}

func (i *Index) Close() error {
	if i == nil || i.db == nil {
		return nil
	}
	return i.db.Close()
}

func (i *Index) init() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS fibers (
			id TEXT PRIMARY KEY,
			parent_id TEXT,
			name TEXT NOT NULL,
			status TEXT,
			outcome TEXT,
			created_at TEXT,
			closed_at TEXT,
			modified_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS links (
			source_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			fragment TEXT,
			edge_type TEXT NOT NULL,
			input_id TEXT,
			PRIMARY KEY (source_id, target_id, fragment, edge_type, input_id)
		)`,
		`CREATE TABLE IF NOT EXISTS raw_refs (
			source_id TEXT NOT NULL,
			edge_type TEXT NOT NULL,
			target TEXT NOT NULL,
			fragment TEXT NOT NULL,
			input_id TEXT NOT NULL,
			PRIMARY KEY (source_id, edge_type, target, fragment, input_id)
		)`,
		`CREATE INDEX IF NOT EXISTS raw_refs_source
			ON raw_refs(source_id)`,
		`CREATE TABLE IF NOT EXISTS tags (
			fiber_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (fiber_id, tag)
		)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS fiber_fts USING fts5(
			id UNINDEXED,
			body,
			search_text
		)`,
		`CREATE TABLE IF NOT EXISTS index_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	}
	for _, stmt := range schema {
		if _, err := i.db.Exec(stmt); err != nil {
			return fmt.Errorf("init index schema: %w", err)
		}
	}
	return nil
}

// indexBusyTimeout controls SQLite's built-in busy wait. Tests shrink it to
// exercise the application-level retry loop without spending real seconds.
var indexBusyTimeout = 5 * time.Second

// indexSyncRetryDelays controls application-level retries when opening or
// syncing the index reports SQLITE_BUSY after the driver's built-in
// busy_timeout is exhausted. Each retry sleeps for an increasing interval
// before re-opening the DB.
var indexSyncRetryDelays = []time.Duration{
	200 * time.Millisecond,
	500 * time.Millisecond,
	1000 * time.Millisecond,
}

// OpenIndex opens the index and syncs it against the current fiber tree.
// If opening or syncing returns SQLITE_BUSY (after the driver's built-in
// busy_timeout), it retries up to len(indexSyncRetryDelays) more times with
// backoff.
// After all retries are exhausted it returns ErrIndexBusy so callers can
// degrade gracefully rather than propagating a raw SQLite error.
func (s *Storage) OpenIndex() (*Index, error) {
	root := filepath.Dir(s.root)
	return openIndexWithBusyRetries(root, func(root string) (*Index, error) {
		return openIndex(root, indexOpenWrite)
	}, func(idx *Index) error {
		return idx.Sync(s)
	})
}

func openIndexWithBusyRetries(root string, opener func(string) (*Index, error), sync func(*Index) error) (*Index, error) {
	var lastBusy error
	for attempt := 0; attempt <= len(indexSyncRetryDelays); attempt++ {
		if attempt > 0 {
			time.Sleep(indexSyncRetryDelays[attempt-1])
		}
		idx, err := opener(root)
		if err != nil {
			if isSQLiteBusyErr(err) {
				lastBusy = err
				continue
			}
			return nil, err
		}
		if sync == nil {
			return idx, nil
		}
		if err := sync(idx); err != nil {
			_ = idx.Close()
			if isSQLiteBusyErr(err) {
				lastBusy = err
				continue
			}
			return nil, err
		}
		return idx, nil
	}
	return nil, fmt.Errorf("%w: %v", ErrIndexBusy, lastBusy)
}

// OpenIndexReadOnly opens an existing index for stale-ok cache reads. It does
// not create index.db, initialize schema, or run Sync, so CLI reads can query a
// committed WAL snapshot without taking the writer-oriented schema path.
func (s *Storage) OpenIndexReadOnly() (*Index, error) {
	if !s.IndexExists() {
		return nil, os.ErrNotExist
	}
	root := filepath.Dir(s.root)
	return openIndexWithBusyRetries(root, func(root string) (*Index, error) {
		return openIndex(root, indexOpenReadOnly)
	}, nil)
}

// IndexExists reports whether the SQLite index already exists. Callers that
// want an optional read-only cache can use this to avoid creating index.db as a
// side effect of a narrow file-backed command.
func (s *Storage) IndexExists() bool {
	_, err := os.Stat(s.IndexPath())
	return err == nil
}

func (s *Storage) IndexPath() string {
	root := filepath.Dir(s.root)
	return filepath.Join(root, DirName, indexFileName)
}

func (i *Index) Sync(s *Storage) error {
	files, err := s.listFiberFiles()
	if err != nil {
		return err
	}

	type fileState struct {
		path          string
		modifiedAt    time.Time
		modifiedNanos int64
	}
	current := make(map[string]fileState, len(files))
	dirtyIDs := []string{}
	ids := make([]string, 0, len(files))
	for _, file := range files {
		info, err := os.Stat(file.path)
		if err != nil {
			return fmt.Errorf("stat %s: %w", file.path, err)
		}
		current[file.id] = fileState{
			path:          file.path,
			modifiedAt:    info.ModTime(),
			modifiedNanos: info.ModTime().UnixNano(),
		}
		ids = append(ids, file.id)
	}

	indexed, err := i.indexedModTimes()
	if err != nil {
		return err
	}
	rawRefsReady, err := i.rawRefsInitialized()
	if err != nil {
		return err
	}
	topologyChanged := len(indexed) != len(current)
	if !topologyChanged {
		for id := range indexed {
			if _, ok := current[id]; !ok {
				topologyChanged = true
				break
			}
		}
	}
	for id, state := range current {
		if indexed[id] != state.modifiedNanos {
			dirtyIDs = append(dirtyIDs, id)
		}
	}
	sort.Strings(ids)
	sort.Strings(dirtyIDs)

	// Fast path — skip the write tx when topology is unchanged and every
	// indexed mtime matches on disk. Sync runs on every felt invocation, so
	// this no-op case is the common one; without the short-circuit
	// `_txlock=immediate` would take the SQLite write lock for a no-op tx and
	// serialize concurrent felt processes behind busy_timeout. (Editors bump
	// mtime on save, so the hash-on-read pass below adds nothing here.)
	if rawRefsReady && !topologyChanged && len(dirtyIDs) == 0 {
		return nil
	}

	reindexIDs := ids
	if rawRefsReady && topologyChanged {
		reindexIDs, err = i.changedTopologyReindexIDs(indexedIDs(indexed), ids, dirtyIDs)
		if err != nil {
			return err
		}
	} else if rawRefsReady && !topologyChanged {
		reindexIDs = dirtyIDs
	}

	tx, err := i.db.Begin()
	if err != nil {
		return fmt.Errorf("begin index sync: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	for id := range indexed {
		if _, ok := current[id]; ok {
			continue
		}
		if err := clearFiberRows(tx, id, true); err != nil {
			return err
		}
	}

	// Build the scope resolver once for the whole reindex pass: indexFiber
	// resolves every outbound ref against the full id set, and rebuilding the
	// resolver per fiber re-sorts + re-maps all ids on each call.
	resolver := newScopedIDResolver(ids)
	for _, id := range reindexIDs {
		state := current[id]
		f, err := s.Read(id)
		if err != nil {
			return err
		}
		f.ModifiedAt = state.modifiedAt
		if err := indexFiber(tx, f, resolver); err != nil {
			return err
		}
	}

	if !rawRefsReady {
		if err := setIndexMetaTx(tx, "raw_refs_v1", "true"); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit index sync: %w", err)
	}
	tx = nil
	return nil
}

func (i *Index) rawRefsInitialized() (bool, error) {
	var value string
	err := i.db.QueryRow(`SELECT value FROM index_meta WHERE key = 'raw_refs_v1'`).Scan(&value)
	if err == nil {
		return value == "true", nil
	}
	if err == sql.ErrNoRows {
		return false, nil
	}
	return false, fmt.Errorf("read index metadata: %w", err)
}

func setIndexMetaTx(tx *sql.Tx, key, value string) error {
	if _, err := tx.Exec(
		`INSERT INTO index_meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key,
		value,
	); err != nil {
		return fmt.Errorf("set index metadata %s: %w", key, err)
	}
	return nil
}

func indexedIDs(indexed map[string]int64) []string {
	ids := make([]string, 0, len(indexed))
	for id := range indexed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (i *Index) changedTopologyReindexIDs(oldIDs, currentIDs, dirtyIDs []string) ([]string, error) {
	oldResolver := newScopedIDResolver(oldIDs)
	currentResolver := newScopedIDResolver(currentIDs)
	current := make(map[string]struct{}, len(currentIDs))
	for _, id := range currentIDs {
		current[id] = struct{}{}
	}
	reindex := map[string]struct{}{}
	for _, id := range dirtyIDs {
		if _, ok := current[id]; ok {
			reindex[id] = struct{}{}
		}
	}

	rows, err := i.db.Query(`SELECT DISTINCT source_id, target FROM raw_refs`)
	if err != nil {
		return nil, fmt.Errorf("read raw refs for topology sync: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID string
		var target string
		if err := rows.Scan(&sourceID, &target); err != nil {
			return nil, fmt.Errorf("scan raw ref for topology sync: %w", err)
		}
		if _, ok := current[sourceID]; !ok {
			continue
		}
		if resolveScopedIDOrEmpty(oldResolver, sourceID, target) != resolveScopedIDOrEmpty(currentResolver, sourceID, target) {
			reindex[sourceID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]string, 0, len(reindex))
	for id := range reindex {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}

func resolveScopedIDOrEmpty(resolver *scopedIDResolver, scopeID, target string) string {
	id, ok := resolver.ResolveOK(scopeID, target)
	if !ok {
		return ""
	}
	return id
}

func (i *Index) indexedModTimes() (map[string]int64, error) {
	rows, err := i.db.Query(`SELECT id, modified_at FROM fibers`)
	if err != nil {
		return nil, fmt.Errorf("read indexed mtimes: %w", err)
	}
	defer rows.Close()

	out := map[string]int64{}
	for rows.Next() {
		var id string
		var modifiedAt int64
		if err := rows.Scan(&id, &modifiedAt); err != nil {
			return nil, fmt.Errorf("scan indexed mtimes: %w", err)
		}
		out[id] = modifiedAt
	}
	return out, rows.Err()
}

// clearFiberRows deletes a fiber's indexed rows. The source-owned rows (the
// fiber itself, its raw_refs/tags/fiber_fts, and the links it originates) are
// always removed — this is the reindex reset before indexFiber rewrites them.
// includeInbound additionally drops links that *target* this fiber, used when
// a fiber is removed from the tree entirely (the Sync delete loop) so no
// dangling inbound edges survive. Splitting the inbound delete out of an
// `OR target_id` clause is row-set equivalent.
func clearFiberRows(tx *sql.Tx, id string, includeInbound bool) error {
	statements := []string{
		`DELETE FROM fibers WHERE id = ?`,
		`DELETE FROM links WHERE source_id = ?`,
		`DELETE FROM raw_refs WHERE source_id = ?`,
		`DELETE FROM tags WHERE fiber_id = ?`,
		`DELETE FROM fiber_fts WHERE id = ?`,
	}
	if includeInbound {
		statements = append(statements, `DELETE FROM links WHERE target_id = ?`)
	}
	for _, stmt := range statements {
		if _, err := tx.Exec(stmt, id); err != nil {
			return fmt.Errorf("clear indexed fiber %s: %w", id, err)
		}
	}
	return nil
}

func indexFiber(tx *sql.Tx, f *Felt, resolver *scopedIDResolver) error {
	if err := clearFiberRows(tx, f.ID, false); err != nil {
		return err
	}

	parentID := parentPath(f.ID)
	var closedAt any
	if f.ClosedAt != nil {
		closedAt = f.ClosedAt.Format(time.RFC3339Nano)
	}
	if _, err := tx.Exec(
		`INSERT INTO fibers (id, parent_id, name, status, outcome, created_at, closed_at, modified_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID,
		nullIfEmpty(parentID),
		f.DisplayName(),
		nullIfEmpty(f.Status),
		nullIfEmpty(f.Outcome),
		f.CreatedAt.Format(time.RFC3339Nano),
		closedAt,
		f.ModifiedAt.UnixNano(),
	); err != nil {
		return fmt.Errorf("insert fiber %s: %w", f.ID, err)
	}

	for _, tag := range mergeIndexTags(f) {
		if _, err := tx.Exec(`INSERT INTO tags (fiber_id, tag) VALUES (?, ?)`, f.ID, tag); err != nil {
			return fmt.Errorf("insert tag %s/%s: %w", f.ID, tag, err)
		}
	}

	// Index this fiber's outbound refs. insertRawRef runs unconditionally
	// (resolved or not); a links row is added only when resolution succeeds.
	if err := iterRefsResolved([]*Felt{f}, resolver, func(r resolvedRef) error {
		if err := insertRawRef(tx, f.ID, r.Kind, r.RawTarget, r.Fragment, r.InputID); err != nil {
			return err
		}
		if r.ResolveErr != nil {
			return nil
		}
		if r.Kind == refKindReference {
			if _, err := tx.Exec(
				`INSERT INTO links (source_id, target_id, fragment, edge_type, input_id) VALUES (?, ?, ?, 'reference', NULL)`,
				f.ID, r.ResolvedID, nullIfEmpty(r.Fragment),
			); err != nil {
				return fmt.Errorf("insert reference link %s -> %s: %w", f.ID, r.ResolvedID, err)
			}
			return nil
		}
		if _, err := tx.Exec(
			`INSERT INTO links (source_id, target_id, fragment, edge_type, input_id) VALUES (?, ?, ?, 'data_flow', ?)`,
			f.ID, r.ResolvedID, nullIfEmpty(r.Fragment), r.InputID,
		); err != nil {
			return fmt.Errorf("insert data flow link %s -> %s: %w", f.ID, r.ResolvedID, err)
		}
		return nil
	}); err != nil {
		return err
	}

	if _, err := tx.Exec(
		`INSERT INTO fiber_fts (id, body, search_text) VALUES (?, ?, ?)`,
		f.ID, f.Body, f.SearchText(),
	); err != nil {
		return fmt.Errorf("insert fiber fts %s: %w", f.ID, err)
	}

	return nil
}

func insertRawRef(tx *sql.Tx, sourceID, edgeType, target, fragment, inputID string) error {
	if strings.TrimSpace(target) == "" {
		return nil
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO raw_refs (source_id, edge_type, target, fragment, input_id)
		 VALUES (?, ?, ?, ?, ?)`,
		sourceID,
		edgeType,
		target,
		strings.TrimSpace(fragment),
		strings.TrimSpace(inputID),
	); err != nil {
		return fmt.Errorf("insert raw ref %s -> %s: %w", sourceID, target, err)
	}
	return nil
}

func (i *Index) SearchBodyIDs(query string) ([]string, error) {
	rows, err := i.db.Query(
		`SELECT id FROM fiber_fts WHERE fiber_fts MATCH ? ORDER BY rank`,
		ftsQuery(query),
	)
	if err != nil {
		return nil, fmt.Errorf("fts body search: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan fts id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (i *Index) Citations(targetID string) ([]Citation, error) {
	rows, err := i.db.Query(
		`SELECT l.source_id, l.target_id, COALESCE(l.fragment, ''), f.name
		 FROM links l
		 JOIN fibers f ON f.id = l.source_id
		 WHERE l.edge_type = 'reference' AND l.target_id = ?
		 ORDER BY l.source_id`,
		targetID,
	)
	if err != nil {
		return nil, fmt.Errorf("query citations for %s: %w", targetID, err)
	}
	defer rows.Close()

	var citations []Citation
	for rows.Next() {
		var c Citation
		if err := rows.Scan(&c.SourceID, &c.TargetID, &c.Fragment, &c.SourceName); err != nil {
			return nil, fmt.Errorf("scan citation: %w", err)
		}
		citations = append(citations, c)
	}
	return citations, rows.Err()
}

func (i *Index) Consumers(targetID string) ([]DataFlowConsumer, error) {
	rows, err := i.db.Query(
		`SELECT l.source_id, l.target_id, COALESCE(l.fragment, ''), COALESCE(l.input_id, ''), f.name
		 FROM links l
		 JOIN fibers f ON f.id = l.source_id
		 WHERE l.edge_type = 'data_flow' AND l.target_id = ?
		 ORDER BY COALESCE(l.fragment, ''), l.source_id, COALESCE(l.input_id, '')`,
		targetID,
	)
	if err != nil {
		return nil, fmt.Errorf("query consumers for %s: %w", targetID, err)
	}
	defer rows.Close()

	var consumers []DataFlowConsumer
	for rows.Next() {
		var c DataFlowConsumer
		if err := rows.Scan(&c.SourceID, &c.TargetID, &c.OutputID, &c.InputID, &c.SourceName); err != nil {
			return nil, fmt.Errorf("scan consumer: %w", err)
		}
		consumers = append(consumers, c)
	}
	return consumers, rows.Err()
}

func mergeIndexTags(f *Felt) []string {
	seen := map[string]struct{}{}
	for _, tag := range f.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		seen[tag] = struct{}{}
	}
	for _, tag := range ExtractInlineTags(f.Body) {
		seen[tag] = struct{}{}
	}
	tags := make([]string, 0, len(seen))
	for tag := range seen {
		tags = append(tags, tag)
	}
	sort.Strings(tags)
	return tags
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func ftsQuery(query string) string {
	query = strings.TrimSpace(query)
	query = strings.ReplaceAll(query, `"`, `""`)
	if query == "" {
		return `""`
	}
	return `"` + query + `"`
}
