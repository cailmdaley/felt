package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	histShowEditorial  bool
	histShowMechanical bool
	histKindFilter     string
	histLast           int
	histSince          string
	histUntil          string

	histAppendSummary string
	histAppendActor   string
	histAppendKind    string
	histAppendFields  []string

	histBackfillDryRun bool
)

var historyCmd = &cobra.Command{
	Use:   "history <id>",
	Short: "Show the append-only event log for a fiber",
	Long: `Renders the history of a fiber.

By default returns editorial events (agent-written prose notes) in
reverse-chronological order, in markdown form. Mechanical events
(add/edit/external_edit) can be included with --mechanical or shown
exclusively with --no-editorial.

The log is append-only; each event is one row. Editorial events carry
prose; mechanical events carry size deltas and a content hash.

Examples:
  felt history pure_eb/aa-submission                      # editorial chain
  felt history pure_eb --last 3                            # last 3 editorial events
  felt history pure_eb --mechanical                        # editorial + mechanical
  felt history pure_eb --mechanical --no-editorial         # mechanical only
  felt history pure_eb --since 2026-04-01

The append subcommand records a new editorial event:

  felt history append pure_eb --summary "Refit covariance, χ² stable to ±2."
  felt history append <fiber> --summary "$(cat hand-off.md)"`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}
		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		target, err := storage.FindMetadataInScope(scopeID, args[0])
		if err != nil {
			return err
		}

		filter, err := buildHistoryFilter(cmd, target.ID)
		if err != nil {
			return err
		}

		// History rows live in the append-only history_events table; reading
		// them must not force a full fiber/FTS index sync or take the
		// writer-oriented schema path.
		idx, err := storage.OpenIndexReadOnly()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if jsonOutput {
					return outputJSON([]felt.Event{})
				}
				fmt.Print(renderHistory(target.ID, target.DisplayName(), nil))
				return nil
			}
			if errors.Is(err, felt.ErrIndexBusy) {
				fmt.Fprintf(os.Stderr, "warning: index busy — history unavailable\n")
				if jsonOutput {
					return outputJSON([]felt.Event{})
				}
				return nil
			}
			return err
		}
		defer idx.Close()

		events, err := idx.QueryEvents(filter)
		if err != nil {
			return err
		}

		if jsonOutput {
			return outputJSON(events)
		}

		fmt.Print(renderHistory(target.ID, target.DisplayName(), events))
		return nil
	},
}

