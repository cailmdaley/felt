package shuttlecli

import (
	"encoding/json"
	"fmt"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

const collaborationField = "collaboration"

// assignOptions are the flags of shuttle assign.
type assignOptions struct {
	collaborators []string
	roles         []string
	clear         bool
	json          string
}

func (a *app) assignCmd() *cobra.Command {
	var assignOpts assignOptions
	assignCmd := &cobra.Command{
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
			f, st, ref, err := a.shuttleResolveFiberRef(args[0], true)
			if err != nil {
				return err
			}
			f, unlock, err := lockAndReloadFiber(st, f)
			if err != nil {
				return err
			}
			defer unlock()

			changed, err := applyCollaborationFlags(cmd, assignOpts, f, st)
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
			fmt.Fprintf(a.env.Stdout, "updated collaboration for %s%s\n", args[0], ref.Location())
			return nil
		},
	}
	assignCmd.Flags().StringArrayVar(&assignOpts.roles, "role", nil, "Role profile name, path, or intrinsic UID (repeatable)")
	assignCmd.Flags().StringArrayVar(&assignOpts.collaborators, "collaborator", nil, "Collaborator profile name, path, or intrinsic UID (repeatable)")
	assignCmd.Flags().BoolVar(&assignOpts.clear, "clear", false, "Remove the whole collaboration assignment")
	assignCmd.Flags().StringVar(&assignOpts.json, "json-assignment", "", "Replace collaboration from a role-to-collaborator JSON object")
	return assignCmd
}

func applyCollaborationFlags(cmd *cobra.Command, o assignOptions, f *felt.Felt, st *felt.Storage) (bool, error) {
	jsonSet := cmd.Flags().Changed("json-assignment")
	clearSet := cmd.Flags().Changed("clear")
	patchSet := cmd.Flags().Changed("role") || cmd.Flags().Changed("collaborator")
	if (jsonSet && (clearSet || patchSet)) || (clearSet && patchSet) {
		return false, fmt.Errorf("assign: --json-assignment, --clear, and membership flags are mutually exclusive")
	}
	if clearSet && !o.clear {
		return false, fmt.Errorf("assign: --clear may only be true")
	}
	if clearSet {
		return true, f.SetExtraField(collaborationField, nil)
	}
	if jsonSet {
		assignment, err := shuttle.ParseCollaborationJSON(o.json)
		if err != nil {
			return false, err
		}
		profiles, err := listRoleProfiles(st)
		if err != nil {
			return false, err
		}
		if assignment.Participants == nil {
			assignment, err = rosterFromUIDRefs(profiles, assignment)
			if err != nil {
				return false, err
			}
		}
		if err := validateParticipantProfiles(profiles, assignment.Participants); err != nil {
			return false, err
		}
		return true, f.SetExtraField(collaborationField, assignment)
	}
	if !patchSet {
		return false, nil
	}

	profiles, err := listRoleProfiles(st)
	if err != nil {
		return false, err
	}
	assignment, err := readCollaboration(f, profiles)
	if err != nil {
		return false, err
	}
	roleMatches := make([]*felt.Felt, 0, len(o.roles))
	for _, query := range o.roles {
		role, err := resolveRoleProfile(profiles, query)
		if err != nil {
			return false, err
		}
		if !slices.ContainsFunc(roleMatches, func(match *felt.Felt) bool { return match.ID == role.ID }) {
			roleMatches = append(roleMatches, role)
		}
		if _, exists := assignment.Participants[path.Base(role.ID)]; !exists {
			assignment.Participants[path.Base(role.ID)] = []string{}
		}
	}
	for _, query := range o.collaborators {
		var preferredRole *felt.Felt
		if !strings.Contains(query, "/") && len(roleMatches) == 1 {
			preferredRole = roleMatches[0]
		}
		role, collaborator, err := resolveCollaboratorProfile(profiles, query, preferredRole)
		if err != nil {
			return false, err
		}
		roleSlug, collaboratorSlug := path.Base(role.ID), path.Base(collaborator.ID)
		if !slices.Contains(assignment.Participants[roleSlug], collaboratorSlug) {
			assignment.Participants[roleSlug] = append(assignment.Participants[roleSlug], collaboratorSlug)
		}
	}
	if err := assignment.Validate(); err != nil {
		return false, err
	}
	return true, f.SetExtraField(collaborationField, assignment)
}

// readCollaboration reads the fiber's roster for editing, resolving a
// UID-addressed assignment to current role and collaborator slugs.
func readCollaboration(f *felt.Felt, profiles []*felt.Felt) (shuttle.Collaboration, error) {
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
	return rosterFromUIDRefs(profiles, parsed)
}

