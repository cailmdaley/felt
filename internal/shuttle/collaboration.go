package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode"

	"github.com/oklog/ulid/v2"
)

// Collaboration is the optional project-owned assignment carried on a fiber.
// Its references name durable profile/role fibers by intrinsic UID and the host
// that owns their bytes. It deliberately says nothing about the execution
// recipe: shuttle.agent remains the harness/model selection.
type Collaboration struct {
	Collaborator *CollaborationRef `json:"collaborator,omitempty" yaml:"collaborator,omitempty"`
	Role         *CollaborationRef `json:"role,omitempty" yaml:"role,omitempty"`
}

// CollaborationRef is an owner-addressed reference to a durable fiber identity.
// UID is intrinsic and survives a profile rename or move; Origin is explicit so
// a reader never guesses from a locally replicated mirror.
type CollaborationRef struct {
	UID    string `json:"uid" yaml:"uid"`
	Origin string `json:"origin" yaml:"origin"`
}

// Empty reports whether no collaborator or role has been assigned.
func (c Collaboration) Empty() bool { return c.Collaborator == nil && c.Role == nil }

// Validate checks the stored collaboration shape. An assignment must name at
// least one reference, and every named reference must carry canonical intrinsic
// identity plus an explicit owning host. It intentionally does not resolve the
// profile: that read belongs to the daemon's owner-routed plane, never a local
// CLI mirror.
func (c Collaboration) Validate() error {
	if c.Empty() {
		return fmt.Errorf("collaboration must include collaborator and/or role")
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
	if r.Origin == "" || strings.TrimSpace(r.Origin) != r.Origin || strings.IndexFunc(r.Origin, unicode.IsSpace) >= 0 {
		return fmt.Errorf("collaboration.%s.origin is required and cannot contain whitespace", name)
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

// ParseCollaborationJSON decodes the controller-facing replacement shape. It
// accepts only collaborator and role fields; null is refused rather than being
// silently mistaken for omission.
func ParseCollaborationJSON(raw string) (Collaboration, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var c Collaboration
	if err := dec.Decode(&c); err != nil {
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return Collaboration{}, fmt.Errorf("parsing collaboration JSON: expected one object")
		}
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: %w", err)
	}
	if fields == nil {
		return Collaboration{}, fmt.Errorf("parsing collaboration JSON: expected an object")
	}
	for key, value := range fields {
		if key != "collaborator" && key != "role" {
			return Collaboration{}, fmt.Errorf("parsing collaboration JSON: unknown field %q", key)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return Collaboration{}, fmt.Errorf("collaboration.%s cannot be null", key)
		}
	}
	if err := c.Validate(); err != nil {
		return Collaboration{}, err
	}
	return c, nil
}
