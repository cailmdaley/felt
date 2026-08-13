package cmd

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// The local-read verbs — status and ps — reimplemented on felt's own data model.
// Where shuttle-ctl shelled `felt -C <store> ls --json` per configured store, felt
// lists in-process: felt.NewStorage(store).ListMetadataHavingFrontmatterFields
// over each store the daemon would poll (shuttleStores), keeping only fibers that
// carry a well-formed shuttle: facet. Liveness comes from tmux. Ported faithfully
// from shuttle-ctl's cmd/shuttle/status.go.
//
// The cross-host arm (--all / --remote, which queries the daemon's
// /api/v1/state/composite) is the daemon-HTTP slice (Stage 3.3), not here; this is
// the local view only.

var (
	statusIncludeOrphans bool
	statusAll            bool
	statusRemote         string
)

// FiberStatus is one row of the status output. Origin is reserved for the
// cross-host rows the 3.3 daemon-HTTP arm adds; it is empty for every local row.
type FiberStatus struct {
	FiberID   string `json:"fiber_id"`
	Origin    string `json:"origin,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Agent     string `json:"agent,omitempty"`
	State     string `json:"state"`
	Running   bool   `json:"running"`
	Session   string `json:"session,omitempty"`
	NextDueAt string `json:"next_due_at,omitempty"`
	LastRunAt string `json:"last_run_at,omitempty"`
	Stale     bool   `json:"stale,omitempty"`
}

// shuttleEntry is one shuttle-bearing fiber discovered by the in-process walk.
type shuttleEntry struct {
	FiberID string
	UID     string
	Status  string
	Path    string
	Block   *shuttle.Block
}

var statusCmd = &cobra.Command{
	Use:   "status [fiber]",
	Short: "Status overview, or a detailed report for one fiber",
	Long: `With no argument, prints one line per fiber that carries a shuttle: facet,
across the felt stores this machine dispatches (the -C / --felt-store store when
set, otherwise the configured stores: FELT_STORES env, then the
~/.config/felt/stores.json registry). Liveness is read from tmux.

Columns: fiber_id  kind  state  next_due_at  agent

With a fiber argument, prints the detailed single-fiber report instead: the whole
shuttle: block, plus whether the daemon will dispatch it and — when it won't —
the verb that changes that. This is the way to check one role's state before
reaching for a mutation verb.

  felt shuttle status                 # the table
  felt shuttle status <fiber>         # one fiber, in full

Cross-host (queries the local daemon's /api/v1/state/composite):
  --all           local plus every configured remote (composite snapshot).
  --remote NAME   only the named remote.

The daemon's RemoteRegistry polls each remote over its SSH-tunnel-mapped port;
the CLI just renders that response. Rows from a remote carry an "origin" column;
stale remotes (the registry hasn't heard back recently) are flagged "[stale]".

Other flags:
  --include-orphans  also list live Shuttle tmux sessions that no longer map to a
                     shuttle: facet (rare; useful after manual cleanup).
  --json             emit an array of objects instead.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// The single-fiber report is a local read of one fiber, so the flags that
		// shape the multi-fiber walk have nothing to act on.
		if len(args) == 1 {
			for _, flag := range []string{"all", "remote", "include-orphans"} {
				if cmd.Flags().Changed(flag) {
					return fmt.Errorf("--%s applies to the status table, not to a single fiber; drop it or drop the fiber argument", flag)
				}
			}
			return runStatusOneFiber(args[0])
		}

		// Cross-host paths route through the local daemon; --remote and --all are
		// mutually exclusive (--remote NAME implies "filter to one").
		if statusAll || statusRemote != "" {
			return runStatusCrossHost()
		}

		stores, err := shuttleStores()
		if err != nil {
			return err
		}
		entries, err := listShuttleFibersAcrossStores(stores)
		if err != nil {
			return fmt.Errorf("listing fibers: %w", err)
		}

		live := liveTmuxSessions()
		owners := sessionOwnerMap(entries)

		rows := make([]FiberStatus, 0, len(entries))
		seenSessions := map[string]bool{}
		for _, entry := range entries {
			// The canonical (uid-keyed) name is the row's display session, but
			// liveness recognizes either form so a worker launched before the
			// uid-keyed cutover still reads as running.
			session := shuttleTmuxSessionName(entry.FiberID, entry.UID)
			running := false
			for _, candidate := range shuttleTmuxSessionNames(entry.FiberID, entry.UID) {
				if live[candidate] && owners[candidate] == entry.FiberID {
					running = true
					session = candidate
					seenSessions[candidate] = true
					break
				}
			}
			rows = append(rows, FiberStatus{
				FiberID: entry.FiberID,
				Kind:    entry.Block.Kind,
				Agent:   entry.Block.Agent,
				State:   computeState(entry.Block, entry.Status, running),
				Running: running,
				Session: session,
			})
		}

		// Optionally surface live sessions not matched to any shuttle: facet.
		if statusIncludeOrphans {
			for session := range live {
				if !seenSessions[session] {
					rows = append(rows, FiberStatus{
						FiberID: session,
						State:   "running",
						Running: true,
						Session: session,
					})
				}
			}
		}

		sort.Slice(rows, func(i, j int) bool { return rows[i].FiberID < rows[j].FiberID })

		if jsonOutput {
			return outputJSON(rows)
		}
		printStatusTable(rows)
		return nil
	},
}

var psCmd = &cobra.Command{
	Use:   "ps",
	Short: "Live tmux worker sessions",
	Long:  "Prints one line per live Shuttle tmux worker session (and the fiber it owns, when resolvable).",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		live := liveTmuxSessions()
		if len(live) == 0 {
			if jsonOutput {
				return outputJSON([]map[string]string{})
			}
			fmt.Println("no live shuttle workers")
			return nil
		}

		// Best-effort owner attribution: a listing failure leaves sessions
		// unattributed rather than failing ps (the live set is the point).
		owners := map[string]string{}
		if stores, err := shuttleStores(); err == nil {
			if entries, err := listShuttleFibersAcrossStores(stores); err == nil {
				owners = sessionOwnerMap(entries)
			}
		}

		type row struct{ session, fiberID string }
		rows := make([]row, 0, len(live))
		for session := range live {
			rows = append(rows, row{session: session, fiberID: owners[session]})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].session < rows[j].session })

		if jsonOutput {
			out := make([]map[string]string, len(rows))
			for i, r := range rows {
				item := map[string]string{"session": r.session}
				if r.fiberID != "" {
					item["fiber_id"] = r.fiberID
				}
				out[i] = item
			}
			return outputJSON(out)
		}

		for _, r := range rows {
			if r.fiberID != "" {
				fmt.Printf("%-40s  %s\n", r.session, r.fiberID)
			} else {
				fmt.Println(r.session)
			}
		}
		return nil
	},
}

