package cmd

import (
	"fmt"
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
	Use:   "status",
	Short: "One-line-per-fiber status overview",
	Long: `Prints one line per fiber that carries a shuttle: facet, across the felt
stores this machine dispatches (the -C / --felt-store store when set, otherwise
the configured stores: LOOM_HOMES, the ~/.shuttle/felt_stores.json registry, then
~/loom). Liveness is read from tmux.

Columns: fiber_id  kind  state  next_due_at  agent

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
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
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

// ---- helpers ---------------------------------------------------------------

// listShuttleFibersAcrossStores walks each store in-process and merges the
// shuttle-bearing fibers, deduplicating by intrinsic identity (UID, falling back
// to the symlink-resolved path) — the same fiber is reachable from both the
// ~/loom aggregate and its project-canonical store, so a cross-store walk would
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
