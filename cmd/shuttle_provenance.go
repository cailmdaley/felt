package cmd

// Session provenance is intentionally a small client-side composition of the
// daemon's ledgers and file surface. The daemon owns session identity and host
// routing; felt only filters the composite ledger and, for a remote transcript,
// copies the exact bytes into a managed local cache. Reading/searching the file
// remains the harness skill's job (jq, rg, tail, ...), not another felt DSL.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

const (
	sessionsCompositePath     = "/api/v1/sessions/composite"
	transcriptPath            = "/api/v1/transcript"
	transcriptTransferTimeout = 5 * time.Minute
)

// TranscriptReceipt is the daemon's explicit availability and resolution
// result. Path is the native path on the host named by Host; SourcePath is
// accepted as an alias for older daemon responses; source_path is the canonical
// field. The daemon's raw endpoint supplies exact bytes, with byte_count and
// sha256 receipts used to verify the transfer before caching.
type TranscriptReceipt struct {
	Session      string `json:"session,omitempty"`
	Availability string `json:"availability"`
	Path         string `json:"path,omitempty"`
	SourcePath   string `json:"source_path,omitempty"`
	Host         string `json:"host,omitempty"`
	Harness      string `json:"harness,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	ByteCount    int64  `json:"byte_count,omitempty"`
	Size         int64  `json:"size,omitempty"`
	// ModifiedAt is the transcript file's last write, unix milliseconds — the
	// end of the session as the filesystem saw it. Absent for a transcript
	// this daemon cannot stat (missing, or a host that did not answer).
	ModifiedAt int64 `json:"modified_at,omitempty"`
}

// SessionProvenance mirrors the composite session ledger while leaving the
// transcript receipt beside (rather than inside) the machine pairing. The
// predecessor/children fields are optional because old ledger rows predate
// explicit lineage; absence is not interpreted as proof of no lineage.
type SessionProvenance struct {
	Fiber      string            `json:"fiber,omitempty"`
	FiberID    string            `json:"fiber_id,omitempty"`
	UID        string            `json:"uid,omitempty"`
	Session    string            `json:"session"`
	Harness    string            `json:"harness,omitempty"`
	Host       string            `json:"host,omitempty"`
	Tmux       string            `json:"tmux,omitempty"`
	At         int64             `json:"at,omitempty"`
	Kind       string            `json:"kind,omitempty"`
	Origin     string            `json:"origin,omitempty"`
	Stale      bool              `json:"stale,omitempty"`
	Events     []SessionEvent    `json:"events,omitempty"`
	Transcript TranscriptReceipt `json:"transcript,omitempty"`
	// Derived at output time from the events and the transcript receipt, so a
	// --json consumer reads the same temporal picture the table shows. Zero
	// means unrecorded, never "did not happen".
	StartedAt   int64 `json:"started_at,omitempty"`
	EndedAt     int64 `json:"ended_at,omitempty"`
	HandedOffAt int64 `json:"handed_off_at,omitempty"`
}

// The temporal reading of a row, derived rather than stored: the ledger knows
// when a session began and whether it ended deliberately; the transcript file
// knows when the last word was written. Nothing here guesses — a zero is an
// honest "the ledger and the filesystem did not say".

// startedAt is the first recorded moment for the session (its dispatch, claim,
// or — for a row whose earlier lines rotated out — whatever is left).
func (s SessionProvenance) startedAt() int64 {
	first := s.At
	for _, event := range s.Events {
		if event.At != 0 && (first == 0 || event.At < first) {
			first = event.At
		}
	}
	return first
}

// handedOffAt is the clean-exit moment `felt shuttle handoff` recorded. Zero
// means no handoff line — the session either died mid-thought or predates the
// handoff record, which is exactly the ambiguity worth surfacing rather than
// resolving.
func (s SessionProvenance) handedOffAt() int64 {
	at := int64(0)
	for _, event := range s.Events {
		if event.Kind == "handoff" && event.At > at {
			at = event.At
		}
	}
	return at
}

// endedAt prefers the transcript's last write — the true end of the words —
// and falls back to the handoff stamp when the file cannot be stat'd.
func (s SessionProvenance) endedAt() int64 {
	if s.Transcript.ModifiedAt != 0 {
		return s.Transcript.ModifiedAt
	}
	return s.handedOffAt()
}

// byteCount tolerates the older receipt field name.
func (s SessionProvenance) byteCount() int64 {
	if s.Transcript.ByteCount != 0 {
		return s.Transcript.ByteCount
	}
	return s.Transcript.Size
}

type SessionEvent struct {
	At    int64  `json:"at,omitempty"`
	Kind  string `json:"kind,omitempty"`
	Fiber string `json:"fiber,omitempty"`
	Tmux  string `json:"tmux,omitempty"`
}

func (s SessionProvenance) fiber() string {
	if s.Fiber != "" {
		return s.Fiber
	}
	return s.FiberID
}

type sessionLedgerResponse struct {
	Host    string              `json:"host,omitempty"`
	Records []SessionProvenance `json:"records"`
	Origins map[string]any      `json:"origins,omitempty"`
}

type transcriptMetadataResponse struct {
	TranscriptReceipt
}

func fetchSessionLedger() (*sessionLedgerResponse, error) {
	body, err := getDaemon(daemonURL()+sessionsCompositePath, daemonReadTimeout)
	if err != nil {
		if isLifecycleTransportError(err) {
			return nil, fmt.Errorf("reading session provenance: %w (start the daemon with `make start` or set SHUTTLE_DAEMON_URL)", err)
		}
		return nil, err
	}
	var ledger sessionLedgerResponse
	if err := json.Unmarshal(body, &ledger); err != nil {
		return nil, fmt.Errorf("parsing session ledger: %w", err)
	}
	return &ledger, nil
}

// fetchTranscriptReceipt asks the daemon to resolve a harness-native path. A
// receipt is JSON; bytes are fetched separately through the native transcript
// raw endpoint so this command never requires a transcript encoding.
func fetchTranscriptReceipt(session, host string) (TranscriptReceipt, error) {
	u, err := url.Parse(daemonURL() + transcriptPath)
	if err != nil {
		return TranscriptReceipt{}, err
	}
	q := u.Query()
	q.Set("session", session)
	if host != "" {
		q.Set("host", host)
	}
	u.RawQuery = q.Encode()
	body, err := getDaemon(u.String(), daemonReadTimeout)
	if err != nil {
		return TranscriptReceipt{}, err
	}
	var direct TranscriptReceipt
	if err := json.Unmarshal(body, &direct); err == nil && (direct.Availability != "" || direct.Path != "" || direct.SourcePath != "") {
		if direct.Session == "" {
			direct.Session = session
		}
		return direct, nil
	}
	var wrapped transcriptMetadataResponse
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return TranscriptReceipt{}, fmt.Errorf("parsing transcript receipt for %s: %w", session, err)
	}
	if wrapped.Session == "" {
		wrapped.Session = session
	}
	return wrapped.TranscriptReceipt, nil
}

func enrichSessionReceipt(s SessionProvenance) SessionProvenance {
	if s.Transcript.Availability != "" {
		return s
	}
	receipt, err := fetchTranscriptReceipt(s.Session, s.Host)
	if err != nil {
		// A ledger row is still valuable when a remote is down. Keep the
		// distinction explicit rather than collapsing it into "missing".
		s.Transcript = TranscriptReceipt{
			Session:      s.Session,
			Availability: "host_unreachable",
			Host:         s.Host,
			Harness:      s.Harness,
		}
		return s
	}
	if receipt.Host == "" {
		receipt.Host = s.Host
	}
	if receipt.Harness == "" {
		receipt.Harness = s.Harness
	}
	s.Transcript = receipt
	return localTranscriptModifiedAt(s)
}

// localTranscriptModifiedAt fills in the end-of-session instant for a
// transcript that lives on THIS host, from this process's own stat. The daemon
// supplies modified_at in its receipt, but an older daemon does not, and
// available_local means the file is reachable from here — so the CLI can be
// honest about it without waiting for a redeploy. A remote transcript is left
// alone: its bytes are not ours to stat.
func localTranscriptModifiedAt(s SessionProvenance) SessionProvenance {
	if s.Transcript.ModifiedAt != 0 || s.Transcript.Availability != "available_local" {
		return s
	}
	path := transcriptPathForReceipt(s.Transcript)
	if path == "" {
		return s
	}
	if info, err := os.Stat(path); err == nil {
		s.Transcript.ModifiedAt = info.ModTime().UnixMilli()
	}
	return s
}

// resolveProvenanceRows addresses a fiber once, then follows its intrinsic UID
// through the ledger. Fiber paths are historical strings: a rename must not
// strand old session rows. A ledger row can be the only address available for
// a remote fiber, so it is considered before the local felt view.
func resolveProvenanceRows(query string, records []SessionProvenance) (string, []SessionProvenance, *felt.Felt, error) {
	uid := ""
	for _, row := range records {
		if row.fiber() == query && row.UID != "" {
			uid = row.UID
			break
		}
	}
	var addressed *felt.Felt
	if uid == "" {
		uid = compositeFiberUID(query)
	}
	if uid == "" {
		if f, err := shuttleAddressFiber(query); err == nil {
			addressed = f
			uid = f.UID
		}
	}
	if uid == "" {
		return "", nil, addressed, fmt.Errorf("no fiber UID found for %q", query)
	}
	return uid, filterProvenanceRows(uid, records), addressed, nil
}

// filterProvenanceRows selects and dedupes the ledger rows for one intrinsic
// UID, folding dispatch/resume duplicates into ordered lifecycle events.
func filterProvenanceRows(uid string, records []SessionProvenance) []SessionProvenance {
	return foldProvenanceRows(records, func(row SessionProvenance) bool { return row.UID == uid })
}

// foldProvenanceRows collapses the ledger's per-moment lines into one row per
// session, keeping every moment as an ordered event.
//
// Dispatch/claim/resume lines are keyed by host+harness+session, the way they
// have always been. A `handoff` line carries neither harness nor tmux — the
// exiting worker writes only what it alone knows — so it folds onto whichever
// row already names its session, and stands as its own row only when it has
// none (a ledger whose dispatch line rotated away).
func foldProvenanceRows(records []SessionProvenance, keep func(SessionProvenance) bool) []SessionProvenance {
	index := map[string]int{}
	rows := make([]SessionProvenance, 0)
	for _, row := range records {
		if keep != nil && !keep(row) {
			continue
		}
		key := row.Host + "\x00" + row.Harness + "\x00" + row.Session
		if row.Kind == "handoff" {
			for i := range rows {
				if rows[i].Session == row.Session {
					key = rows[i].Host + "\x00" + rows[i].Harness + "\x00" + rows[i].Session
					break
				}
			}
		}
		if i, ok := index[key]; ok {
			rows[i].Events = append(rows[i].Events, SessionEvent{At: row.At, Kind: row.Kind, Fiber: row.fiber(), Tmux: row.Tmux})
			continue
		}
		row.Events = []SessionEvent{{At: row.At, Kind: row.Kind, Fiber: row.fiber(), Tmux: row.Tmux}}
		index[key] = len(rows)
		rows = append(rows, row)
	}
	for i := range rows {
		sort.SliceStable(rows[i].Events, func(a, b int) bool { return rows[i].Events[a].At < rows[i].Events[b].At })
	}
	return rows
}

func compositeFiberUID(query string) string {
	body, err := getDaemon(daemonURL()+"/api/v1/fibers/composite", daemonReadTimeout)
	if err != nil {
		return ""
	}
	var response struct {
		Fibers []struct {
			Path   string         `json:"path"`
			Origin string         `json:"origin,omitempty"`
			Fiber  map[string]any `json:"fiber"`
		} `json:"fibers"`
	}
	if json.Unmarshal(body, &response) != nil {
		return ""
	}
	for _, row := range response.Fibers {
		id, _ := row.Fiber["id"].(string)
		slug, _ := row.Fiber["slug"].(string)
		uid, _ := row.Fiber["uid"].(string)
		if uid == "" {
			uid = id
		}
		if row.Path == query || id == query || slug == query {
			return uid
		}
	}
	return ""
}

func compositeFiberRuntimePending(query string) bool {
	body, err := getDaemon(daemonURL()+"/api/v1/fibers/composite", daemonReadTimeout)
	if err != nil {
		return false
	}
	var response struct {
		Fibers []struct {
			Fiber map[string]any `json:"fiber"`
		} `json:"fibers"`
	}
	if json.Unmarshal(body, &response) != nil {
		return false
	}
	for _, row := range response.Fibers {
		slug, _ := row.Fiber["slug"].(string)
		id, _ := row.Fiber["id"].(string)
		if slug != query && id != query {
			continue
		}
		shuttleBlock, _ := row.Fiber["shuttle"].(map[string]any)
		dispatched, session := "", ""
		if value, ok := shuttleBlock["dispatched_at"].(string); ok {
			dispatched = value
		}
		if value, ok := shuttleBlock["session_uuid"].(string); ok {
			session = value
		}
		if runtime, ok := shuttleBlock["runtime"].(map[string]any); ok {
			if value, ok := runtime["dispatched_at"].(string); ok {
				dispatched = value
			}
			if value, ok := runtime["session_uuid"].(string); ok {
				session = value
			}
		}
		return strings.TrimSpace(dispatched) != "" && strings.TrimSpace(session) == ""
	}
	return false
}

func runtimeDispatched(f *felt.Felt) bool {
	if f == nil || f.ExtraFields == nil {
		return false
	}
	node, ok := f.ExtraFields["shuttle"]
	if !ok || node == nil {
		return false
	}
	var block map[string]any
	if err := node.Decode(&block); err != nil {
		return false
	}
	dispatched, session := "", ""
	if value, ok := block["dispatched_at"].(string); ok {
		dispatched = value
	}
	if value, ok := block["session_uuid"].(string); ok {
		session = value
	}
	if runtime, ok := block["runtime"].(map[string]any); ok {
		if value, ok := runtime["dispatched_at"].(string); ok {
			dispatched = value
		}
		if value, ok := runtime["session_uuid"].(string); ok {
			session = value
		}
	}
	return strings.TrimSpace(dispatched) != "" && strings.TrimSpace(session) == ""
}

func addIdentityPending(query, uid string, rows []SessionProvenance, addressed *felt.Felt) []SessionProvenance {
	if !runtimeDispatched(addressed) {
		return rows
	}
	return append(rows, SessionProvenance{
		Fiber: query,
		UID:   uid,
		Kind:  "identity_pending",
		Transcript: TranscriptReceipt{
			Availability: "identity_pending",
		},
	})
}

func applyOriginFreshness(rows []SessionProvenance, origins map[string]any) []SessionProvenance {
	for i := range rows {
		if raw, ok := origins[rows[i].Host].(map[string]any); ok {
			rows[i].Origin = rows[i].Host
			rows[i].Stale, _ = raw["stale"].(bool)
		}
	}
	return rows
}

// sessionOwner is the reverse-lookup result: from a session UUID or commit SHA
// back to the owning fiber and its disposition, drawn from the ledgers and the
// composite fiber feed — never from raw transcript text.
type sessionOwner struct {
	Query    string `json:"query"`
	Commit   string `json:"commit,omitempty"`
	Session  string `json:"session,omitempty"`
	Fiber    string `json:"fiber"`
	UID      string `json:"uid"`
	Status   string `json:"status,omitempty"`
	Tempered bool   `json:"tempered,omitempty"`
}

// commitSession joins a commit SHA (prefix accepted) to its recorded session
// through the composite commit ledger. "Not recorded" is the honest answer for
// commits made before the hook existed or outside a harness session — it is a
// coverage boundary, not proof the commit has no session.
func commitSession(sha string) (string, error) {
	body, err := getDaemon(daemonURL()+"/api/v1/commits/composite", daemonReadTimeout)
	if err != nil {
		return "", err
	}
	var response struct {
		Records []struct {
			SHA     string `json:"sha"`
			Session string `json:"session"`
		} `json:"records"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", fmt.Errorf("parsing commit ledger: %w", err)
	}
	needle := strings.ToLower(sha)
	matches := map[string]string{}
	for _, row := range response.Records {
		if strings.HasPrefix(strings.ToLower(row.SHA), needle) && row.Session != "" {
			matches[strings.ToLower(row.SHA)] = row.Session
		}
	}
	if len(matches) > 1 {
		shas := make([]string, 0, len(matches))
		for s := range matches {
			shas = append(shas, s[:12])
		}
		sort.Strings(shas)
		return "", fmt.Errorf("commit prefix %s is ambiguous in the commit ledger (%s); use a longer prefix", sha, strings.Join(shas, ", "))
	}
	for _, session := range matches {
		return session, nil
	}
	return "", fmt.Errorf("commit %s is not recorded in the commit ledger (commits before the hook existed, or outside a harness session, are not covered)", sha)
}