// ---- single-fiber report ---------------------------------------------------

// runStatusOneFiber prints the detailed report for one fiber: the whole block,
// then the question the report exists to answer — will the daemon dispatch this,
// and if not, what moves it. Read-only, and it never locks: a fiber can be
// inspected while a worker holds it.
func runStatusOneFiber(query string) error {
	f, _, err := shuttleResolveFiber(query, false)
	if err != nil {
		return err
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("fiber %s has no shuttle: block (use 'felt shuttle install' / 'repeat' / 'pin' to create one)", query)
	}

	statusNow := f.Status
	armed := statusNow == felt.StatusActive
	session, running := liveWorkerSession(f)

	if jsonOutput {
		out := map[string]any{
			"fiber_id": f.ID,
			"kind":     block.Kind,
			"host":     block.Host,
			"status":   statusNow,
			"armed":    armed,
			"running":  running,
			"dispatch": dispatchAssessment(f.ID, statusNow),
		}
		if block.Agent != "" {
			out["agent"] = block.Agent
		}
		if block.ProjectDir != "" {
			out["project_dir"] = block.ProjectDir
		}
		if block.Schedule != nil {
			out["schedule"] = map[string]string{"expr": block.Schedule.Expr, "tz": block.Schedule.TZ}
		}
		if running {
			out["session"] = session
		}
		return outputJSON(out)
	}

	fmt.Printf("shuttle: fiber %s\n\n", f.ID)
	writeBlockSummary(os.Stdout, block, statusNow, armed)
	if running {
		fmt.Printf("  worker:      running (tmux %s)\n", session)
	}
	fmt.Println("")
	fmt.Println(dispatchAssessment(f.ID, statusNow))
	return nil
}

