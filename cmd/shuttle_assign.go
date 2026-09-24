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
	assignCollaborators []string
	assignRoles         []string
	assignClear         bool
	assignJSON          string
)

var assignCmd = &cobra.Command{
	Use:   "assign <fiber>",
	Short: "Assign roles and collaborators to a fiber",
	Long: `Stores role-to-collaborator membership without changing the fiber's status
or shuttle runtime state. --role and --collaborator accept names, paths under
roles/, or intrinsic UIDs. Repeat either flag to add several roles or
collaborators. Collaborators resolve to direct children of roles/<role>.

Assignments are stored as readable role and collaborator slugs, for example:
  collaboration:
    vizier: [fable, astra]
    organizer: [opus]

Use --json-assignment for an atomic replacement with an object mapping role
slugs to collaborator slug arrays. An empty array assigns the role alone. Use
--clear to remove the whole assignment. Patching adds membership and preserves
other roles and collaborators; it does not change worker lifecycle settings.`,
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
			return fmt.Errorf("assign: pass --role, --collaborator, --clear, or --json-assignment")
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
	patchSet := cmd.Flags().Changed("role") || cmd.Flags().Changed("collaborator")
	if (jsonSet && (clearSet || patchSet)) || (clearSet && patchSet) {
		return false, fmt.Errorf("assign: --json-assignment, --clear, and membership flags are mutually exclusive")
	}
	if clearSet && !assignClear {
		return false, fmt.Errorf("assign: --clear may only be true")
	}
	if clearSet {
		return true, f.SetExtraField(collaborationField, nil)
	}
	if jsonSet {
		assignment, err := shuttle.ParseCollaborationJSON(assignJSON)
		if err != nil {
			return false, err
		}
		if assignment.Participants == nil {
			assignment, err = normalizeLegacyCollaboration(st, assignment)
			if err != nil {
				return false, err
			}
		}
		if err := validateParticipantProfiles(st, assignment.Participants); err != nil {
			return false, err
		}
		return true, f.SetExtraField(collaborationField, assignment)
	}
	if !patchSet {
		return false, nil
	}

	assignment, err := readCollaboration(f, st)
	if err != nil {
		return false, err
	}
	profiles, err := roleProfileStorage(st).ListMetadata()
	if err != nil {
		return false, fmt.Errorf("listing local role fibers: %w", err)
	}
	roleMatches := make([]*felt.Felt, 0, len(assignRoles))
	for _, query := range assignRoles {
		role, err := resolveRoleProfile(profiles, query)
		if err != nil {
			return false, err
		}
		if !containsProfile(roleMatches, role.ID) {
			roleMatches = append(roleMatches, role)
		}
		if _, exists := assignment.Participants[path.Base(role.ID)]; !exists {
			assignment.Participants[path.Base(role.ID)] = []string{}
		}
	}
	for _, query := range assignCollaborators {
		var preferredRole *felt.Felt
		if !strings.Contains(query, "/") && len(roleMatches) == 1 {
			preferredRole = roleMatches[0]
		}
		role, collaborator, err := resolveCollaboratorProfile(profiles, query, preferredRole)
		if err != nil {
			return false, err
		}
		roleSlug, collaboratorSlug := path.Base(role.ID), path.Base(collaborator.ID)
		if !containsString(assignment.Participants[roleSlug], collaboratorSlug) {
			assignment.Participants[roleSlug] = append(assignment.Participants[roleSlug], collaboratorSlug)
		}
	}
	if err := assignment.Validate(); err != nil {
		return false, err
	}
	return true, f.SetExtraField(collaborationField, assignment)
}

// readCollaboration resolves UID snapshot input to current role slugs for edits.
func readCollaboration(f *felt.Felt, st *felt.Storage) (shuttle.Collaboration, error) {
	assignment := shuttle.Collaboration{Participants: map[string][]string{}}
	node := f.ExtraFields[collaborationField]
	if node == nil {
		return assignment, nil
	}
	var raw map[string]any
	if err := node.Decode(&raw); err != nil {
		return shuttle.Collaboration{}, fmt.Errorf("decoding collaboration: %w", err)
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return shuttle.Collaboration{}, fmt.Errorf("encoding collaboration: %w", err)
	}
	parsed, err := shuttle.ParseCollaborationJSON(string(payload))
	if err != nil {
		return shuttle.Collaboration{}, err
	}
	if parsed.Participants != nil {
		return parsed, nil
	}
	return normalizeLegacyCollaboration(st, parsed)
}

func normalizeLegacyCollaboration(st *felt.Storage, parsed shuttle.Collaboration) (shuttle.Collaboration, error) {
	profiles, err := roleProfileStorage(st).ListMetadata()
	if err != nil {
		return shuttle.Collaboration{}, fmt.Errorf("listing local collaboration profiles: %w", err)
	}
	var role, collaborator *felt.Felt
	if parsed.Role != nil {
		role, err = uniqueRoleByUID(profiles, parsed.Role.UID)
		if err != nil {
			return shuttle.Collaboration{}, err
		}
	}
	if parsed.Collaborator != nil {
		collaborator, err = uniqueCollaboratorByUID(profiles, parsed.Collaborator.UID)
		if err != nil {
			return shuttle.Collaboration{}, err
		}
		collaboratorRole := path.Dir(collaborator.ID)
		if role != nil && role.ID != collaboratorRole {
			return shuttle.Collaboration{}, fmt.Errorf("assign: legacy collaborator %s does not belong to role %s", collaborator.ID, role.ID)
		}
		if role == nil {
			role, err = uniqueRoleByPath(profiles, collaboratorRole)
			if err != nil {
				return shuttle.Collaboration{}, err
			}
		}
	}
	if role == nil {
		return shuttle.Collaboration{}, fmt.Errorf("assign: legacy collaboration has no local role")
	}
	assignment := shuttle.Collaboration{Participants: map[string][]string{path.Base(role.ID): {}}}
	if collaborator != nil {
		assignment.Participants[path.Base(role.ID)] = []string{path.Base(collaborator.ID)}
	}
	return assignment, nil
}

