package cmd

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// The cross-host arm of `felt shuttle status` — `--all` (local + every remote) and
// `--remote NAME` (one remote) — rendered from the local daemon's
// /api/v1/state/composite response. The daemon's RemoteRegistry is the single
// source of truth for remote configuration and freshness; the CLI just asks one
// daemon for the merged picture and renders rows, so remote configs never leak into
// felt.
//
// Origin semantics:
//   - Local rows have Origin == "" (kept omitempty in JSON for back-compat with the
//     single-host status output).
//   - Remote rows have Origin == "<remote name>" (e.g. "candide").
//
// A remote daemon's snapshot only enumerates what is running, retrying, or a
// standing role — not idle/scheduled one-shot fibers. Cross-host rows therefore
// reflect runtime state, not the full installed-fiber inventory; the local table
// (felt-native, this machine's full inventory) is unchanged, so the laptop's
// installed fibers stay visible alongside remote runtime. Ported from shuttle-ctl's
// status_cross_host.go.

// runStatusCrossHost handles `--all` (local + every remote) and `--remote NAME`
// (filter to one remote). It fetches the composite state from the local daemon,
// renders rows, and prints them.
func runStatusCrossHost() error {
	composite, err := fetchComposite()
	if err != nil {
		return err
	}
	if statusRemote != "" {
		if _, ok := composite.Remotes[statusRemote]; !ok {
			return fmt.Errorf("unknown origin %q; configured: local, %s", statusRemote, joinNames(composite.Remotes))
		}
	}

	rows := compositeRows(composite, statusRemote)

	sort.Slice(rows, func(i, j int) bool {
		// Local first, then remotes alphabetically; within each origin sort by
		// fiber_id so the table is stable across runs.
		if rows[i].Origin != rows[j].Origin {
			if rows[i].Origin == "" {
				return true
			}
			if rows[j].Origin == "" {
				return false
			}
			return rows[i].Origin < rows[j].Origin
		}
		return rows[i].FiberID < rows[j].FiberID
	})

	if jsonOutput {
		return outputJSON(rows)
	}

	printCrossHostTable(rows, composite, statusRemote)
	return nil
}

// compositeRows folds a composite response into FiberStatus rows. When `only` is
// non-empty, local rows are dropped and only that one remote's rows are emitted; an
// unknown remote name yields an empty list rather than an error so JSON consumers
// see [] (the user notices the empty render and can re-check the remote name).
func compositeRows(c *CompositeState, only string) []FiberStatus {
	var rows []FiberStatus

	if only == "" && c.Local != nil {
		rows = append(rows, snapshotToRows("", c.Local, false)...)
	}

	for name, rs := range c.Remotes {
		if only != "" && name != only {
			continue
		}
		if summary := remoteSummaryRow(name, rs); summary != nil {
			rows = append(rows, *summary)
		}
		if rs == nil || rs.Snapshot == nil {
			continue
		}
		rows = append(rows, snapshotToRows(name, rs.Snapshot, rs.Stale)...)
	}

	return rows
}

func snapshotToRows(origin string, snap *Snapshot, stale bool) []FiberStatus {
	var rows []FiberStatus

	for _, e := range snap.Eligible {
		// Active workers from the daemon's `eligible` (running) list.
		state := e.State
		if state == "" {
			state = "running"
		}
		rows = append(rows, FiberStatus{
			FiberID: e.FiberID,
			Origin:  origin,
			Agent:   e.Agent,
			State:   state,
			Running: true,
			Session: e.TmuxSession,
			Stale:   stale,
		})
	}

	for _, r := range snap.Retrying {
		rows = append(rows, FiberStatus{
			FiberID: r.FiberID,
			Origin:  origin,
			State:   "retrying",
			Stale:   stale,
		})
	}

	for _, sr := range snap.StandingRoles {
		state := sr.State
		if state == "" {
			state = "scheduled"
		}
		// Standing roles don't carry agent in the snapshot — frontmatter is the
		// source. The local-only `status` path reads it from felt; the cross-host
		// path leaves it empty (renders as `(default)`).
		row := FiberStatus{
			FiberID: sr.FiberID,
			Origin:  origin,
			Kind:    "standing",
			State:   state,
			Stale:   stale,
		}
		if sr.NextDueAt != nil {
			row.NextDueAt = formatUnixMS(*sr.NextDueAt)
		}
		if sr.LastRunAt != nil {
			row.LastRunAt = formatUnixMS(*sr.LastRunAt)
		}
		rows = append(rows, row)
	}

	return rows
}

