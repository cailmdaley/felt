package cmd

import (
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// The `felt shuttle <verb>` command group is felt's active/weaving mode: the
// dispatch surface. Grouping it under `shuttle` keeps `felt --help` about notes and `felt shuttle --help` about
// dispatch, and the group name is also the on-disk block name (`shuttle:`) and
// the runtime namespace — one word, three roles. The verbs are reimplemented on
// felt's own internals (resolve -> read -> mutate -> validate -> write), not on a
// copied fiber-I/O layer; felt owns the data model.

// shuttleFeltStore is --felt-store, the store selector the daemon passes when
// it shells `felt shuttle --felt-store <store> <verb>`
// (daemon/lib/shuttle/felt/shuttle.ex). It is an alias for felt's -C: a
// PersistentPreRun feeds it into the same `changeDir` the rest of the cmd
// package resolves the store from, so no verb needs store logic of its own.
var shuttleFeltStore string

var shuttleCmd = &cobra.Command{
	Use:   "shuttle",
	Short: "Agent dispatch — the felt tree's active mode",
	Long: `A fiber with a shuttle: block is work the daemon dispatches to an agent;
without one it is a note. These verbs install, schedule, pause, and hand off
that block. Write verbs validate before touching disk and work offline.
snapshot, dispatch, sessions, transcript, message, validate-identity, and
felt shuttle status --all talk to the local daemon (127.0.0.1:4000 or a unix
socket; see felt shuttle host).

Common paths:
  felt shuttle install <fiber> --project-dir "$PWD"   dispatch a fiber once
  felt shuttle status <fiber>                         its block, and where it is eligible to dispatch
  felt shuttle attach <fiber>                         the worker's live tmux session
  felt shuttle sessions                               addressable sessions across the fleet
  felt shuttle message <address> "text"               deliver to a session and wake it
  felt shuttle send-file <path>                       offer a file on Shuttle's board
  felt shuttle handoff <fiber>                        a worker's last call: exit cleanly`,
	// Map --felt-store onto felt's -C store selector before any verb runs, so the
	// daemon's `--felt-store <store>` invocations resolve through felt's existing
	// store-resolution path unchanged.
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if shuttleFeltStore != "" && changeDir == "" {
			changeDir = shuttleFeltStore
		}
		return nil
	},
}

func init() {
	shuttleCmd.PersistentFlags().StringVar(&shuttleFeltStore, "felt-store", "",
		"Felt store root (directory containing .felt/); alias for -C")
	shuttleCmd.GroupID = groupAgents
	rootCmd.AddCommand(shuttleCmd)
}

// shuttleResolveFiber resolves a fiber id/query to its fiber within the active
// store (honoring --felt-store / -C and the cwd scope). full controls whether the
// body is parsed: write verbs that re-serialize the whole fiber need it (so the
// body survives the write); metadata-only callers (path lookups) skip it.
//
// This is the cwd-sensitive resolver the write verbs use: it requires a store
// context (-C or a cwd felt repo), matching the daemon's invocation (it always
// passes --felt-store). The from-anywhere address verbs (session-name, attach)
// use shuttleAddressFiber instead, which defaults to the configured loom stores.
//
// An id that names a fiber in the enclosing store is not refused: shuttle
// verbs cross the view boundary on the same terms rm and edit do — the
// operation runs in the store that holds the fiber, and the returned ref's
// location() suffix says where, so a cross-store write is never silent.
func shuttleResolveFiber(query string, full bool) (*felt.Felt, *felt.Storage, error) {
	f, st, _, err := shuttleResolveFiberRef(query, full)
	return f, st, err
}

func shuttleResolveFiberRef(query string, full bool) (*felt.Felt, *felt.Storage, fiberRef, error) {
	root, err := resolveProjectRoot()
	if err != nil {
		return nil, nil, fiberRef{}, err
	}
	st := felt.NewStorage(root)
	ref, err := resolveFiberRef(st, resolveCommandScope(root), query)
	if err != nil {
		return nil, nil, fiberRef{}, err
	}
	var f *felt.Felt
	if full {
		f, err = ref.storage.FindInScope("", ref.id)
	} else {
		f, err = ref.storage.FindMetadataInScope("", ref.id)
	}
	if err != nil {
		return nil, nil, fiberRef{}, err
	}
	return f, ref.storage, ref, nil
}
