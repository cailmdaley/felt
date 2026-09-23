package cmd

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
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
status or shuttle runtime state. --role and --collaborator accept local profile
names, paths under roles/, or intrinsic UIDs. Roles resolve at roles/<role>, and
collaborators resolve within that role. A unique collaborator can supply its
role automatically. Local assignments store intrinsic UIDs, which remain stable
when a profile moves or is renamed.

Use --json-assignment for an atomic UID-addressed replacement:
  {"collaborator":{"uid":"<ULID>"},"role":{"uid":"<ULID>"}}

The paired flags patch one reference while preserving the other. Use
--clear-collaborator, --clear-role, or --clear to remove assignments. When
updating one reference, the retained local reference must still belong to the
same role.`,
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

		changed, err := applyCollaborationFlags(cmd, f, st)
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

func applyCollaborationFlags(cmd *cobra.Command, f *felt.Felt, st *felt.Storage) (bool, error) {
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
	if cmd.Flags().Changed("collaborator-origin") && !cmd.Flags().Changed("collaborator") {
		return false, fmt.Errorf("assign: --collaborator-origin requires --collaborator")
	}
	if cmd.Flags().Changed("collaborator-origin") && assignCollaboratorOrigin == "" {
		return false, fmt.Errorf("assign: --collaborator-origin cannot be empty")
	}
	if cmd.Flags().Changed("role-origin") && !cmd.Flags().Changed("role") {
		return false, fmt.Errorf("assign: --role-origin requires --role")
	}
	if cmd.Flags().Changed("role-origin") && assignRoleOrigin == "" {
		return false, fmt.Errorf("assign: --role-origin cannot be empty")
	}
	if assignClearCollaborator {
		assignment.Collaborator = nil
		delete(raw, "collaborator")
	}
	if assignClearRole {
		assignment.Role = nil
		delete(raw, "role")
	}
	if cmd.Flags().Changed("role") {
		ref, _, err := resolveAssignmentRef(st, "role", assignRole, assignRoleOrigin, nil)
		if err != nil {
			return false, err
		}
		assignment.Role = &ref
		setCollaborationRawRef(raw, "role", ref)
	}
	if cmd.Flags().Changed("collaborator") {
		ref, inferredRole, err := resolveAssignmentRef(st, "collaborator", assignCollaborator, assignCollaboratorOrigin, assignment.Role)
		if err != nil {
			return false, err
		}
		assignment.Collaborator = &ref
		setCollaborationRawRef(raw, "collaborator", ref)
		if assignment.Role == nil && inferredRole != nil {
			assignment.Role = inferredRole
			setCollaborationRawRef(raw, "role", *inferredRole)
		}
	}
	if assignment.Empty() {
		return true, f.SetExtraField(collaborationField, nil)
	}
	if err := assignment.Validate(); err != nil {
		return false, err
	}
	if err := validateLocalAssignmentPair(st, assignment); err != nil {
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
	if ref.Origin == "" {
		delete(entry, "origin")
	} else {
		entry["origin"] = ref.Origin
	}
	raw[key] = entry
}

// resolveAssignmentRef resolves local profile names, paths, and UIDs to stable
// intrinsic identities. An explicit origin selects an owner-addressed UID ref.
func resolveAssignmentRef(st *felt.Storage, kind, query, origin string, roleRef *shuttle.CollaborationRef) (shuttle.CollaborationRef, *shuttle.CollaborationRef, error) {
	if origin != "" {
		ref := shuttle.CollaborationRef{UID: query, Origin: origin}
		c := shuttle.Collaboration{Collaborator: &ref}
		if kind == "role" {
			c = shuttle.Collaboration{Role: &ref}
		}
		if err := c.Validate(); err != nil {
			return shuttle.CollaborationRef{}, nil, err
		}
		return ref, nil, nil
	}
	profiles, err := roleProfileStorage(st).ListMetadata()
	if err != nil {
		return shuttle.CollaborationRef{}, nil, fmt.Errorf("listing local %s fibers: %w", kind, err)
	}
	if felt.LooksLikeUID(query) {
		if count := countProfileUID(profiles, query); count > 1 {
			return shuttle.CollaborationRef{}, nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across %d local fibers", query, count)
		}
	}
	var matches []*felt.Felt
	if kind == "role" {
		matches = matchRoleProfiles(profiles, query)
	} else {
		var rolePath string
		if roleRef != nil {
			role, err := uniqueProfileByUID(profiles, "role", roleRef.UID)
			if err != nil {
				return shuttle.CollaborationRef{}, nil, err
			}
			rolePath = role.ID
		}
		matches = matchCollaboratorProfiles(profiles, query, rolePath)
	}
	if len(matches) == 0 {
		return shuttle.CollaborationRef{}, nil, fmt.Errorf("assign: no local %s profile matches %q", kind, query)
	}
	if len(matches) > 1 {
		return shuttle.CollaborationRef{}, nil, fmt.Errorf("assign: ambiguous %s %q matches %s", kind, query, profilePaths(matches))
	}
	if count := countProfileUID(profiles, matches[0].UID); count > 1 {
		return shuttle.CollaborationRef{}, nil, fmt.Errorf("assign: intrinsic UID %q for %s %s is ambiguous across %d local fibers", matches[0].UID, kind, matches[0].ID, count)
	}
	ref := shuttle.CollaborationRef{UID: matches[0].UID}
	if kind != "collaborator" || roleRef != nil {
		return ref, nil, nil
	}
	rolePath := strings.SplitN(matches[0].ID, "/", 3)[0] + "/" + strings.SplitN(matches[0].ID, "/", 3)[1]
	role, err := uniqueRoleByPath(profiles, rolePath)
	if err != nil {
		return shuttle.CollaborationRef{}, nil, err
	}
	return ref, &shuttle.CollaborationRef{UID: role.UID}, nil
}

func roleProfileStorage(st *felt.Storage) *felt.Storage {
	if external := st.ExternalRefs(); external != nil {
		return felt.NewStorage(external.ProjectDir())
	}
	return st
}

func matchRoleProfiles(profiles []*felt.Felt, query string) []*felt.Felt {
	if !validProfileQuery(query) {
		return nil
	}
	var out []*felt.Felt
	for _, f := range profiles {
		if !isRoleRoot(f.ID) {
			continue
		}
		if felt.LooksLikeUID(query) && f.MatchesUID(query) || query == f.ID || !strings.Contains(query, "/") && (query == path.Base(f.ID) || query == f.DisplayName()) {
			out = append(out, f)
		}
	}
	return out
}

func matchCollaboratorProfiles(profiles []*felt.Felt, query, rolePath string) []*felt.Felt {
	if !validProfileQuery(query) {
		return nil
	}
	if strings.Contains(query, "/") && !strings.HasPrefix(query, "roles/") {
		return nil
	}
	var out []*felt.Felt
	for _, f := range profiles {
		if !strings.HasPrefix(f.ID, "roles/") || strings.Count(f.ID, "/") != 2 {
			continue
		}
		if rolePath != "" && path.Dir(f.ID) != rolePath {
			continue
		}
		if felt.LooksLikeUID(query) && f.MatchesUID(query) || query == f.ID || !strings.Contains(query, "/") && (query == path.Base(f.ID) || query == f.DisplayName()) {
			out = append(out, f)
		}
	}
	return out
}

func uniqueProfileByUID(profiles []*felt.Felt, kind, uid string) (*felt.Felt, error) {
	var matches []*felt.Felt
	for _, f := range profiles {
		if f.MatchesUID(uid) {
			matches = append(matches, f)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("assign: stored %s UID %q resolves to %d local fibers", kind, uid, len(matches))
	}
	if kind == "role" && !isRoleRoot(matches[0].ID) {
		return nil, fmt.Errorf("assign: stored role UID %q resolves outside roles/<role> at %s", uid, matches[0].ID)
	}
	return matches[0], nil
}

func countProfileUID(profiles []*felt.Felt, uid string) int {
	count := 0
	for _, f := range profiles {
		if f.MatchesUID(uid) {
			count++
		}
	}
	return count
}

func uniqueRoleByPath(profiles []*felt.Felt, rolePath string) (*felt.Felt, error) {
	var match *felt.Felt
	for _, f := range profiles {
		if f.ID != rolePath {
			continue
		}
		if match != nil {
			return nil, fmt.Errorf("assign: duplicate role path %s", rolePath)
		}
		match = f
	}
	if match == nil {
		return nil, fmt.Errorf("assign: collaborator role %s has no role fiber", rolePath)
	}
	return match, nil
}

func validateLocalAssignmentPair(st *felt.Storage, assignment shuttle.Collaboration) error {
	if assignment.Role == nil || assignment.Collaborator == nil || assignment.Role.Origin != "" || assignment.Collaborator.Origin != "" {
		return nil
	}
	profiles, err := roleProfileStorage(st).ListMetadata()
	if err != nil {
		return fmt.Errorf("listing local collaboration profiles: %w", err)
	}
	role, err := uniqueProfileByUID(profiles, "role", assignment.Role.UID)
	if err != nil {
		return err
	}
	collaborator, err := uniqueProfileByUID(profiles, "collaborator", assignment.Collaborator.UID)
	if err != nil {
		return err
	}
	if path.Dir(collaborator.ID) != role.ID {
		return fmt.Errorf("assign: collaborator %s does not belong to role %s; change or clear both references", collaborator.ID, role.ID)
	}
	return nil
}

func isRoleRoot(id string) bool {
	return strings.HasPrefix(id, "roles/") && strings.Count(id, "/") == 1
}
func validProfileQuery(query string) bool {
	if strings.TrimSpace(query) != query || query == "" || strings.Contains(query, "\\") {
		return false
	}
	for _, part := range strings.Split(query, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func profilePaths(profiles []*felt.Felt) string {
	paths := make([]string, len(profiles))
	for i, f := range profiles {
		paths[i] = f.ID
	}
	return strings.Join(paths, ", ")
}

func init() {
	assignCmd.Flags().StringVar(&assignCollaborator, "collaborator", "", "Collaborator profile name, path, or intrinsic UID")
	assignCmd.Flags().StringVar(&assignCollaboratorOrigin, "collaborator-origin", "", "Optional origin metadata for an intrinsic UID")
	assignCmd.Flags().StringVar(&assignRole, "role", "", "Role profile name, path, or intrinsic UID")
	assignCmd.Flags().StringVar(&assignRoleOrigin, "role-origin", "", "Optional origin metadata for an intrinsic UID")
	assignCmd.Flags().BoolVar(&assignClearCollaborator, "clear-collaborator", false, "Remove the collaborator reference")
	assignCmd.Flags().BoolVar(&assignClearRole, "clear-role", false, "Remove the role reference")
	assignCmd.Flags().BoolVar(&assignClear, "clear", false, "Remove the whole collaboration assignment")
	assignCmd.Flags().StringVar(&assignJSON, "json-assignment", "", "Replace collaboration from one JSON object")
	shuttleCmd.AddCommand(assignCmd)
}