func remoteSummaryRow(name string, rs *RemoteSnapshot) *FiberStatus {
	if rs == nil {
		return &FiberStatus{Origin: name, State: "unknown", Stale: true}
	}
	if rec := rs.Recovery; rec != nil && rec.State != "" && rec.State != "healthy" {
		return &FiberStatus{Origin: name, State: recoveryStateLabel(rec)}
	}
	if rs.Snapshot == nil {
		// Remote configured but never successfully polled — emit a placeholder row
		// so the user sees the host exists and is stale. Without this, an
		// unreachable remote is silently missing from the table.
		return &FiberStatus{Origin: name, State: staleStateLabel(rs), Stale: true}
	}
	return nil
}

// staleStateLabel summarizes a never-polled remote's status.
func staleStateLabel(rs *RemoteSnapshot) string {
	if rs == nil {
		return "unknown"
	}
	if rs.LastError != "" {
		return "stale (" + rs.LastError + ")"
	}
	return "stale"
}

func recoveryStateLabel(rec *RemoteRecovery) string {
	if rec == nil || rec.State == "" {
		return "unknown"
	}

	switch rec.State {
	case "reviving", "degraded":
		detail := rec.LastAction
		if detail == "" {
			detail = rec.LastError
		}
		if detail == "" {
			detail = "recovering"
		}
		attempt := rec.Attempt
		if attempt <= 0 {
			attempt = 1
		}
		return fmt.Sprintf("%s (attempt %d: %s)", rec.State, attempt, detail)
	case "unreachable":
		if next := relativeRetry(rec.NextRetryAt); next != "" {
			return fmt.Sprintf("unreachable (next: %s)", next)
		}
		if rec.LastError != "" {
			return "unreachable (" + rec.LastError + ")"
		}
		return "unreachable"
	default:
		return rec.State
	}
}

func relativeRetry(ts string) string {
	if ts == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts
	}
	delta := time.Until(parsed)
	if delta <= 0 {
		return "now"
	}
	if delta < time.Minute {
		secs := int(delta.Round(time.Second) / time.Second)
		if secs < 1 {
			secs = 1
		}
		return fmt.Sprintf("%ds", secs)
	}
	if delta < time.Hour {
		mins := int(delta.Round(time.Minute) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return fmt.Sprintf("%dm", mins)
	}
	hours := int(delta.Round(time.Hour) / time.Hour)
	if hours < 1 {
		hours = 1
	}
	return fmt.Sprintf("%dh", hours)
}

func formatUnixMS(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

// printCrossHostTable renders the cross-host status table. It mirrors
// printStatusTable's shape but adds an ORIGIN column on the left so the per-host
// grouping is obvious at a glance. Stale rows get a "[stale]" suffix in the STATE
// column.
func printCrossHostTable(rows []FiberStatus, c *CompositeState, only string) {
	if len(rows) == 0 {
		if only != "" {
			fmt.Printf("no rows for remote %q (configured: %s)\n",
				only, joinNames(c.Remotes))
		} else {
			fmt.Println("no shuttle fibers (local or remote)")
		}
		return
	}

	fmt.Printf("%-12s  %-50s  %-9s  %-16s  %-18s  %s\n",
		"ORIGIN", "FIBER", "KIND", "STATE", "NEXT_DUE_AT", "AGENT")
	fmt.Println(strings.Repeat("─", 122))

	for _, r := range rows {
		origin := r.Origin
		if origin == "" {
			origin = "(local)"
		}
		agent := r.Agent
		if agent == "" {
			agent = "(default)"
		}
		next := r.NextDueAt
		if next == "" {
			next = "-"
		}
		kind := r.Kind
		if kind == "" {
			kind = "-"
		}
		state := r.State
		if r.Stale {
			state = state + " [stale]"
		}
		fmt.Printf("%-12s  %-50s  %-9s  %-16s  %-18s  %s\n",
			shuttleTruncateID(origin, 12), shuttleTruncateID(r.FiberID, 50), kind, state, next, agent)
	}
}

func joinNames(remotes map[string]*RemoteSnapshot) string {
	names := make([]string, 0, len(remotes))
	for n := range remotes {
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "<none>"
	}
	out := names[0]
	for _, n := range names[1:] {
		out += ", " + n
	}
	return out
}