// dispatchAssessment renders the one line a single-fiber report is really for:
// whether the daemon will pick this fiber up, and the verb that changes the
// answer when it won't. Dispatch is gated by the felt-native status alone.
func dispatchAssessment(fiberID, statusNow string) string {
	switch statusNow {
	case felt.StatusActive:
		return "→ Daemon will dispatch on next poll. No action needed."
	case felt.StatusClosed:
		return fmt.Sprintf("→ Fiber is closed — daemon will NOT dispatch. Use `felt shuttle reopen %s` to clear verdict fields and requeue it.", fiberID)
	case felt.StatusOpen:
		return fmt.Sprintf("→ Draft (status: open). Use `felt shuttle resume %s` to arm it.", fiberID)
	case "":
		return fmt.Sprintf("→ Status missing — daemon will NOT dispatch. Use `felt shuttle resume %s` or set status: active in the markdown.", fiberID)
	default:
		return fmt.Sprintf("→ Status %q is not armed — daemon will NOT dispatch. Use `felt shuttle resume %s` to set status: active.", statusNow, fiberID)
	}
}

// liveWorkerSession reports the tmux session holding this fiber's worker, if
// any — recognizing both the canonical uid-keyed name and the legacy leaf-only
// one, exactly as the table's liveness check does.
func liveWorkerSession(f *felt.Felt) (string, bool) {
	for _, candidate := range shuttleTmuxSessionNames(f.ID, f.UID) {
		if tmuxSessionExists(candidate) {
			return candidate, true
		}
	}
	return "", false
}

// writeBlockSummary writes the human-readable "Current block:" report. Dispatch
// eligibility is the felt-native status alone (status:active = armed).
func writeBlockSummary(out io.Writer, b *shuttle.Block, statusNow string, armed bool) {
	fmt.Fprintln(out, "Current block:")
	fmt.Fprintf(out, "  kind:        %s\n", shuttleNonEmpty(b.Kind, "(unset)"))
	fmt.Fprintf(out, "  host:        %s\n", shuttleNonEmpty(b.Host, "(unset — NOT eligible on any daemon)"))
	if b.Agent != "" {
		fmt.Fprintf(out, "  agent:       %s\n", b.Agent)
	}
	if b.ProjectDir != "" {
		fmt.Fprintf(out, "  project_dir: %s\n", b.ProjectDir)
	}
	if b.Schedule != nil {
		fmt.Fprintf(out, "  schedule:    %q tz=%s\n", b.Schedule.Expr, b.Schedule.TZ)
	}

	switch {
	case statusNow == "":
		fmt.Fprintln(out, "  status:      (missing — NOT armed; resume or set status: active in the markdown)")
	case statusNow == felt.StatusClosed:
		fmt.Fprintln(out, "  status:      closed (NOT armed — daemon ignores closed fibers)")
	case statusNow == felt.StatusOpen:
		fmt.Fprintln(out, "  status:      open (draft — NOT armed; resume to dispatch)")
	case armed:
		fmt.Fprintf(out, "  status:      %s (armed)\n", statusNow)
	default:
		fmt.Fprintf(out, "  status:      %s\n", statusNow)
	}
}

// ---- helpers ---------------------------------------------------------------