var historyAppendCmd = &cobra.Command{
	Use:   "append <id>",
	Short: "Record an editorial event on a fiber",
	Long: `Appends an editorial history event to a fiber.

Editorial events are agent-written prose summaries — what happened in
this session, where the work stands, what the next worker should know.
They're the continuity surface read by 'felt history --last 1'.

Multiple appends per session are fine when they mark sub-session
boundaries (after a major decision, before continuing).

Use --kind to file a typed editorial event (e.g. 'review-comment') for
inter-agent or human→agent directives. Typed events are filterable on
the read side via 'felt history <id> --kind <type>' so dispatchers
(shuttle) can surface the latest directive of a given kind separately
from the regular editorial handoff chain.

Examples:
  felt history append pure_eb --summary "Refit covariance with hartlap; χ² shifts +0.7."
  felt history append <fiber> --summary "$(cat hand-off.md)"
  felt history append <fiber> --kind review-comment --summary "Use DES weights, not Planck."`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		summary := strings.TrimSpace(histAppendSummary)
		if !cmd.Flags().Changed("summary") {
			// --summary not provided — try reading from stdin.
			// When the flag is explicitly set (even to ""), skip stdin so that
			// callers like the kanban can write payload-only events (e.g. a
			// review-comment carrying only resume_mode) without hanging.
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("read summary from stdin: %w", err)
			}
			summary = strings.TrimSpace(string(data))
			if summary == "" {
				return fmt.Errorf("--summary is required (or pipe the summary on stdin)")
			}
		}
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}
		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		target, err := storage.FindMetadataInScope(scopeID, args[0])
		if err != nil {
			return err
		}

		// Soft size warning. Editorial events that bloat probably want to
		// be sub-fibers; we still file the event.
		if len(summary) > felt.EditorialSoftSizeLimit {
			fmt.Fprintf(os.Stderr,
				"warning: editorial summary is %d bytes (soft limit %d). "+
					"Consider filing the long content as a sub-fiber and "+
					"linking from a shorter summary.\n",
				len(summary), felt.EditorialSoftSizeLimit)
		}

		idx, err := storage.OpenIndexNoSync()
		if err != nil {
			return err
		}
		defer idx.Close()

		actor := strings.TrimSpace(histAppendActor)
		if actor == "" {
			actor = felt.DefaultActor()
		}

		// CLI flag stays --summary (natural for the writer: "summarize
		// what just happened"); the payload key is "text" — the
		// editorial event IS the summary, so naming its body field
		// "summary" was recursive. Old events use "summary"; readers
		// fall back when the canonical key is absent.
		payload := map[string]interface{}{
			felt.EditorialTextKey: summary,
		}

		// --field key=value (repeatable) merges arbitrary string fields into
		// the event payload. Lets typed events (e.g. review-comment) carry
		// integration-specific metadata that downstream readers (shuttle
		// dispatcher, portolan kanban, etc.) can pick up. Reserved keys
		// cannot be overridden; other keys with the same name are
		// last-write-wins across the slice.
		for _, kv := range histAppendFields {
			eq := strings.IndexByte(kv, '=')
			if eq <= 0 {
				return fmt.Errorf("--field %q: expected key=value", kv)
			}
			key := strings.TrimSpace(kv[:eq])
			val := kv[eq+1:]
			if key == "" {
				return fmt.Errorf("--field %q: empty key", kv)
			}
			switch key {
			case felt.EditorialTextKey, felt.EditorialTextKeyLegacy:
				return fmt.Errorf("--field %q: reserved key, use the dedicated flag", key)
			}
			payload[key] = val
		}

		// --kind selects the event_type. Default is the canonical
		// "editorial" event; agents and integrations may file typed events
		// (e.g. "review-comment") that the read side can filter via the
		// existing --kind flag on `felt history`. Mechanical kinds
		// (add/edit/rm/external_edit) are reserved for storage-layer use
		// and rejected here so the editorial namespace stays separate.
		kind := strings.TrimSpace(histAppendKind)
		if kind == "" {
			kind = felt.EventEditorial
		} else {
			switch kind {
			case felt.EventAdd, felt.EventEdit, felt.EventExternalEdit:
				return fmt.Errorf(
					"--kind %q is reserved for mechanical events written by felt itself",
					kind)
			}
		}

		event := felt.Event{
			FiberID: target.ID,
			Type:    kind,
			Actor:   actor,
			Payload: payload,
		}
		if err := idx.AppendEvent(event); err != nil {
			return err
		}

		if kind == felt.EventEditorial {
			fmt.Printf("Appended editorial event on %s\n", target.ID)
		} else {
			fmt.Printf("Appended %s event on %s\n", kind, target.ID)
		}
		return nil
	},
}

