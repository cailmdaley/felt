package cmd

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

const collaborationField = "collaboration"

var (
	assignCollaborator       string
	assignCollaboratorOrigin string
	assignRole               string
	assignRoleOrigin         string
	assignClearCollaborator  bool
	assignClearRole          bool
	assignClear              bool
	assignJSON               string
)

var assignCmd = &cobra.Command{
	Use:   "assign <fiber>",
	Short: "Assign an optional collaborator and role to a fiber",
	Long: `Stores a project-owned collaboration assignment without changing the fiber's
status or shuttle runtime state. A collaborator and role are durable profile
fibers, addressed only by their intrinsic UID plus owning host; the command does
not read or resolve those profiles locally.

Use --json-assignment for an atomic controller-facing replacement:
  {"collaborator":{"uid":"<ULID>","origin":"<host>"},"role":{"uid":"<ULID>","origin":"<host>"}}

The paired flags patch one reference while preserving the other. Use
--clear-collaborator, --clear-role, or --clear to remove assignments.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, ref, err := shuttleResolveFiberRef(args[0], true)
		if err != nil {
			return err
		}
		f, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()

		changed, err := applyCollaborationFlags(cmd, f)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("assign: pass an assignment, a clear flag, or --json-assignment")
		}
		f.Touch(time.Now())
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("updated collaboration for %s%s\n", args[0], ref.location())
		return nil
	},
}

func applyCollaborationFlags(cmd *cobra.Command, f *felt.Felt) (bool, error) {
	jsonSet := cmd.Flags().Changed("json-assignment")
	clearSet := cmd.Flags().Changed("clear")
	patchNames := []string{"collaborator", "collaborator-origin", "role", "role-origin", "clear-collaborator", "clear-role"}
	patchSet := false
	for _, name := range patchNames {
		patchSet = patchSet || cmd.Flags().Changed(name)
	}
	if (jsonSet && (clearSet || patchSet)) || (clearSet && patchSet) {
		return false, fmt.Errorf("assign: --json-assignment, --clear, and reference patch flags are mutually exclusive")
	}
	if clearSet && !assignClear {
		return false, fmt.Errorf("assign: --clear may only be true")
	}
	if cmd.Flags().Changed("clear-collaborator") && !assignClearCollaborator {
		return false, fmt.Errorf("assign: --clear-collaborator may only be true")
	}
	if cmd.Flags().Changed("clear-role") && !assignClearRole {
		return false, fmt.Errorf("assign: --clear-role may only be true")
	}
	if cmd.Flags().Changed("clear-collaborator") && cmd.Flags().Changed("collaborator") {
		return false, fmt.Errorf("assign: --clear-collaborator conflicts with --collaborator")
	}
	if cmd.Flags().Changed("clear-role") && cmd.Flags().Changed("role") {
		return false, fmt.Errorf("assign: --clear-role conflicts with --role")
	}
	if clearSet {
		return true, f.SetExtraField(collaborationField, nil)
	}
	if jsonSet {
		assignment, err := shuttle.ParseCollaborationJSON(assignJSON)
		if err != nil {
			return false, err
		}
		return true, f.SetExtraField(collaborationField, assignment)
	}
	if !patchSet {
		return false, nil
	}

	// The patch path starts from a strictly valid stored assignment and touches
	// only the requested reference. It is useful at the terminal while the JSON
	// form is the narrow daemon/controller transport.
	assignment, raw, err := readCollaboration(f)
	if err != nil {
		return false, err
	}
	if cmd.Flags().Changed("collaborator") != cmd.Flags().Changed("collaborator-origin") {
		return false, fmt.Errorf("assign: --collaborator and --collaborator-origin must be provided together")
	}
	if cmd.Flags().Changed("role") != cmd.Flags().Changed("role-origin") {
		return false, fmt.Errorf("assign: --role and --role-origin must be provided together")
	}
	if assignClearCollaborator {
		assignment.Collaborator = nil
		delete(raw, "collaborator")
	}
	if assignClearRole {
		assignment.Role = nil
		delete(raw, "role")
	}
	if cmd.Flags().Changed("collaborator") {
		assignment.Collaborator = &shuttle.CollaborationRef{UID: assignCollaborator, Origin: assignCollaboratorOrigin}
		setCollaborationRawRef(raw, "collaborator", *assignment.Collaborator)
	}
	if cmd.Flags().Changed("role") {
		assignment.Role = &shuttle.CollaborationRef{UID: assignRole, Origin: assignRoleOrigin}
		setCollaborationRawRef(raw, "role", *assignment.Role)
	}
	if assignment.Empty() {
		return true, f.SetExtraField(collaborationField, nil)
	}
	if err := assignment.Validate(); err != nil {
		return false, err
	}
	return true, f.SetExtraField(collaborationField, raw)
}

// readCollaboration accepts only the shared, current assignment shape before a
// patch rewrites it. Refusing an unknown field is safer than preserving a block
// the daemon will reject at dispatch; because this happens before SetExtraField
// or Storage.Write, the original fiber bytes remain untouched on refusal.
func readCollaboration(f *felt.Felt) (shuttle.Collaboration, map[string]any, error) {
	node := f.ExtraFields[collaborationField]
	if node == nil {
		return shuttle.Collaboration{}, map[string]any{}, nil
	}
	var raw map[string]any
	if err := node.Decode(&raw); err != nil || raw == nil {
		if err != nil {
			return shuttle.Collaboration{}, nil, fmt.Errorf("decoding collaboration: %w", err)
		}
		return shuttle.Collaboration{}, nil, fmt.Errorf("decoding collaboration: expected an object")
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return shuttle.Collaboration{}, nil, fmt.Errorf("encoding collaboration: %w", err)
	}
	assignment, err := shuttle.ParseCollaborationJSON(string(payload))
	if err != nil {
		return shuttle.Collaboration{}, nil, err
	}
	return assignment, raw, nil
}

func setCollaborationRawRef(raw map[string]any, key string, ref shuttle.CollaborationRef) {
	entry, _ := raw[key].(map[string]any)
	if entry == nil {
		entry = map[string]any{}
	}
	entry["uid"] = ref.UID
	entry["origin"] = ref.Origin
	raw[key] = entry
}

func init() {
	assignCmd.Flags().StringVar(&assignCollaborator, "collaborator", "", "Collaborator profile intrinsic UID")
	assignCmd.Flags().StringVar(&assignCollaboratorOrigin, "collaborator-origin", "", "Owning host for --collaborator")
	assignCmd.Flags().StringVar(&assignRole, "role", "", "Role profile intrinsic UID")
	assignCmd.Flags().StringVar(&assignRoleOrigin, "role-origin", "", "Owning host for --role")
	assignCmd.Flags().BoolVar(&assignClearCollaborator, "clear-collaborator", false, "Remove the collaborator reference")
	assignCmd.Flags().BoolVar(&assignClearRole, "clear-role", false, "Remove the role reference")
	assignCmd.Flags().BoolVar(&assignClear, "clear", false, "Remove the whole collaboration assignment")
	assignCmd.Flags().StringVar(&assignJSON, "json-assignment", "", "Replace collaboration from one JSON object")
	shuttleCmd.AddCommand(assignCmd)
}
