package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

func addShuttleCommand(command *cobra.Command) {
	switch command.Name() {
	case "agents":
		command.GroupID = groupAgents
	case "daemon", "host", "remotes", "tunnels", "version":
		command.GroupID = groupHosts
	default:
		command.GroupID = groupOperations
	}
	rootCmd.AddCommand(command)
}

// shuttleResolveFiber resolves a fiber id or path in the selected store. Full
// reads preserve the body for write operations; metadata-only reads serve
// address and status lookups.
func shuttleResolveFiber(query string, full bool) (*felt.Felt, *felt.Storage, error) {
	f, storage, _, err := shuttleResolveFiberRef(query, full)
	return f, storage, err
}

func shuttleResolveFiberRef(query string, full bool) (*felt.Felt, *felt.Storage, felt.Ref, error) {
	root, err := felt.ProjectRoot(sysenv.OS(), changeDir)
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	storage := felt.NewStorage(root)
	ref, err := felt.ResolveRef(storage, felt.CommandScope(sysenv.OS(), root, changeDir), query)
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	var fiber *felt.Felt
	if full {
		fiber, err = ref.Storage.FindInScope("", ref.ID)
	} else {
		fiber, err = ref.Storage.FindMetadataInScope("", ref.ID)
	}
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	return fiber, ref.Storage, ref, nil
}
