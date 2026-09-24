package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"

	"github.com/oklog/ulid/v2"
	"gopkg.in/yaml.v3"
)

// Collaboration maps role slugs to collaborator slugs. An empty participant
// list records a role assignment without naming a collaborator.
//
// Participants carries the readable roster. Collaborator and Role represent
// UID-addressed provenance snapshots.
type Collaboration struct {
	Participants map[string][]string `json:"-" yaml:"-"`
	Collaborator *CollaborationRef   `json:"-" yaml:"-"`
	Role         *CollaborationRef   `json:"-" yaml:"-"`
}

// CollaborationRef is the UID-addressed form used by provenance snapshots.
type CollaborationRef struct {
	UID    string `json:"uid" yaml:"uid"`
	Origin string `json:"origin,omitempty" yaml:"origin,omitempty"`
}

var collaborationSlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func (c Collaboration) Empty() bool {
	return len(c.Participants) == 0 && c.Collaborator == nil && c.Role == nil
}

// Validate checks the readable roster form and legacy UID references.
func (c Collaboration) Validate() error {
	if c.Participants != nil {
		if c.Collaborator != nil || c.Role != nil {
			return fmt.Errorf("collaboration cannot mix participant arrays with UID references")
		}
		if len(c.Participants) == 0 {
			return fmt.Errorf("collaboration must include at least one role")
		}
		for role, collaborators := range c.Participants {
			if !collaborationSlug.MatchString(role) {
				return fmt.Errorf("collaboration role %q must be a role slug", role)
			}
			if collaborators == nil {
				return fmt.Errorf("collaboration.%s must use an array, not null", role)
			}
			seen := make(map[string]struct{}, len(collaborators))
			for _, collaborator := range collaborators {
				if !collaborationSlug.MatchString(collaborator) {
					return fmt.Errorf("collaboration collaborator %q must be a collaborator slug", collaborator)
				}
				if _, ok := seen[collaborator]; ok {
					return fmt.Errorf("collaboration.%s repeats collaborator %q", role, collaborator)
				}
				seen[collaborator] = struct{}{}
			}
		}
		return nil
	}
	if c.Empty() {
		return fmt.Errorf("collaboration must include a role or legacy reference")
	}
	if c.Collaborator != nil {
		if err := c.Collaborator.validate("collaborator"); err != nil {
			return err
		}
	}
	if c.Role != nil {
		if err := c.Role.validate("role"); err != nil {
			return err
		}
	}
	return nil
}

func (r CollaborationRef) validate(name string) error {
	if strings.TrimSpace(r.UID) == "" {
		return fmt.Errorf("collaboration.%s.uid is required", name)
	}
	if r.UID != strings.ToUpper(r.UID) {
		return fmt.Errorf("collaboration.%s.uid must be a canonical uppercase ULID", name)
	}
	if _, err := ulid.ParseStrict(r.UID); err != nil {
		return fmt.Errorf("collaboration.%s.uid must be a ULID: %w", name, err)
	}
	if r.Origin == "" {
		return nil
	}
	if strings.TrimSpace(r.Origin) != r.Origin || strings.IndexFunc(r.Origin, unicode.IsSpace) >= 0 {
		return fmt.Errorf("collaboration.%s.origin cannot contain whitespace", name)
	}
	if r.Origin != strings.ToLower(r.Origin) || r.Origin == "local" || strings.Contains(r.Origin, "://") ||
		strings.IndexFunc(r.Origin, unicode.IsControl) >= 0 || !validOriginAtom(r.Origin) {
		return fmt.Errorf("collaboration.%s.origin must be a normalized host id, not %q", name, r.Origin)
	}
	return nil
}

func validOriginAtom(origin string) bool {
	for i, r := range origin {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			if i == 0 && (r == '.' || r == '_' || r == '-') {
				return false
			}
			continue
		}
		return false
	}
	return true
}

func (c Collaboration) MarshalJSON() ([]byte, error) {
	if c.Participants != nil {
		return json.Marshal(c.Participants)
	}
	legacy := map[string]*CollaborationRef{}
	if c.Collaborator != nil {
		legacy["collaborator"] = c.Collaborator
	}
	if c.Role != nil {
		legacy["role"] = c.Role
	}
	return json.Marshal(legacy)
}

func (c Collaboration) MarshalYAML() (any, error) {
	if c.Participants != nil {
		return c.Participants, nil
	}
	legacy := map[string]*CollaborationRef{}
	if c.Collaborator != nil {
		legacy["collaborator"] = c.Collaborator
	}
	if c.Role != nil {
		legacy["role"] = c.Role
	}
	return legacy, nil
}

func (c *Collaboration) UnmarshalJSON(data []byte) error {
	parsed, err := parseCollaboration(data)
	if err != nil {
		return err
	}
	*c = parsed
	return nil
}

// ParseCollaborationJSON accepts the readable roster shape and the historical
// singleton UID shape. Roster entries contain role slugs and direct-child
// collaborator slugs; filesystem identity resolution belongs to the caller.
func ParseCollaborationJSON(raw string) (Collaboration, error) {
	return parseCollaboration([]byte(raw))
}

func parseCollaboration(raw []byte) (Collaboration, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := dec.Decode(&fields); err != nil {
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return Collaboration{}, fmt.Errorf("parsing collaboration JSON: expected one object")
		}
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
	}
	if fields == nil {
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: expected an object")
	}
	legacyShape := false
	for _, value := range fields {
		if bytes.HasPrefix(bytes.TrimSpace(value), []byte("{")) {
			legacyShape = true
			break
		}
	}
	if legacyShape {
		for key, value := range fields {
			if key != "collaborator" && key != "role" {
				return Collaboration{}, fmt.Errorf("parsing collaboration JSON: unknown field %q", key)
			}
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return Collaboration{}, fmt.Errorf("collaboration.%s cannot be null", key)
			}
		}
		var legacy struct {
			Collaborator *CollaborationRef `json:"collaborator"`
			Role         *CollaborationRef `json:"role"`
		}
		legacyDecoder := json.NewDecoder(bytes.NewReader(raw))
		legacyDecoder.DisallowUnknownFields()
		if err := legacyDecoder.Decode(&legacy); err != nil {
			return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
		}
		c := Collaboration{Collaborator: legacy.Collaborator, Role: legacy.Role}
		if err := c.Validate(); err != nil {
			return Collaboration{}, err
		}
		return c, nil
	}
	participants := make(map[string][]string, len(fields))
	for role, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return Collaboration{}, fmt.Errorf("collaboration.%s cannot be null", role)
		}
		var collaborators []string
		if err := json.Unmarshal(value, &collaborators); err != nil || collaborators == nil {
			return Collaboration{}, fmt.Errorf("parsing collaboration JSON: role %q must map to an array of collaborator slugs", role)
		}
		participants[role] = collaborators
	}
	c := Collaboration{Participants: participants}
	if err := c.Validate(); err != nil {
		return Collaboration{}, err
	}
	return c, nil
}

var _ yaml.Marshaler = Collaboration{}
