package felt

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

// Event types. The log is one append-only stream; type discriminates.
const (
	// EventAdd is recorded when a fiber is created via the felt CLI/API.
	EventAdd = "add"
	// EventEdit is recorded when a fiber is mutated via the felt CLI/API.
	EventEdit = "edit"
	// EventExternalEdit is recorded when hash-on-read detects a file
	// modified outside felt (direct vi/IDE edits, git pulls).
	EventExternalEdit = "external_edit"
	// EventEditorial is an agent-written prose note appended via
	// `felt history append`.
	EventEditorial = "editorial"
)

// EditorialTextKey is the canonical payload key holding an editorial
// event's prose body. Older events used "summary"; readers fall back to
// that key when the canonical one is absent.
const (
	EditorialTextKey       = "text"
	EditorialTextKeyLegacy = "summary"
)

// EditorialSoftSizeLimit is the soft upper bound (in bytes) for an
// editorial event's summary. Longer entries succeed but emit a warning;
// they probably want to be sub-fibers.
const EditorialSoftSizeLimit = 4 * 1024

// Event represents one row of the history_events stream.
type Event struct {
	RowID       int64                  `json:"rowid"`
	FiberID     string                 `json:"fiber_id"`
	OccurredAt  time.Time              `json:"occurred_at"`
	Type        string                 `json:"event_type"`
	Actor       string                 `json:"actor"`
	ContentHash string                 `json:"content_hash,omitempty"`
	Payload     map[string]interface{} `json:"payload,omitempty"`
}

// EventFilter narrows a history query. Zero value = all events.
type EventFilter struct {
	FiberID    string
	Types      []string  // if set, only these event types
	Since      time.Time // if non-zero, occurred_at >= Since
	Until      time.Time // if non-zero, occurred_at <= Until
	Limit      int       // if > 0, cap the number of rows
	Descending bool      // newest-first when true
	// Unconsumed, when true, restricts results to events whose payload does
	// not contain a non-null "consumed_at" field. Uses SQLite's json_extract,
	// which requires SQLite ≥ 3.38 (always satisfied on macOS / modern Linux).
	Unconsumed bool
}

// HashFile returns the lowercase SHA-256 hex digest of the file's bytes.
// Returns empty string for missing files (the caller decides what to do).
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("open %s for hashing: %w", path, err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash %s: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashBytes returns the lowercase SHA-256 hex digest of the given bytes.
func HashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// DefaultActor returns a best-effort identifier for the current process.
// Shape: "$FELT_AGENT@<host>" when the agent env var is set, else "<host>"
// alone. Felt is single-user, so the OS username is dropped — the
// meaningful axes are which agent (claude-sonnet, ralph, codex…) and
// which machine (loom is git-synced across local/candide/cineca).
func DefaultActor() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	if agent := strings.TrimSpace(os.Getenv("FELT_AGENT")); agent != "" {
		return fmt.Sprintf("%s@%s", agent, host)
	}
	return host
}

// AppendEvent inserts one row into history_events. The caller is
// responsible for choosing the event type and payload shape; we don't
// validate content here.
func (i *Index) AppendEvent(e Event) error {
	return i.appendEventTx(nil, e)
}

func (i *Index) appendEventTx(tx *sql.Tx, e Event) error {
	if e.FiberID == "" {
		return fmt.Errorf("history event missing fiber_id")
	}
	if e.Type == "" {
		return fmt.Errorf("history event missing event_type")
	}
	if e.OccurredAt.IsZero() {
		e.OccurredAt = time.Now().UTC()
	}
	if e.Actor == "" {
		e.Actor = DefaultActor()
	}
	var payload sql.NullString
	if len(e.Payload) > 0 {
		raw, err := json.Marshal(e.Payload)
		if err != nil {
			return fmt.Errorf("marshal event payload: %w", err)
		}
		payload = sql.NullString{String: string(raw), Valid: true}
	}
	var hash sql.NullString
	if e.ContentHash != "" {
		hash = sql.NullString{String: e.ContentHash, Valid: true}
	}
	stmt := `INSERT INTO history_events
		(fiber_id, occurred_at, event_type, actor, content_hash, payload)
		VALUES (?, ?, ?, ?, ?, ?)`
	args := []any{
		e.FiberID,
		e.OccurredAt.UTC().Format(time.RFC3339Nano),
		e.Type,
		e.Actor,
		hash,
		payload,
	}
	if tx != nil {
		_, err := tx.Exec(stmt, args...)
		if err != nil {
			return fmt.Errorf("append history event: %w", err)
		}
		return nil
	}
	_, err := i.db.Exec(stmt, args...)
	if err != nil {
		return fmt.Errorf("append history event: %w", err)
	}
	return nil
}