var historyBackfillCmd = &cobra.Command{
	Use:   "backfill",
	Short: "Anchor event-less fibers in the history log at their created-at",
	Long: `Gives every fiber with no history events a synthetic 'add' event.

felt's recency signal (SessionStart ordering, kanban) reads the history log,
not file mtime — mtime is destroyed by the clone/checkout/reorg rewrites that
cross-machine git sync inflicts. Fibers created before the history log existed
have no events and would sort by their created-at fallback only; this gives
them a durable anchor.

The synthetic event is stamped at the fiber's recency anchor — frontmatter
updated-at when present, else created-at — NOT its file mtime, which post-reorg
collapses to a single instant and would re-pollute the very signal this exists
to protect. Fibers that already have at least one event are left untouched, so
running this twice is a no-op.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}
		storage := felt.NewStorage(root)
		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}

		// OpenIndexNoSync: skip Sync so its mtime-stamped bootstrap can't fire
		// for these fibers before we anchor them at created-at ourselves.
		idx, err := storage.OpenIndexNoSync()
		if err != nil {
			return err
		}
		defer idx.Close()

		var anchored []string
		for _, f := range felts {
			count, err := idx.EventCount(f.ID)
			if err != nil {
				return err
			}
			if count > 0 {
				continue
			}
			if histBackfillDryRun {
				anchored = append(anchored, f.ID)
				continue
			}
			hash, err := felt.HashFile(storage.Path(f.ID))
			if err != nil {
				return err
			}
			if err := idx.AppendEvent(felt.Event{
				FiberID:     f.ID,
				OccurredAt:  f.RecencyAnchor(),
				Type:        felt.EventAdd,
				Actor:       "backfill",
				ContentHash: hash,
				Payload: map[string]interface{}{
					"bootstrap": true,
					"backfill":  true,
				},
			}); err != nil {
				return err
			}
			anchored = append(anchored, f.ID)
		}

		if len(anchored) == 0 {
			fmt.Println("No history backfill needed")
			return nil
		}
		if histBackfillDryRun {
			for _, id := range anchored {
				fmt.Printf("Would anchor %s\n", id)
			}
			fmt.Printf("Dry run: %d fibers would be anchored\n", len(anchored))
			return nil
		}
		for _, id := range anchored {
			fmt.Printf("Anchored %s\n", id)
		}
		fmt.Printf("Anchored %d fibers in the history log\n", len(anchored))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(historyCmd)
	historyCmd.AddCommand(historyAppendCmd)
	historyCmd.AddCommand(historyBackfillCmd)

	historyCmd.Flags().BoolVar(&histShowEditorial, "editorial", true,
		"Include editorial (prose) events (default true)")
	historyCmd.Flags().BoolVar(&histShowMechanical, "mechanical", false,
		"Include mechanical (add/edit/rm/external_edit) events")
	historyCmd.Flags().StringVar(&histKindFilter, "kind", "",
		"Filter to a specific event type; overrides --editorial/--mechanical")
	historyCmd.Flags().IntVarP(&histLast, "last", "n", 0,
		"Limit to the most recent N events (0 = no cap)")
	historyCmd.Flags().StringVar(&histSince, "since", "",
		"Only events at or after this timestamp (RFC3339 or YYYY-MM-DD)")
	historyCmd.Flags().StringVar(&histUntil, "until", "",
		"Only events at or before this timestamp (RFC3339 or YYYY-MM-DD)")

	historyAppendCmd.Flags().StringVarP(&histAppendSummary, "summary", "m", "",
		"Editorial summary text (or pipe on stdin)")
	historyAppendCmd.Flags().StringVar(&histAppendActor, "actor", "",
		"Override actor identity (default: $FELT_AGENT@<host> or <host>)")
	historyAppendCmd.Flags().StringVar(&histAppendKind, "kind", "",
		"Event type to record (default: editorial; e.g. 'review-comment'). "+
			"Mechanical kinds (add/edit/rm/external_edit) are reserved.")
	historyAppendCmd.Flags().StringArrayVar(&histAppendFields, "field", nil,
		"Repeatable: add a key=value field to the event payload "+
			"(e.g. --field resume_mode=previous). Reserved keys: text, summary.")

	historyBackfillCmd.Flags().BoolVar(&histBackfillDryRun, "dry-run", false,
		"Print which fibers would be anchored without writing events")
}

func buildHistoryFilter(cmd *cobra.Command, fiberID string) (felt.EventFilter, error) {
	filter := felt.EventFilter{
		FiberID:    fiberID,
		Descending: true,
	}

	// --kind overrides the editorial/mechanical split: it selects a specific
	// event_type directly. The --editorial and --mechanical flags are ignored
	// when --kind is set.
	if kind := strings.TrimSpace(histKindFilter); kind != "" {
		filter.Types = []string{kind}
		// Apply time + limit filters and return early.
		if err := applyTimeFilters(cmd, &filter); err != nil {
			return filter, err
		}
		return filter, nil
	}

	editorial := histShowEditorial
	mechanical := histShowMechanical
	// If the user passed --no-editorial we want mechanical-only — make
	// sure that combination is honored even when --mechanical wasn't
	// explicitly set (a user typing --no-editorial almost certainly wants
	// the mechanical view).
	if !editorial && !mechanical {
		mechanical = true
	}

	switch {
	case editorial && !mechanical:
		filter.Types = []string{felt.EventEditorial}
	case !editorial && mechanical:
		filter.Types = []string{
			felt.EventAdd,
			felt.EventEdit,
			felt.EventExternalEdit,
		}
	default:
		// both — leave Types nil to fetch everything
	}

	if err := applyTimeFilters(nil, &filter); err != nil {
		return filter, err
	}
	return filter, nil
}

// applyTimeFilters populates Since, Until, and Limit on a filter from the
// global flag vars. cmd is accepted for interface consistency but not used —
// we read global flag vars directly since Cobra flag bindings go to package
// vars. Caller may pass nil.
func applyTimeFilters(_ interface{}, filter *felt.EventFilter) error {
	if v := strings.TrimSpace(histSince); v != "" {
		t, err := parseHistoryTime(v)
		if err != nil {
			return fmt.Errorf("--since: %w", err)
		}
		filter.Since = t
	}
	if v := strings.TrimSpace(histUntil); v != "" {
		t, err := parseHistoryTime(v)
		if err != nil {
			return fmt.Errorf("--until: %w", err)
		}
		filter.Until = t
	}
	if histLast > 0 {
		filter.Limit = histLast
	}
	return nil
}

func parseHistoryTime(s string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized time %q (use RFC3339 or YYYY-MM-DD)", s)
}

// renderHistory produces the human-readable markdown output for
// `felt history`. Editorial events get full block treatment; mechanical
// events get a one-liner.
func renderHistory(id, name string, events []felt.Event) string {
	var sb strings.Builder
	if name != "" && name != id {
		fmt.Fprintf(&sb, "# %s — %s\n\n", name, id)
	} else {
		fmt.Fprintf(&sb, "# %s\n\n", id)
	}
	if len(events) == 0 {
		sb.WriteString("(no history events recorded)\n")
		return sb.String()
	}
	// Newest first to match the kanban / vellum orientation.
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].OccurredAt.Equal(events[j].OccurredAt) {
			return events[i].RowID > events[j].RowID
		}
		return events[i].OccurredAt.After(events[j].OccurredAt)
	})
	for i, e := range events {
		switch e.Type {
		case felt.EventEditorial:
			fmt.Fprintf(&sb, "## %s — %s\n\n",
				e.OccurredAt.Local().Format("2006-01-02 15:04 MST"),
				e.Actor)
			sb.WriteString(strings.TrimSpace(editorialText(e.Payload)))
			sb.WriteString("\n\n")
		default:
			sb.WriteString(formatMechanicalEvent(e, mechRenderOpts{padType: true, withChars: true}))
			sb.WriteString("\n")
		}
		if i < len(events)-1 && e.Type == felt.EventEditorial {
			// Add a separator between editorial blocks for readability.
			sb.WriteString("---\n\n")
		}
	}
	return sb.String()
}

// renderRecentEditorial returns at most one most-recent editorial event
// formatted for the felt-show "Recent" section. Returns empty string
// when there is no editorial event.
func renderRecentEditorial(events []felt.Event) string {
	for _, e := range events {
		if e.Type == felt.EventEditorial {
			text := editorialText(e.Payload)
			var sb strings.Builder
			fmt.Fprintf(&sb, "Recent:   %s — %s\n",
				e.OccurredAt.Local().Format("2006-01-02 15:04"),
				e.Actor)
			for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
				fmt.Fprintf(&sb, "          %s\n", line)
			}
			return sb.String()
		}
	}
	return ""
}

// editorialText returns the prose body of an editorial event. Reads the
// canonical "text" key first, falls back to "summary" for events written
// before the rename. Returns empty string when neither is present.
func editorialText(payload map[string]interface{}) string {
	if v := stringField(payload, felt.EditorialTextKey); v != "" {
		return v
	}
	return stringField(payload, felt.EditorialTextKeyLegacy)
}

func shortHash(h string) string {
	if len(h) <= 8 {
		return h
	}
	return h[:8]
}

func stringField(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func intField(m map[string]interface{}, key string) int {
	if m == nil {
		return 0
	}
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case int:
			return n
		case int64:
			return int(n)
		case float64:
			return int(n)
		}
	}
	return 0
}

func stringSliceField(m map[string]interface{}, key string) []string {
	if m == nil {
		return nil
	}
	v, ok := m[key]
	if !ok {
		return nil
	}
	switch arr := v.(type) {
	case []string:
		return arr
	case []interface{}:
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
