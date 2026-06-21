package cmd

import (
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// The `felt shuttle <verb>` command group is felt's active/weaving mode: the
// dispatch surface absorbed from the standalone shuttle-ctl. Grouping it under
// `shuttle` keeps `felt --help` about notes and `felt shuttle --help` about
// dispatch, and the group name is also the on-disk block name (`shuttle:`) and
// the runtime namespace — one word, three roles. The verbs are reimplemented on
// felt's own internals (resolve -> read -> mutate -> validate -> write), not on a
// copied fiber-I/O layer; felt owns the data model.

// shuttleFeltStore mirrors shuttle-ctl's --felt-store flag. The networked daemon
// shells the lifecycle verbs as `shuttle-ctl --felt-store <store> <verb>`, reached
// (post-cutover) through the transitional `shuttle-ctl` -> `felt shuttle` shim, so
// `felt shuttle` must honor that exact flag. It is an alias for felt's -C store
// selector: a PersistentPreRun feeds it into the same `changeDir` the rest of the
// cmd package resolves the store from, so no verb needs store logic of its own.
var shuttleFeltStore string

var shuttleCmd = &cobra.Command{
	Use:   "shuttle",
	Short: "Agent dispatch — the felt tree's active mode",
	Long: `felt shuttle is the dispatch surface over the felt tree: the verbs that
install, schedule, pause, and hand off the agent-scheduled facet of a fiber.

A fiber carries the shuttle: facet or it does not — with it, the fiber is a
task/role the daemon can dispatch; without it, a pure note. These verbs write
and read that facet. Write verbs validate the block before touching disk and
work offline; the daemon-coupled read verbs (snapshot, dispatch, status --all)
talk to the local daemon's :4000 API.`,
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
	rootCmd.AddCommand(shuttleCmd)
}

// shuttleResolveFiber resolves a fiber id/query to its fiber within the active
// store (honoring --felt-store / -C and the cwd scope). full controls whether the
// body is parsed: write verbs that re-serialize the whole fiber need it (so the
// body survives the write); metadata-only callers (path lookups, status) skip it.
func shuttleResolveFiber(query string, full bool) (*felt.Felt, *felt.Storage, error) {
	root, err := resolveProjectRoot()
	if err != nil {
		return nil, nil, err
	}
	st := felt.NewStorage(root)
	scope := resolveCommandScope(root)
	var f *felt.Felt
	if full {
		f, err = st.FindInScope(scope, query)
	} else {
		f, err = st.FindMetadataInScope(scope, query)
	}
	if err != nil {
		return nil, nil, err
	}
	return f, st, nil
}