// sessionOwningFiber finds the ledger rows for a session UUID and returns the
// most recent fiber path plus the intrinsic UID.
func sessionOwningFiber(records []SessionProvenance, session string) (string, string, error) {
	fiber, uid := "", ""
	var at int64 = -1
	for _, row := range records {
		if row.Session != session {
			continue
		}
		if row.At >= at {
			at = row.At
			if row.fiber() != "" {
				fiber = row.fiber()
			}
			if row.UID != "" {
				uid = row.UID
			}
		}
	}
	if fiber == "" && uid == "" {
		return "", "", fmt.Errorf("session %s is not recorded in the session ledger (sessions before the ledger existed, or never paired with a fiber, are not covered)", session)
	}
	return fiber, uid, nil
}

// fiberDisposition reads status and the human verdict from the composite fiber
// feed. Absence of the fiber (e.g. deleted) leaves both zero-valued.
func fiberDisposition(uid string) (string, bool) {
	body, err := getDaemon(daemonURL()+"/api/v1/fibers/composite", daemonReadTimeout)
	if err != nil {
		return "", false
	}
	var response struct {
		Fibers []struct {
			Fiber map[string]any `json:"fiber"`
		} `json:"fibers"`
	}
	if json.Unmarshal(body, &response) != nil {
		return "", false
	}
	for _, row := range response.Fibers {
		id, _ := row.Fiber["id"].(string)
		rowUID, _ := row.Fiber["uid"].(string)
		if rowUID == "" {
			rowUID = id
		}
		if rowUID != uid {
			continue
		}
		status, _ := row.Fiber["status"].(string)
		tempered, _ := row.Fiber["tempered"].(bool)
		return status, tempered
	}
	return "", false
}