// rosterFromUIDRefs turns the UID-addressed form (one role and optionally one
// collaborator, by intrinsic UID) into the readable slug roster.
func rosterFromUIDRefs(profiles []*felt.Felt, parsed shuttle.Collaboration) (shuttle.Collaboration, error) {
	var role, collaborator *felt.Felt
	var err error
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
			return shuttle.Collaboration{}, fmt.Errorf("assign: collaborator %s does not belong to role %s", collaborator.ID, role.ID)
		}
		if role == nil {
			role, err = uniqueRoleByPath(profiles, collaboratorRole)
			if err != nil {
				return shuttle.Collaboration{}, err
			}
		}
	}
	if role == nil {
		return shuttle.Collaboration{}, fmt.Errorf("assign: UID-addressed collaboration names no local role")
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
		return nil, fmt.Errorf("assign: no local role profile matches %q%s", query, createHint(query, "roles/"+query))
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
		hint := ""
		if preferredRole != nil {
			hint = createHint(query, preferredRole.ID+"/"+query)
		}
		return nil, nil, fmt.Errorf("assign: no local collaborator profile matches %q%s", query, hint)
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

func validateParticipantProfiles(profiles []*felt.Felt, participants map[string][]string) error {
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

// listRoleProfiles lists the fibers under roles/ in the store that owns them:
// the project store for an external-refs checkout, else st itself.
func listRoleProfiles(st *felt.Storage) ([]*felt.Felt, error) {
	if external := st.ExternalRefs(); external != nil {
		st = felt.NewStorage(external.ProjectDir())
	}
	profiles, err := st.ListMetadata()
	if err != nil {
		return nil, fmt.Errorf("listing local role fibers: %w", err)
	}
	return profiles, nil
}

// profileMatchesQuery accepts an intrinsic UID, the full path, or, for a query
// without a slash, the profile's slug or display name.
func profileMatchesQuery(f *felt.Felt, query string) bool {
	return felt.LooksLikeUID(query) && f.MatchesUID(query) || query == f.ID ||
		!strings.Contains(query, "/") && (query == path.Base(f.ID) || query == f.DisplayName())
}

func matchRoleProfiles(profiles []*felt.Felt, query string) []*felt.Felt {
	if !validProfileQuery(query) {
		return nil
	}
	var out []*felt.Felt
	for _, f := range profiles {
		if isRoleRoot(f.ID) && profileMatchesQuery(f, query) {
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
		if isCollaboratorPath(f.ID) && (rolePath == "" || path.Dir(f.ID) == rolePath) && profileMatchesQuery(f, query) {
			out = append(out, f)
		}
	}
	return out
}

func uniqueRoleByUID(profiles []*felt.Felt, uid string) (*felt.Felt, error) {
	return uniqueProfileByUID(profiles, uid, isRoleRoot, "role UID %q resolves to %d local role fibers")
}

func uniqueCollaboratorByUID(profiles []*felt.Felt, uid string) (*felt.Felt, error) {
	return uniqueProfileByUID(profiles, uid, isCollaboratorPath, "collaborator UID %q resolves to %d local role collaborators")
}

func uniqueProfileByUID(profiles []*felt.Felt, uid string, kind func(string) bool, countError string) (*felt.Felt, error) {
	if countProfileUID(profiles, uid) > 1 {
		return nil, fmt.Errorf("assign: intrinsic UID %q is ambiguous across local fibers", uid)
	}
	var matches []*felt.Felt
	for _, f := range profiles {
		if kind(f.ID) && f.MatchesUID(uid) {
			matches = append(matches, f)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("assign: "+countError, uid, len(matches))
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
	if match == nil || !isCollaboratorPath(match.ID) {
		return nil, fmt.Errorf("no direct collaborator fiber at %s", collaboratorPath)
	}
	return match, nil
}

// createHint names the command that creates a missing profile, for a query
// that is a plain slug rather than a path or UID.
func createHint(query, id string) string {
	if strings.Contains(query, "/") || felt.LooksLikeUID(query) {
		return ""
	}
	return fmt.Sprintf("; create it with `felt add %s \"<Name>\"`", id)
}

func isRoleRoot(id string) bool {
	return strings.HasPrefix(id, "roles/") && strings.Count(id, "/") == 1
}

// isCollaboratorPath is a direct child of a role: roles/<role>/<collaborator>.
func isCollaboratorPath(id string) bool {
	return strings.HasPrefix(id, "roles/") && strings.Count(id, "/") == 2
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
