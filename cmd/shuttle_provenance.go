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
	seen := map[string]bool{}
	rows := make([]SessionProvenance, 0)
	for _, row := range records {
		if row.UID != uid {
			continue
		}
		key := row.Host + "\x00" + row.Harness + "\x00" + row.Session
		if seen[key] {
			for i := range rows {
				if rows[i].Host+"\x00"+rows[i].Harness+"\x00"+rows[i].Session == key {
					rows[i].Events = append(rows[i].Events, SessionEvent{At: row.At, Kind: row.Kind, Fiber: row.fiber(), Tmux: row.Tmux})
					break
				}
			}
			continue
		}
		seen[key] = true
		row.Events = []SessionEvent{{At: row.At, Kind: row.Kind, Fiber: row.fiber(), Tmux: row.Tmux}}
		rows = append(rows, row)
	}
	for i := range rows {
		sort.SliceStable(rows[i].Events, func(a, b int) bool { return rows[i].Events[a].At < rows[i].Events[b].At })
	}
	return uid, rows, addressed, nil
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

var shuttleSessionsCmd = &cobra.Command{
	Use:   "sessions <fiber>",
	Short: "Discover Shuttle sessions and transcript availability for a fiber",
	Long: `Reads Shuttle's composite session ledger and reports the sessions that
belong to a fiber UID, including historical fiber paths, host, harness, and explicit transcript
availability. It does not read or search transcript content; use the native
harness jq/rg recipes on the path returned by 'felt shuttle transcript'.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ledger, err := fetchSessionLedger()
		if err != nil {
			return err
		}
		uid, rows, addressed, err := resolveProvenanceRows(args[0], ledger.Records)
		if err != nil {
			return err
		}
		rows = addIdentityPending(args[0], uid, rows, addressed)
		if compositeFiberRuntimePending(args[0]) {
			pending := true
			for _, row := range rows {
				if row.Kind == "identity_pending" {
					pending = false
					break
				}
			}
			if pending {
				rows = append(rows, SessionProvenance{Fiber: args[0], UID: uid, Kind: "identity_pending", Transcript: TranscriptReceipt{Availability: "identity_pending"}})
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
		if jsonOutput {
			return outputJSON(rows)
		}
		if len(rows) == 0 {
			fmt.Printf("no recorded Shuttle sessions for %s\n", args[0])
			return nil
		}
		fmt.Printf("%-38s %-16s %-16s %-14s %-18s %s\n", "SESSION", "HOST", "HARNESS", "KIND", "AVAILABILITY", "FIBER")
		for _, row := range rows {
			fiberName := row.fiber()
			if row.Stale {
				fiberName += " [stale]"
			}
			fmt.Printf("%-38s %-16s %-16s %-14s %-18s %s\n", row.Session, row.Host, row.Harness, row.Kind, row.Transcript.Availability, fiberName)
		}
		return nil
	},
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
	shuttleCmd.AddCommand(shuttleSessionsCmd)
	shuttleCmd.AddCommand(shuttleTranscriptCmd)
}