func resolveRoleProfile(profiles []*felt.Felt, query string) (*felt.Felt, error) {
	if felt.LooksLikeUID(query) && countProfileUID(profiles, query) > 1 {
		return nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across local fibers", query)
	}
	matches := matchRoleProfiles(profiles, query)
	if len(matches) == 0 {
		return nil, fmt.Errorf("assign: no local role profile matches %q", query)
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("assign: ambiguous role %q matches %s", query, profilePaths(matches))
	}
	return matches[0], nil
}

func resolveCollaboratorProfile(profiles []*felt.Felt, query string, preferredRole *felt.Felt) (*felt.Felt, *felt.Felt, error) {
	if felt.LooksLikeUID(query) && countProfileUID(profiles, query) > 1 {
		return nil, nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across local fibers", query)
	}
	rolePath := ""
	if preferredRole != nil {
		rolePath = preferredRole.ID
	}
	matches := matchCollaboratorProfiles(profiles, query, rolePath)
	if len(matches) == 0 {
		return nil, nil, fmt.Errorf("assign: no local collaborator profile matches %q", query)
	}
	if len(matches) > 1 {
		return nil, nil, fmt.Errorf("assign: ambiguous collaborator %q matches %s", query, profilePaths(matches))
	}
	collaborator := matches[0]
	role, err := uniqueRoleByPath(profiles, path.Dir(collaborator.ID))
	if err != nil {
		return nil, nil, err
	}
	return role, collaborator, nil
}

func validateParticipantProfiles(st *felt.Storage, participants map[string][]string) error {
	profiles, err := roleProfileStorage(st).ListMetadata()
	if err != nil {
		return fmt.Errorf("listing local collaboration profiles: %w", err)
	}
	for roleSlug, collaborators := range participants {
		role, err := uniqueRoleByPath(profiles, "roles/"+roleSlug)
		if err != nil {
			return fmt.Errorf("assign: role slug %q does not identify a local role fiber: %w", roleSlug, err)
		}
		for _, collaboratorSlug := range collaborators {
			if _, err := uniqueCollaboratorByPath(profiles, role.ID+"/"+collaboratorSlug); err != nil {
				return fmt.Errorf("assign: collaborator slug %q is not a direct child of %s: %w", collaboratorSlug, role.ID, err)
			}
		}
	}
	return nil
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

func uniqueRoleByUID(profiles []*felt.Felt, uid string) (*felt.Felt, error) {
	if countProfileUID(profiles, uid) > 1 {
		return nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across local fibers", uid)
	}
	var matches []*felt.Felt
	for _, f := range profiles {
		if isRoleRoot(f.ID) && f.MatchesUID(uid) {
			matches = append(matches, f)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("assign: role UID %q resolves to %d local role fibers", uid, len(matches))
	}
	return matches[0], nil
}

func uniqueCollaboratorByUID(profiles []*felt.Felt, uid string) (*felt.Felt, error) {
	if countProfileUID(profiles, uid) > 1 {
		return nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across local fibers", uid)
	}
	var matches []*felt.Felt
	for _, f := range profiles {
		if strings.HasPrefix(f.ID, "roles/") && strings.Count(f.ID, "/") == 2 && f.MatchesUID(uid) {
			matches = append(matches, f)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("assign: collaborator UID %q resolves to %d local role collaborators", uid, len(matches))
	}
	return matches[0], nil
}

func countProfileUID(profiles []*felt.Felt, uid string) int {
	count := 0
	for _, profile := range profiles {
		if profile.MatchesUID(uid) {
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
	if match == nil || !isRoleRoot(match.ID) {
		return nil, fmt.Errorf("assign: collaborator role %s has no role fiber", rolePath)
	}
	return match, nil
}

func uniqueCollaboratorByPath(profiles []*felt.Felt, collaboratorPath string) (*felt.Felt, error) {
	var match *felt.Felt
	for _, profile := range profiles {
		if profile.ID != collaboratorPath {
			continue
		}
		if match != nil {
			return nil, fmt.Errorf("duplicate collaborator path %s", collaboratorPath)
		}
		match = profile
	}
	if match == nil || !strings.HasPrefix(match.ID, "roles/") || strings.Count(match.ID, "/") != 2 {
		return nil, fmt.Errorf("no direct collaborator fiber at %s", collaboratorPath)
	}
	return match, nil
}

func containsProfile(profiles []*felt.Felt, id string) bool {
	for _, f := range profiles {
		if f.ID == id {
			return true
		}
	}
	return false
}

func containsString(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
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
	assignCmd.Flags().StringArrayVar(&assignRoles, "role", nil, "Role profile name, path, or intrinsic UID (repeatable)")
	assignCmd.Flags().StringArrayVar(&assignCollaborators, "collaborator", nil, "Collaborator profile name, path, or intrinsic UID (repeatable)")
	assignCmd.Flags().BoolVar(&assignClear, "clear", false, "Remove the whole collaboration assignment")
	assignCmd.Flags().StringVar(&assignJSON, "json-assignment", "", "Replace collaboration from a role-to-collaborator JSON object")
	shuttleCmd.AddCommand(assignCmd)
}