// transcriptManifest is the small local manifest written beside materialized
// transcripts: enough for an agent to pick a file and know its provenance
// without another daemon round-trip.
type transcriptManifest struct {
	Fiber    string                   `json:"fiber"`
	UID      string                   `json:"uid"`
	Sessions []transcriptManifestItem `json:"sessions"`
}

type transcriptManifestItem struct {
	Session      string         `json:"session"`
	Host         string         `json:"host,omitempty"`
	Harness      string         `json:"harness,omitempty"`
	Availability string         `json:"availability"`
	SourcePath   string         `json:"source_path,omitempty"`
	LocalPath    string         `json:"local_path,omitempty"`
	ByteCount    int64          `json:"byte_count,omitempty"`
	ModifiedAt   int64          `json:"modified_at,omitempty"`
	SHA256       string         `json:"sha256,omitempty"`
	Events       []SessionEvent `json:"events,omitempty"`
	Error        string         `json:"error,omitempty"`
}

// materializeFiberTranscripts resolves every available transcript to an
// ordinary local file (native path when local, verified cache copy when
// remote) and writes manifest.json into dir. Unavailable sessions stay in the
// manifest with their explicit availability — unavailable is never absent.
func materializeFiberTranscripts(fiber, uid string, rows []SessionProvenance, dir string) (string, error) {
	if dir == "" {
		cache, err := transcriptCacheDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(cache, "fibers", uid)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating manifest directory: %w", err)
	}
	manifest := transcriptManifest{Fiber: fiber, UID: uid}
	for _, row := range rows {
		item := transcriptManifestItem{
			Session:      row.Session,
			Host:         row.Transcript.Host,
			Harness:      row.Transcript.Harness,
			Availability: row.Transcript.Availability,
			SourcePath:   transcriptPathForReceipt(row.Transcript),
			ByteCount:    row.Transcript.ByteCount,
			ModifiedAt:   row.Transcript.ModifiedAt,
			SHA256:       row.Transcript.SHA256,
			Events:       row.Events,
		}
		if item.Host == "" {
			item.Host = row.Host
		}
		if item.Harness == "" {
			item.Harness = row.Harness
		}
		switch row.Transcript.Availability {
		case "available_local":
			item.LocalPath = transcriptPathForReceipt(row.Transcript)
			if item.LocalPath == "" {
				// Mirror the transcript command's guard: local-without-a-path
				// must read as an error, never as a silent absence.
				item.Error = "available_local but daemon returned no native path"
			}
		case "available_remote":
			path, err := fetchRemoteTranscript(row.Transcript)
			if err != nil {
				// A failed transfer is a distinct condition from an
				// unreachable host: keep the availability, record why the
				// local copy is missing.
				item.Error = err.Error()
			} else {
				item.LocalPath = path
			}
		}
		manifest.Sessions = append(manifest.Sessions, item)
	}
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(path, append(payload, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("writing manifest: %w", err)
	}
	return path, nil
}

var (
	sessionsCommitSHA   string
	sessionsMaterialize bool
	sessionsDir         string
	sessionsRecent      int
)

var shuttleSessionsCmd = &cobra.Command{
	Use:   "sessions <fiber|session-uuid>",
	Short: "Discover Shuttle sessions and transcript availability for a fiber",
	Long: `Reads Shuttle's composite session ledger and reports the sessions that
belong to a fiber UID, including historical fiber paths, host, harness, and explicit transcript
availability. It does not read or search transcript content; use the native
harness jq/rg recipes on the path returned by 'felt shuttle transcript'.

Reverse lookup: pass a session UUID instead of a fiber, or --commit <sha>, to
resolve the owning fiber and its disposition from the ledgers, then list that
fiber's sessions.

Each row carries its own clock: START is the first recorded moment (dispatch or
claim), END is the transcript file's last write when this host can stat it, SIZE
is that file's bytes, and EXIT reads "handoff" only when the worker recorded a
clean exit — a blank EXIT is a session that died mid-thought OR one that ran
before handoffs were recorded, and the two are deliberately not distinguished.

--recent [N] ignores the fiber argument and lists the newest N sessions across
the whole store, newest first — the "what ran last night?" view.

--materialize resolves every available transcript to an ordinary local file
(native path locally, verified cache copy for remote hosts) and writes a
manifest.json carrying session, host, harness, lineage events, source path,
and availability.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 && sessionsCommitSHA == "" && sessionsRecent == 0 {
			return fmt.Errorf("expected a fiber, a session UUID, --commit <sha>, or --recent")
		}
		ledger, err := fetchSessionLedger()
		if err != nil {
			return err
		}
		if sessionsRecent > 0 {
			return listRecentSessions(ledger, sessionsRecent)
		}
		query := ""
		if len(args) == 1 {
			query = args[0]
		}
		var owner *sessionOwner
		if sessionsCommitSHA != "" {
			session, err := commitSession(sessionsCommitSHA)
			if err != nil {
				return err
			}
			fiber, uid, err := sessionOwningFiber(ledger.Records, session)
			if err != nil {
				return err
			}
			owner = &sessionOwner{Query: query, Commit: sessionsCommitSHA, Session: session, Fiber: fiber, UID: uid}
			query = fiber
		} else if sessionUUIDPattern.MatchString(query) {
			fiber, uid, err := sessionOwningFiber(ledger.Records, query)
			if err != nil {
				return err
			}
			owner = &sessionOwner{Query: query, Session: query, Fiber: fiber, UID: uid}
			query = fiber
		}
		var uid string
		var rows []SessionProvenance
		var addressed *felt.Felt
		if owner != nil {
			owner.Status, owner.Tempered = fiberDisposition(owner.UID)
			if owner.UID != "" {
				// The ledger already told us the intrinsic UID; filter on it
				// directly rather than round-tripping through the fiber path,
				// which could resolve a different (renamed/reused/empty) fiber.
				uid = owner.UID
				rows = filterProvenanceRows(uid, ledger.Records)
				if query == "" {
					query = uid
				}
			}
		}
		if uid == "" {
			uid, rows, addressed, err = resolveProvenanceRows(query, ledger.Records)
			if err != nil {
				return err
			}
		}
		rows = addIdentityPending(query, uid, rows, addressed)
		if compositeFiberRuntimePending(query) {
			pending := true
			for _, row := range rows {
				if row.Kind == "identity_pending" {
					pending = false
					break
				}
			}
			if pending {
				rows = append(rows, SessionProvenance{Fiber: query, UID: uid, Kind: "identity_pending", Transcript: TranscriptReceipt{Availability: "identity_pending"}})
			}
		}
		rows = applyOriginFreshness(rows, ledger.Origins)
		for i := range rows {
			rows[i] = enrichSessionReceipt(rows[i])
		}
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].At != rows[j].At {
				return rows[i].At < rows[j].At
			}
			return rows[i].Session < rows[j].Session
		})
		rows = deriveSessionTimes(rows)
		manifestPath := ""
		if sessionsMaterialize {
			manifestPath, err = materializeFiberTranscripts(query, uid, rows, sessionsDir)
			if err != nil {
				return err
			}
		}
		if jsonOutput {
			if owner != nil || manifestPath != "" {
				return outputJSON(map[string]any{
					"owner":    owner,
					"manifest": manifestPath,
					"sessions": rows,
				})
			}
			return outputJSON(rows)
		}
		if owner != nil {
			disposition := owner.Status
			if disposition == "" {
				disposition = "unknown"
			}
			if owner.Tempered {
				disposition += " (tempered)"
			}
			fmt.Printf("owner: %s  uid: %s  disposition: %s\n", owner.Fiber, owner.UID, disposition)
		}
		if manifestPath != "" {
			fmt.Printf("manifest: %s\n", manifestPath)
		}
		if len(rows) == 0 {
			fmt.Printf("no recorded Shuttle sessions for %s\n", query)
			return nil
		}
		printSessionRows(rows)
		return nil
	},
}

// deriveSessionTimes fills the derived temporal fields so the table and the
// --json payload read the same row.
func deriveSessionTimes(rows []SessionProvenance) []SessionProvenance {
	for i := range rows {
		rows[i].StartedAt = rows[i].startedAt()
		rows[i].EndedAt = rows[i].endedAt()
		rows[i].HandedOffAt = rows[i].handedOffAt()
	}
	return rows
}

// listRecentSessions answers the recency question the per-fiber listing cannot:
// which sessions ran most recently anywhere in the store. The composite ledger
// is already one flat list of every host's lines, so this costs the same single
// fetch — only the transcript receipts (one daemon call per row) are bounded by
// the limit.
func listRecentSessions(ledger *sessionLedgerResponse, limit int) error {
	rows := foldProvenanceRows(ledger.Records, nil)
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].startedAt() != rows[j].startedAt() {
			return rows[i].startedAt() > rows[j].startedAt()
		}
		return rows[i].Session < rows[j].Session
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	rows = applyOriginFreshness(rows, ledger.Origins)
	for i := range rows {
		rows[i] = enrichSessionReceipt(rows[i])
	}
	rows = deriveSessionTimes(rows)
	if jsonOutput {
		return outputJSON(rows)
	}
	if len(rows) == 0 {
		fmt.Println("no recorded Shuttle sessions")
		return nil
	}
	printSessionRows(rows)
	return nil
}

const sessionRowFormat = "%-38s %-12s %-12s %-10s %-12s %-12s %-8s %-8s %-18s %s\n"

func printSessionRows(rows []SessionProvenance) {
	fmt.Printf(sessionRowFormat, "SESSION", "HOST", "HARNESS", "KIND", "START", "END", "SIZE", "EXIT", "AVAILABILITY", "FIBER")
	for _, row := range rows {
		fiberName := row.fiber()
		if row.Stale {
			fiberName += " [stale]"
		}
		exit := ""
		if row.HandedOffAt != 0 {
			exit = "handoff"
		}
		fmt.Printf(sessionRowFormat, row.Session, row.Host, row.Harness, row.Kind,
			formatSessionStamp(row.StartedAt), formatSessionStamp(row.EndedAt),
			formatSessionSize(row.byteCount()), exit, row.Transcript.Availability, fiberName)
	}
}

// formatSessionStamp renders a unix-millisecond instant in local time, minute
// resolution — enough to answer "which session ran last night?". An unrecorded
// instant prints blank rather than an epoch.
func formatSessionStamp(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).Local().Format("01-02 15:04")
}

// formatSessionSize renders transcript bytes in the units a person reads them
// in. A zero-byte or unstated transcript prints blank.
func formatSessionSize(bytes int64) string {
	switch {
	case bytes <= 0:
		return ""
	case bytes < 1024:
		return fmt.Sprintf("%dB", bytes)
	case bytes < 1024*1024:
		return fmt.Sprintf("%.0fK", float64(bytes)/1024)
	default:
		return fmt.Sprintf("%.1fM", float64(bytes)/(1024*1024))
	}
}

func transcriptPathForReceipt(receipt TranscriptReceipt) string {
	if receipt.SourcePath != "" {
		return receipt.SourcePath
	}
	return receipt.Path
}

func transcriptCacheDir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("FELT_TRANSCRIPT_CACHE_DIR")); dir != "" {
		return dir, nil
	}
	base := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME"))
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("locating transcript cache: %w", err)
		}
		base = filepath.Join(home, ".cache")
	}
	return filepath.Join(base, "felt", "transcripts"), nil
}

func transcriptCachePath(session string) (string, string, error) {
	dir, err := transcriptCacheDir()
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("creating transcript cache: %w", err)
	}
	// Keep the readable session id in the filename while appending a digest so
	// unusual IDs cannot escape the cache directory or collide after sanitising.
	name := strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(session)
	if name == "" {
		name = "session"
	}
	digest := sha256.Sum256([]byte(session))
	dest := filepath.Join(dir, name+"-"+hex.EncodeToString(digest[:6])+".jsonl")
	return dir, dest, nil
}

func fetchRemoteTranscript(receipt TranscriptReceipt) (string, error) {
	u, err := url.Parse(daemonURL() + "/api/v1/transcript/raw")
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("session", receipt.Session)
	if receipt.Host != "" {
		q.Set("host", receipt.Host)
	}
	u.RawQuery = q.Encode()
	client := &http.Client{Timeout: transcriptTransferTimeout}
	resp, err := client.Get(u.String())
	if err != nil {
		return "", fmt.Errorf("reaching daemon at %s: %w", u.String(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return "", daemonStatusError{url: u.String(), status: resp.StatusCode, body: strings.TrimSpace(string(body))}
	}
	dir, dest, err := transcriptCachePath(receipt.Session)
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".transcript-*")
	if err != nil {
		return "", fmt.Errorf("creating transcript cache temp file: %w", err)
	}
	tmpName := tmp.Name()
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return "", fmt.Errorf("protecting transcript cache: %w", err)
	}
	hasher := sha256.New()
	count, err := io.Copy(io.MultiWriter(tmp, hasher), resp.Body)
	if err != nil {
		return "", fmt.Errorf("streaming transcript response: %w", err)
	}
	// The raw response headers describe this exact byte snapshot. Prefer them
	// over the earlier metadata receipt because a live transcript can grow
	// between the two requests. Zero is a valid, complete transcript size, so
	// track header presence separately from its numeric value.
	wantBytes, haveBytes := int64(0), false
	if header := resp.Header.Get("X-Transcript-Byte-Count"); header != "" {
		parsed, parseErr := strconv.ParseInt(strings.TrimSpace(header), 10, 64)
		if parseErr != nil || parsed < 0 {
			return "", fmt.Errorf("transcript %s: invalid byte-count receipt %q", receipt.Session, header)
		}
		wantBytes, haveBytes = parsed, true
	} else if receipt.ByteCount > 0 {
		wantBytes, haveBytes = receipt.ByteCount, true
	} else if receipt.Size > 0 {
		wantBytes, haveBytes = receipt.Size, true
	}
	if !haveBytes {
		return "", fmt.Errorf("transcript %s: daemon omitted byte_count", receipt.Session)
	}
	if count != wantBytes {
		return "", fmt.Errorf("transcript %s: byte count %d does not match daemon receipt %d", receipt.Session, count, wantBytes)
	}
	wantHash := strings.ToLower(strings.TrimSpace(resp.Header.Get("X-Transcript-SHA256")))
	if wantHash == "" {
		wantHash = strings.ToLower(strings.TrimSpace(receipt.SHA256))
	}
	if wantHash == "" {
		return "", fmt.Errorf("transcript %s: daemon omitted sha256", receipt.Session)
	}
	if hex.EncodeToString(hasher.Sum(nil)) != wantHash {
		return "", fmt.Errorf("transcript %s: sha256 does not match daemon receipt", receipt.Session)
	}
	if err := tmp.Sync(); err != nil {
		return "", fmt.Errorf("syncing transcript cache: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("closing transcript cache: %w", err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return "", fmt.Errorf("installing transcript cache: %w", err)
	}
	keep = true
	return dest, nil
}

func transcriptHost(session string) (string, error) {
	ledger, err := fetchSessionLedger()
	if err != nil {
		return "", err
	}
	hosts := map[string]bool{}
	for _, row := range ledger.Records {
		if row.Session == session && row.Host != "" {
			hosts[row.Host] = true
		}
	}
	if len(hosts) > 1 {
		values := make([]string, 0, len(hosts))
		for host := range hosts {
			values = append(values, host)
		}
		sort.Strings(values)
		return "", fmt.Errorf("session %s is recorded on multiple hosts (%s); specify an unambiguous session lineage", session, strings.Join(values, ", "))
	}
	for host := range hosts {
		return host, nil
	}
	return "", nil
}

var sessionUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type transcriptCommandResult struct {
	Session      string `json:"session"`
	Availability string `json:"availability"`
	Host         string `json:"host,omitempty"`
	Harness      string `json:"harness,omitempty"`
	SourcePath   string `json:"source_path,omitempty"`
	LocalPath    string `json:"local_path,omitempty"`
	ByteCount    int64  `json:"byte_count,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
}

func transcriptResult(receipt TranscriptReceipt, localPath string) transcriptCommandResult {
	return transcriptCommandResult{
		Session: receipt.Session, Availability: receipt.Availability,
		Host: receipt.Host, Harness: receipt.Harness,
		SourcePath: transcriptPathForReceipt(receipt), LocalPath: localPath,
		ByteCount: receipt.ByteCount, SHA256: receipt.SHA256,
	}
}

var shuttleTranscriptCmd = &cobra.Command{
	Use:   "transcript <session-id>",
	Short: "Print a session's native transcript path or materialize its remote copy",
	Long: `Resolves a complete native transcript by session ID. When the transcript
is on this host, prints its original native path. When it is remote, streams the
exact bytes through Shuttle's native transcript surface into the managed
felt cache and prints that ordinary local path. Use jq/rg/tail to inspect it.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !sessionUUIDPattern.MatchString(args[0]) {
			return fmt.Errorf("invalid session ID %q: expected a UUID", args[0])
		}
		host, err := transcriptHost(args[0])
		if err != nil {
			return err
		}
		receipt, err := fetchTranscriptReceipt(args[0], host)
		if err != nil {
			return err
		}
		if receipt.Session == "" {
			receipt.Session = args[0]
		}
		if jsonOutput {
			return runTranscriptJSON(receipt)
		}
		switch receipt.Availability {
		case "available_local":
			path := transcriptPathForReceipt(receipt)
			if path == "" {
				return fmt.Errorf("transcript %s is available_local but daemon returned no native path", args[0])
			}
			fmt.Println(path)
			return nil
		case "available_remote":
			path, err := fetchRemoteTranscript(receipt)
			if err != nil {
				return fmt.Errorf("transferring transcript %s from %s: %w", args[0], receipt.Host, err)
			}
			fmt.Println(path)
			return nil
		case "identity_pending", "host_unreachable", "transcript_missing":
			return fmt.Errorf("transcript %s: %s", args[0], receipt.Availability)
		default:
			if receipt.Availability == "" {
				return fmt.Errorf("transcript %s: daemon returned no availability state", args[0])
			}
			return fmt.Errorf("transcript %s: %s", args[0], receipt.Availability)
		}
	},
}

func runTranscriptJSON(receipt TranscriptReceipt) error {
	if receipt.Availability != "available_remote" {
		localPath := ""
		if receipt.Availability == "available_local" {
			localPath = transcriptPathForReceipt(receipt)
		}
		return outputJSON(transcriptResult(receipt, localPath))
	}
	path, err := fetchRemoteTranscript(receipt)
	if err != nil {
		return err
	}
	// JSON consumers receive both the resolution receipt and the materialized
	// ordinary path; source_path remains the authoritative native location.
	return outputJSON(transcriptResult(receipt, path))
}

func init() {
	shuttleSessionsCmd.Flags().StringVar(&sessionsCommitSHA, "commit", "", "reverse lookup: resolve a commit SHA (prefix accepted) to its owning fiber via the commit ledger")
	shuttleSessionsCmd.Flags().BoolVar(&sessionsMaterialize, "materialize", false, "resolve every available transcript to an ordinary local file and write manifest.json")
	shuttleSessionsCmd.Flags().IntVar(&sessionsRecent, "recent", 0, "ignore the fiber argument and list the newest N sessions across the whole store (default 20 when the flag is given bare)")
	shuttleSessionsCmd.Flags().Lookup("recent").NoOptDefVal = "20"
	shuttleSessionsCmd.Flags().StringVar(&sessionsDir, "dir", "", "directory for the materialized manifest.json (default: the felt transcript cache, keyed by fiber UID); remote transcript copies always land in the shared felt cache")
	shuttleCmd.AddCommand(shuttleSessionsCmd)
	shuttleCmd.AddCommand(shuttleTranscriptCmd)
}
