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

// OpenIndex opens the SQLite index at the given project root.
//
// Pragmas are applied via DSN parameters so the modernc.org/sqlite driver
// guarantees busy_timeout is installed before journal_mode is changed.
// _txlock=immediate makes db.Begin() use BEGIN IMMEDIATE, which acquires
// the write lock up-front rather than deferring it — this way SQLITE_BUSY
// surfaces at Begin() time and busy_timeout retries before returning an
// error, rather than surfacing deep inside the Sync transaction.
func OpenIndex(projectRoot string) (*Index, error) {
	dbPath := filepath.Join(projectRoot, DirName, indexFileName)
	// Use a file: URI so the driver processes _pragma and _txlock params.
	// busy_timeout is sorted first by the driver (see modernc.org/sqlite#198).
	q := url.Values{}
	q.Set("_pragma", fmt.Sprintf("busy_timeout(%d)", indexBusyTimeout.Milliseconds()))
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	dsn := "file:" + dbPath + "?" + q.Encode()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite index: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	idx := &Index{db: db}
	if err := idx.init(); err != nil {
		_ = db.Close()
		return nil, err
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
		`CREATE TABLE IF NOT EXISTS tags (
			fiber_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (fiber_id, tag)
		)`,
		`CREATE TABLE IF NOT EXISTS decisions (
			fiber_id TEXT NOT NULL,
			decision_id TEXT NOT NULL,
			selected_option TEXT,
			option_count INTEGER NOT NULL,
			excluded_option_count INTEGER NOT NULL,
			has_unexcluded_options INTEGER NOT NULL,
			PRIMARY KEY (fiber_id, decision_id)
		)`,
		`CREATE TABLE IF NOT EXISTS inputs (
			fiber_id TEXT NOT NULL,
			input_id TEXT NOT NULL,
			from_ref TEXT,
			PRIMARY KEY (fiber_id, input_id)
		)`,
		`CREATE TABLE IF NOT EXISTS insights (
			fiber_id TEXT NOT NULL,
			insight_id TEXT NOT NULL,
			claim TEXT,
			evidence_count INTEGER NOT NULL,
			has_evidence INTEGER NOT NULL,
			PRIMARY KEY (fiber_id, insight_id)
		)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS fiber_fts USING fts5(
			id UNINDEXED,
			body,
			search_text
		)`,
		`CREATE TABLE IF NOT EXISTS history_events (
			rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
			fiber_id     TEXT NOT NULL,
			occurred_at  TEXT NOT NULL,
			event_type   TEXT NOT NULL,
			actor        TEXT NOT NULL,
			content_hash TEXT,
			payload      TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS history_events_fiber_time
			ON history_events(fiber_id, occurred_at DESC, rowid DESC)`,
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
	return openIndexWithBusyRetries(root, func(idx *Index) error {
		return idx.Sync(s)
	})
}

func openIndexWithBusyRetries(root string, sync func(*Index) error) (*Index, error) {
	var lastBusy error
	for attempt := 0; attempt <= len(indexSyncRetryDelays); attempt++ {
		if attempt > 0 {
			time.Sleep(indexSyncRetryDelays[attempt-1])
		}
		idx, err := OpenIndex(root)
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

// OpenIndexNoSync opens the index without running Sync. Used by CLI
// commands that need to append a mechanical event for an action they
// just performed: Sync's external_edit detection would otherwise
// mistake the change for an unattributed edit. After AppendEvent is
// called with the post-edit hash, subsequent OpenIndex/Sync calls see
// the hashes match and stay quiet.
func (s *Storage) OpenIndexNoSync() (*Index, error) {
	root := filepath.Dir(s.root)
	return openIndexWithBusyRetries(root, nil)
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
	topologyChanged := len(indexed) != len(current)
	if !topologyChanged {
		for id := range indexed {
			if _, ok := current[id]; !ok {
				topologyChanged = true
				break
			}
		}
	}

	// Fast path — nothing to do. Sync runs on every felt invocation, so the
	// no-change case is by far the most common (a read-heavy workload like
	// `felt history` against a quiet repo). Without this short-circuit,
	// `_txlock=immediate` would have us acquire the SQLite write lock for
	// a no-op transaction every call, serializing concurrent felt processes
	// behind busy_timeout retries until one of them surrenders with
	// "index busy."
	//
	// We can skip the write tx iff:
	// (a) topology is unchanged (no fibers added/removed), AND
	// (b) every indexed mtime matches the on-disk mtime.
	//
	// The hash-on-read pass below catches direct file edits that didn't
	// bump mtime — but in practice editors always bump mtime on save, so
	// the hash check only fires when the mtime check already did. Skipping
	// the write tx when both topology and mtime are clean is safe.
	if !topologyChanged {
		mtimesClean := true
		for id, state := range current {
			if indexed[id] != state.modifiedNanos {
				mtimesClean = false
				break
			}
		}
		if mtimesClean {
			return nil
		}
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
		if err := deleteFiberCompletely(tx, id); err != nil {
			return err
		}
	}

	sort.Strings(ids)
	for _, id := range ids {
		state := current[id]
		if !topologyChanged && indexed[id] == state.modifiedNanos {
			continue
		}
		f, err := s.Read(id)
		if err != nil {
			return err
		}
		f.ModifiedAt = state.modifiedAt
		if err := indexFiber(tx, f, ids); err != nil {
			return err
		}
	}

	// Hash-on-read: catch direct file edits (vi/IDE) that didn't go
	// through the felt CLI. For each fiber, compare the file's current
	// hash against the latest mechanical event's hash. Mismatch =>
	// append an external_edit event. New fibers without events get a
	// synthetic add event (the bootstrap baseline).
	for _, id := range ids {
		state := current[id]
		hash, err := HashFile(state.path)
		if err != nil {
			return err
		}
		if hash == "" {
			continue
		}
		latest, err := latestMechanicalHashTx(tx, id)
		if err != nil {
			return err
		}
		if latest == hash {
			continue
		}

		count, err := eventCountTx(tx, id)
		if err != nil {
			return err
		}
		eventType := EventExternalEdit
		actor := "external"
		payload := map[string]interface{}{}
		if count == 0 {
			// First time we've seen this fiber. Anchor the chain with
			// a synthetic add — not labelled external, since we don't
			// know whether the original create went through the CLI.
			eventType = EventAdd
			actor = "index-bootstrap"
			payload["bootstrap"] = true
		}
		lines, chars := FiberSize(state.path)
		payload["size_lines"] = lines
		payload["size_chars"] = chars
		payload["mtime"] = state.modifiedAt.UTC().Format(time.RFC3339Nano)
		if err := i.appendEventTx(tx, Event{
			FiberID:     id,
			OccurredAt:  state.modifiedAt,
			Type:        eventType,
			Actor:       actor,
			ContentHash: hash,
			Payload:     payload,
		}); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit index sync: %w", err)
	}
	tx = nil
	return nil
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

func deleteFiberCompletely(tx *sql.Tx, id string) error {
	statements := []string{
		`DELETE FROM fibers WHERE id = ?`,
		`DELETE FROM links WHERE source_id = ? OR target_id = ?`,
		`DELETE FROM tags WHERE fiber_id = ?`,
		`DELETE FROM decisions WHERE fiber_id = ?`,
		`DELETE FROM inputs WHERE fiber_id = ?`,
		`DELETE FROM insights WHERE fiber_id = ?`,
		`DELETE FROM fiber_fts WHERE id = ?`,
	}
	for _, stmt := range statements {
		args := []any{id}
		if strings.Contains(stmt, "target_id") {
			args = []any{id, id}
		}
		if _, err := tx.Exec(stmt, args...); err != nil {
			return fmt.Errorf("delete indexed fiber %s: %w", id, err)
		}
	}
	return nil
}

func indexFiber(tx *sql.Tx, f *Felt, allIDs []string) error {
	if err := clearFiberSourceIndex(tx, f.ID); err != nil {
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

	bodyRefs := ExtractBodyRefs(f.Body)
	for _, ref := range bodyRefs {
		targetID, err := ResolveScopedID(allIDs, f.ID, ref.Target)
		if err != nil {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO links (source_id, target_id, fragment, edge_type, input_id) VALUES (?, ?, ?, 'reference', NULL)`,
			f.ID, targetID, nullIfEmpty(ref.Fragment),
		); err != nil {
			return fmt.Errorf("insert reference link %s -> %s: %w", f.ID, targetID, err)
		}
	}

	for _, input := range f.Inputs {
		if _, err := tx.Exec(
			`INSERT INTO inputs (fiber_id, input_id, from_ref) VALUES (?, ?, ?)`,
			f.ID, input.ID, nullIfEmpty(input.From),
		); err != nil {
			return fmt.Errorf("insert input %s/%s: %w", f.ID, input.ID, err)
		}
		if strings.TrimSpace(input.From) == "" {
			continue
		}
		targetFiber, fragment := splitDataFlowRef(input.From)
		if targetFiber == "" {
			continue
		}
		targetID, err := ResolveScopedID(allIDs, f.ID, targetFiber)
		if err != nil {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO links (source_id, target_id, fragment, edge_type, input_id) VALUES (?, ?, ?, 'data_flow', ?)`,
			f.ID, targetID, nullIfEmpty(fragment), input.ID,
		); err != nil {
			return fmt.Errorf("insert data flow link %s -> %s: %w", f.ID, targetID, err)
		}
	}

	for id, decision := range f.Decisions {
		optionCount := len(decision.Options)
		excludedCount := 0
		hasUnexcluded := false
		for _, option := range decision.Options {
			if option.Excluded {
				excludedCount++
				continue
			}
			hasUnexcluded = true
		}
		if _, err := tx.Exec(
			`INSERT INTO decisions (fiber_id, decision_id, selected_option, option_count, excluded_option_count, has_unexcluded_options)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			f.ID, id, nullIfEmpty(decision.Default), optionCount, excludedCount, boolToInt(hasUnexcluded),
		); err != nil {
			return fmt.Errorf("insert decision %s/%s: %w", f.ID, id, err)
		}
	}

	for id, insight := range f.Insights {
		evidenceCount := len(insight.Evidence)
		if _, err := tx.Exec(
			`INSERT INTO insights (fiber_id, insight_id, claim, evidence_count, has_evidence) VALUES (?, ?, ?, ?, ?)`,
			f.ID, id, nullIfEmpty(insight.Claim), evidenceCount, boolToInt(evidenceCount > 0),
		); err != nil {
			return fmt.Errorf("insert insight %s/%s: %w", f.ID, id, err)
		}
	}

	if _, err := tx.Exec(
		`INSERT INTO fiber_fts (id, body, search_text) VALUES (?, ?, ?)`,
		f.ID, f.Body, f.SearchText(),
	); err != nil {
		return fmt.Errorf("insert fiber fts %s: %w", f.ID, err)
	}

	return nil
}

func clearFiberSourceIndex(tx *sql.Tx, id string) error {
	statements := []string{
		`DELETE FROM fibers WHERE id = ?`,
		`DELETE FROM links WHERE source_id = ?`,
		`DELETE FROM tags WHERE fiber_id = ?`,
		`DELETE FROM decisions WHERE fiber_id = ?`,
		`DELETE FROM inputs WHERE fiber_id = ?`,
		`DELETE FROM insights WHERE fiber_id = ?`,
		`DELETE FROM fiber_fts WHERE id = ?`,
	}
	for _, stmt := range statements {
		if _, err := tx.Exec(stmt, id); err != nil {
			return fmt.Errorf("clear indexed fiber %s: %w", id, err)
		}
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

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func ftsQuery(query string) string {
	query = strings.TrimSpace(query)
	query = strings.ReplaceAll(query, `"`, `""`)
	if query == "" {
		return `""`
	}
	return `"` + query + `"`
}