// listShuttleFibersAcrossStores walks each store in-process and merges the
// shuttle-bearing fibers, deduplicating by intrinsic identity (UID, falling back
// to the symlink-resolved path) — the same fiber is reachable from both the
// aggregate store and its project-canonical store, so a cross-store walk would
// otherwise double-count it. A per-store failure is non-fatal: log to stderr and
// continue, matching the daemon's best-effort per-store scan; only an all-stores
// failure surfaces an error.
func listShuttleFibersAcrossStores(stores []string) ([]shuttleEntry, error) {
	if len(stores) == 0 {
		return nil, fmt.Errorf("no felt stores configured")
	}
	merged := make([]shuttleEntry, 0)
	seen := map[string]bool{}
	var firstErr error
	for _, store := range stores {
		entries, err := listShuttleFibers(store)
		if err != nil {
			fmt.Fprintf(os.Stderr, "shuttle: store %q: %v\n", store, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, e := range entries {
			key := e.UID
			if key == "" {
				key = e.Path
			}
			if key == "" {
				key = e.FiberID
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, e)
		}
	}
	if len(merged) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return merged, nil
}

// listShuttleFibers reads one store's metadata, prefiltered to fibers whose
// frontmatter carries a top-level shuttle: key, and keeps those with a
// well-formed (typed-decodable) shuttle facet. A malformed block is skipped (it
// is not a dispatchable role), matching the daemon's is_map + decode gate.
func listShuttleFibers(store string) ([]shuttleEntry, error) {
	storage := felt.NewStorage(store)
	felts, err := storage.ListMetadataHavingFrontmatterFields([]string{felt.ShuttleFacetKey})
	if err != nil {
		return nil, err
	}
	entries := make([]shuttleEntry, 0, len(felts))
	for _, f := range felts {
		block, ok, err := f.ShuttleBlock()
		if err != nil || !ok || block == nil {
			continue
		}
		// Report the dispatch-canonical (nearest-.felt) id, not felt's
		// outer-aggregate id, so a status fiber_id matches the daemon's identity
		// and round-trips into a daemon-routed write verb. Falls back to felt's
		// native id if the path is not under a resolvable .felt store.
		id := f.ID
		if canonical, err := canonicalFiberID(f.Path); err == nil && canonical != "" {
			id = canonical
		}
		entries = append(entries, shuttleEntry{
			FiberID: id,
			UID:     f.UID,
			Status:  f.Status,
			Path:    f.Path,
			Block:   block,
		})
	}
	return entries, nil
}

// sessionOwnerMap maps every session-name form a fiber could carry — uid-keyed
// canonical and legacy leaf-only — back to its fiber id. Closed fibers are
// excluded (no live worker to attribute). The uid-keyed names are collision-free;
// the legacy leaf-only names keep a collision guard: two open fibers sharing a
// leaf drop out of the map rather than mis-attributing a live worker.
func sessionOwnerMap(entries []shuttleEntry) map[string]string {
	owners := map[string]string{}
	collisions := map[string]bool{}
	for _, entry := range entries {
		if entry.Status == felt.StatusClosed {
			continue
		}
		for _, session := range shuttleTmuxSessionNames(entry.FiberID, entry.UID) {
			if existing, ok := owners[session]; ok && existing != entry.FiberID {
				delete(owners, session)
				collisions[session] = true
				continue
			}
			if !collisions[session] {
				owners[session] = entry.FiberID
			}
		}
	}
	return owners
}

// computeState derives the display state from tmux liveness and the felt-native
// status (the sole lifecycle axis). A closed fiber collapses to "closed" — the
// finer awaiting/accepted/composted verdict is the tempered field the bulk
// listing does not carry; the kanban makes that call.
func computeState(b *shuttle.Block, status string, running bool) string {
	if running {
		return "running"
	}
	switch status {
	case felt.StatusOpen:
		return "paused"
	case felt.StatusClosed:
		return "closed"
	case felt.StatusActive:
		if b.Kind == "standing" {
			return "scheduled"
		}
		return "idle"
	default:
		return shuttleNonEmpty(status, "unknown")
	}
}

func printStatusTable(rows []FiberStatus) {
	if len(rows) == 0 {
		fmt.Println("no shuttle fibers")
		return
	}
	fmt.Printf("%-50s  %-9s  %-14s  %-18s  %s\n", "FIBER", "KIND", "STATE", "NEXT_DUE_AT", "AGENT")
	fmt.Println(strings.Repeat("─", 110))
	for _, r := range rows {
		agent := shuttleNonEmpty(r.Agent, "(default)")
		next := shuttleNonEmpty(r.NextDueAt, "-")
		fmt.Printf("%-50s  %-9s  %-14s  %-18s  %s\n",
			shuttleTruncateID(r.FiberID, 50), r.Kind, r.State, next, agent)
	}
}

// shuttleTruncateID truncates a fiber id to n runes, keeping the SUFFIX (the leaf
// distinguishes sibling fibers) with a leading ellipsis when clipped.
func shuttleTruncateID(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-(n-1):]
}

func registerShuttleStatusFlags() {
	statusCmd.Flags().BoolVar(&statusIncludeOrphans, "include-orphans", false,
		"Also list live Shuttle tmux sessions with no matching shuttle: facet")
	statusCmd.Flags().BoolVar(&statusAll, "all", false,
		"Show local plus all configured remotes (queries daemon /api/v1/state/composite)")
	statusCmd.Flags().StringVar(&statusRemote, "remote", "",
		"Show only the named remote (queries daemon /api/v1/state/composite)")
	statusCmd.MarkFlagsMutuallyExclusive("all", "remote")
}

func init() {
	registerShuttleStatusFlags()
	shuttleCmd.AddCommand(statusCmd)
	shuttleCmd.AddCommand(psCmd)
}