// QueryEvents returns events matching the filter. Default order is
// chronological (occurred_at ASC, rowid ASC); set Descending for
// newest-first.
func (i *Index) QueryEvents(filter EventFilter) ([]Event, error) {
	var conds []string
	var args []any
	if filter.FiberID != "" {
		conds = append(conds, "fiber_id = ?")
		args = append(args, filter.FiberID)
	}
	if len(filter.Types) > 0 {
		placeholders := make([]string, len(filter.Types))
		for j, t := range filter.Types {
			placeholders[j] = "?"
			args = append(args, t)
		}
		conds = append(conds,
			"event_type IN ("+strings.Join(placeholders, ",")+")")
	}
	if !filter.Since.IsZero() {
		conds = append(conds, "occurred_at >= ?")
		args = append(args, filter.Since.UTC().Format(time.RFC3339Nano))
	}
	if !filter.Until.IsZero() {
		conds = append(conds, "occurred_at <= ?")
		args = append(args, filter.Until.UTC().Format(time.RFC3339Nano))
	}
	if filter.Unconsumed {
		// Keep only events whose payload has no consumed_at field (or whose
		// payload is null). json_extract returns NULL when the key is absent,
		// which is indistinguishable from a null value — both pass the
		// IS NULL check, matching the "not yet consumed" state.
		conds = append(conds,
			"(payload IS NULL OR json_extract(payload, '$.consumed_at') IS NULL)")
	}
	q := `SELECT rowid, fiber_id, occurred_at, event_type, actor,
		COALESCE(content_hash, ''), COALESCE(payload, '')
		FROM history_events`
	if len(conds) > 0 {
		q += " WHERE " + strings.Join(conds, " AND ")
	}
	if filter.Descending {
		q += " ORDER BY occurred_at DESC, rowid DESC"
	} else {
		q += " ORDER BY occurred_at ASC, rowid ASC"
	}
	if filter.Limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", filter.Limit)
	}
	rows, err := i.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query history events: %w", err)
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var occurredStr, contentHash, payloadStr string
		if err := rows.Scan(
			&e.RowID,
			&e.FiberID,
			&occurredStr,
			&e.Type,
			&e.Actor,
			&contentHash,
			&payloadStr,
		); err != nil {
			return nil, fmt.Errorf("scan history event: %w", err)
		}
		t, err := time.Parse(time.RFC3339Nano, occurredStr)
		if err != nil {
			return nil, fmt.Errorf("parse history occurred_at %q: %w",
				occurredStr, err)
		}
		e.OccurredAt = t
		if contentHash != "" {
			e.ContentHash = contentHash
		}
		if payloadStr != "" {
			payload := map[string]interface{}{}
			if err := json.Unmarshal([]byte(payloadStr), &payload); err != nil {
				return nil, fmt.Errorf(
					"unmarshal history payload (rowid=%d): %w",
					e.RowID, err)
			}
			e.Payload = payload
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LatestMechanicalHash returns the content_hash of the most recent
// storage-owned mechanical event for a fiber, or empty string if there are
// none. Typed editorial events are deliberately excluded even when their
// event_type is not "editorial".
func (i *Index) LatestMechanicalHash(fiberID string) (string, error) {
	row := i.db.QueryRow(
		`SELECT COALESCE(content_hash, '') FROM history_events
		 WHERE fiber_id = ? AND event_type IN (?, ?, ?)
		 ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
		fiberID,
		EventAdd,
		EventEdit,
		EventExternalEdit,
	)
	var hash string
	err := row.Scan(&hash)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read latest mechanical hash: %w", err)
	}
	return hash, nil
}

// latestMechanicalHashTx is the tx-aware variant used during Sync.
func latestMechanicalHashTx(tx *sql.Tx, fiberID string) (string, error) {
	row := tx.QueryRow(
		`SELECT COALESCE(content_hash, '') FROM history_events
		 WHERE fiber_id = ? AND event_type IN (?, ?, ?)
		 ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
		fiberID,
		EventAdd,
		EventEdit,
		EventExternalEdit,
	)
	var hash string
	err := row.Scan(&hash)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read latest mechanical hash (tx): %w", err)
	}
	return hash, nil
}

// EventCount returns the number of events for a fiber. Cheap existence
// check used during bootstrap.
func (i *Index) EventCount(fiberID string) (int, error) {
	row := i.db.QueryRow(
		`SELECT COUNT(*) FROM history_events WHERE fiber_id = ?`,
		fiberID,
	)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, fmt.Errorf("count history events: %w", err)
	}
	return n, nil
}

func eventCountTx(tx *sql.Tx, fiberID string) (int, error) {
	row := tx.QueryRow(
		`SELECT COUNT(*) FROM history_events WHERE fiber_id = ?`,
		fiberID,
	)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, fmt.Errorf("count history events (tx): %w", err)
	}
	return n, nil
}

// FiberSize returns line and char counts for the file backing a fiber.
// Best-effort: missing files yield zeroes.
func FiberSize(path string) (lines, chars int) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0
	}
	chars = len(data)
	if chars == 0 {
		return 0, 0
	}
	lines = strings.Count(string(data), "\n")
	if !strings.HasSuffix(string(data), "\n") {
		lines++
	}
	return lines, chars
}

// SortEventsAsc sorts events by occurred_at ASC, rowid ASC.
func SortEventsAsc(events []Event) {
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].OccurredAt.Equal(events[j].OccurredAt) {
			return events[i].RowID < events[j].RowID
		}
		return events[i].OccurredAt.Before(events[j].OccurredAt)
	})
}
