package cmd

import (
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
	histLast           int
	histSince          string
	histUntil          string

	histAppendSummary  string
	histAppendActor    string
	histAppendEditFrom string
	histAppendEditTo   string
)

var historyCmd = &cobra.Command{
	Use:   "history <id>",
	Short: "Show the append-only event log for a fiber",
	Long: `Renders the history of a fiber.

By default returns editorial events (agent-written prose summaries) in
reverse-chronological order, in markdown form. Mechanical events
(add/edit/rm/external_edit) can be included with --mechanical or shown
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

  felt history append pure_eb --summary "Refit covariance, χ² stable to ±2."`,
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

		idx, err := storage.OpenIndex()
		if err != nil {
			return err
		}
		defer idx.Close()

		filter, err := buildHistoryFilter(cmd, target.ID)
		if err != nil {
			return err
		}
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

Examples:
  felt history append pure_eb --summary "Refit covariance with hartlap; χ² shifts +0.7."
  felt history append constitution-shuttle --summary "$(cat hand-off.md)"`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		summary := strings.TrimSpace(histAppendSummary)
		if summary == "" {
			// Allow piping the summary on stdin if no flag set.
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("read summary from stdin: %w", err)
			}
			summary = strings.TrimSpace(string(data))
		}
		if summary == "" {
			return fmt.Errorf("--summary is required (or pipe the summary on stdin)")
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

		payload := map[string]interface{}{
			"summary": summary,
		}
		if strings.TrimSpace(histAppendEditFrom) != "" {
			payload["edit_window_start"] = strings.TrimSpace(histAppendEditFrom)
		}
		if strings.TrimSpace(histAppendEditTo) != "" {
			payload["edit_window_end"] = strings.TrimSpace(histAppendEditTo)
		}

		event := felt.Event{
			FiberID: target.ID,
			Type:    felt.EventEditorial,
			Actor:   actor,
			Payload: payload,
		}
		if err := idx.AppendEvent(event); err != nil {
			return err
		}

		fmt.Printf("Appended editorial event on %s\n", target.ID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(historyCmd)
	historyCmd.AddCommand(historyAppendCmd)

	historyCmd.Flags().BoolVar(&histShowEditorial, "editorial", true,
		"Include editorial (prose) events (default true)")
	historyCmd.Flags().BoolVar(&histShowMechanical, "mechanical", false,
		"Include mechanical (add/edit/rm/external_edit) events")
	historyCmd.Flags().IntVarP(&histLast, "last", "n", 0,
		"Limit to the most recent N events (0 = no cap)")
	historyCmd.Flags().StringVar(&histSince, "since", "",
		"Only events at or after this timestamp (RFC3339 or YYYY-MM-DD)")
	historyCmd.Flags().StringVar(&histUntil, "until", "",
		"Only events at or before this timestamp (RFC3339 or YYYY-MM-DD)")

	historyAppendCmd.Flags().StringVarP(&histAppendSummary, "summary", "m", "",
		"Editorial summary text (or pipe on stdin)")
	historyAppendCmd.Flags().StringVar(&histAppendActor, "actor", "",
		"Override actor identity (default: $FELT_AGENT or user@host)")
	historyAppendCmd.Flags().StringVar(&histAppendEditFrom, "edit-window-start", "",
		"Optional: lower bound of the mechanical edit window this event summarizes (RFC3339)")
	historyAppendCmd.Flags().StringVar(&histAppendEditTo, "edit-window-end", "",
		"Optional: upper bound of the mechanical edit window this event summarizes (RFC3339)")
}

func buildHistoryFilter(cmd *cobra.Command, fiberID string) (felt.EventFilter, error) {
	filter := felt.EventFilter{
		FiberID:    fiberID,
		Descending: true,
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
			felt.EventRm,
			felt.EventExternalEdit,
		}
	default:
		// both — leave Types nil to fetch everything
	}

	if v := strings.TrimSpace(histSince); v != "" {
		t, err := parseHistoryTime(v)
		if err != nil {
			return filter, fmt.Errorf("--since: %w", err)
		}
		filter.Since = t
	}
	if v := strings.TrimSpace(histUntil); v != "" {
		t, err := parseHistoryTime(v)
		if err != nil {
			return filter, fmt.Errorf("--until: %w", err)
		}
		filter.Until = t
	}
	if histLast > 0 {
		filter.Limit = histLast
	}
	return filter, nil
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
			summary := stringField(e.Payload, "summary")
			sb.WriteString(strings.TrimSpace(summary))
			sb.WriteString("\n\n")
		default:
			fmt.Fprintf(&sb, "%s [%-13s %s] hash=%s",
				e.OccurredAt.Local().Format("2006-01-02 15:04:05"),
				e.Type,
				e.Actor,
				shortHash(e.ContentHash),
			)
			if lines := intField(e.Payload, "size_lines"); lines > 0 {
				fmt.Fprintf(&sb, " (%d lines", lines)
				if chars := intField(e.Payload, "size_chars"); chars > 0 {
					fmt.Fprintf(&sb, ", %d chars", chars)
				}
				sb.WriteString(")")
			}
			if fields := stringSliceField(e.Payload, "fields_changed"); len(fields) > 0 {
				fmt.Fprintf(&sb, " — %s", strings.Join(fields, ","))
			}
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
			summary := stringField(e.Payload, "summary")
			var sb strings.Builder
			fmt.Fprintf(&sb, "Recent:   %s — %s\n",
				e.OccurredAt.Local().Format("2006-01-02 15:04"),
				e.Actor)
			for _, line := range strings.Split(strings.TrimSpace(summary), "\n") {
				fmt.Fprintf(&sb, "          %s\n", line)
			}
			return sb.String()
		}
	}
	return ""
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
