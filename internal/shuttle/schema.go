// Package shuttle is felt's owned schema for the optional `shuttle:` facet a
// fiber can carry. A fiber with no `shuttle:` block is a pure note; a fiber that
// carries one is a constitution that the Shuttle daemon can dispatch, and the
// block's shape is validated here. felt is the schema authority: it validates on
// add/edit and resolves agents in `felt show -j`. The networked daemon owns
// dispatch and the watcher; the data model — this block — lives with felt.
package shuttle

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"gopkg.in/yaml.v3"
)

// ---- Types -----------------------------------------------------------------

// Block is the in-memory representation of the shuttle: YAML block. felt is the
// schema authority for these fields (the share/schema.json that once mirrored
// them is a stale doc artifact, not loaded at runtime). There is no enabled flag
// and no review axis: a fiber is shuttle-managed iff it carries this block, and
// it dispatches iff the felt-native status is "active". Lifecycle is status +
// tempered, uniform across kinds.
type Block struct {
	Kind       string `json:"kind" yaml:"kind"`
	Host       string `json:"host,omitempty" yaml:"host,omitempty"`
	ProjectDir string `json:"project_dir,omitempty" yaml:"project_dir,omitempty"`
	Agent      string `json:"agent,omitempty" yaml:"agent,omitempty"`
	// Orthogonal dispatch axes layered on top of Agent (the base id). Effort is
	// a token validated against the resolved base agent's allowed set; Chrome is
	// claude-only. Both optional — omitted means the harness/registry default.
	Effort   string    `json:"effort,omitempty" yaml:"effort,omitempty"`
	Chrome   bool      `json:"chrome,omitempty" yaml:"chrome,omitempty"`
	Schedule *Schedule `json:"schedule,omitempty" yaml:"schedule,omitempty"`
}

// Schedule holds the recurrence definition for a standing role.
type Schedule struct {
	Expr string `json:"expr" yaml:"expr"`
	TZ   string `json:"tz" yaml:"tz"`
}

// UnmarshalYAML accepts the canonical `tz` field as well as the legacy
// `timezone` alias used by pre-CLI standing-role frontmatter. Pre-CLI blocks
// also carried `kind: cron` on the schedule itself; we silently drop it (the
// outer `kind:` field on Block carries the role kind in the new schema).
// Output always uses `tz` so the legacy alias is rewritten on the next save.
func (s *Schedule) UnmarshalYAML(value *yaml.Node) error {
	var aux struct {
		Expr     string `yaml:"expr"`
		TZ       string `yaml:"tz"`
		Timezone string `yaml:"timezone"`
		Kind     string `yaml:"kind"` // legacy: ignored
	}
	if err := value.Decode(&aux); err != nil {
		return err
	}
	s.Expr = aux.Expr
	s.TZ = aux.TZ
	if s.TZ == "" {
		s.TZ = aux.Timezone
	}
	return nil
}

// UnmarshalJSON accepts the canonical `tz` field as well as the legacy
// `timezone` alias used by pre-CLI standing-role frontmatter serialized
// through felt's JSON view.
func (s *Schedule) UnmarshalJSON(data []byte) error {
	var aux struct {
		Expr     string `json:"expr"`
		TZ       string `json:"tz"`
		Timezone string `json:"timezone"`
		Kind     string `json:"kind"` // legacy: ignored
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	s.Expr = aux.Expr
	s.TZ = aux.TZ
	if s.TZ == "" {
		s.TZ = aux.Timezone
	}
	return nil
}

// UnmarshalJSON accepts the canonical `kind` field as well as the legacy `mode`
// alias used by pre-CLI shuttle blocks serialized through felt's JSON view.
// Output always normalizes to `Kind`. Only the typed dispatch fields are
// decoded. The runtime/continuation fields (session_uuid, dispatched_at,
// handed_off_at, run_id) live as flat keys in the `shuttle:` block — that is
// where continuation state lives now that felt history is gone — but they are
// deliberately NOT decoded into the typed Block: they ride through as
// forward-compatible unknowns, owned by the daemon, not the schema. Legacy
// daemon-owned fields (enabled, review, next_due_at, last_run_at, session) and
// the retired `interactive` axis are likewise NOT decoded — clean cutover, no
// read-tolerance: a felt JSON view that still carries them simply ignores them.
func (b *Block) UnmarshalJSON(data []byte) error {
	var aux struct {
		Kind       string    `json:"kind"`
		Mode       string    `json:"mode"`
		Host       string    `json:"host"`
		ProjectDir string    `json:"project_dir"`
		Agent      string    `json:"agent"`
		Effort     string    `json:"effort"`
		Chrome     bool      `json:"chrome"`
		Schedule   *Schedule `json:"schedule"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	b.Kind = aux.Kind
	if b.Kind == "" {
		b.Kind = aux.Mode
	}
	b.Host = aux.Host
	b.ProjectDir = aux.ProjectDir
	b.Agent = aux.Agent
	b.Effort = aux.Effort
	b.Chrome = aux.Chrome
	b.Schedule = aux.Schedule
	return nil
}

// ValidKinds enumerates the allowed kind values.
//
//   - oneshot  — one-time dispatch, picked up on the next poll when status:active.
//   - standing — recurring; the cron `schedule` decides when the poller dispatches.
//   - pinned   — schedule-less umbrella role that rests PARKED on the board's
//     pinned strip (status:open). Started (status:active, the strip → In-flight
//     gesture) it LOOPS like a oneshot — dispatched and re-dispatched on every
//     worker exit — until a human parks it (In-flight → strip, active → open) or
//     a worker closes it. A oneshot whose resting state is open; perennial
//     (Option D).
var ValidKinds = []string{"oneshot", "standing", "pinned"}

// ---- Validation ------------------------------------------------------------

// ValidationError collects field-level errors.
type ValidationError struct {
	Field   string
	Message string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// ValidationErrors is a slice of validation errors.
type ValidationErrors []ValidationError

func (errs ValidationErrors) Error() string {
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = e.Error()
	}
	return strings.Join(msgs, "\n")
}

// Validate checks a Block for correctness. Returns nil when valid.
// Accepts an Agents registry for agent-name validation; may be nil to skip.
func Validate(b *Block, agents *AgentRegistry) ValidationErrors {
	var errs ValidationErrors
	add := func(field, msg string) {
		errs = append(errs, ValidationError{Field: field, Message: msg})
	}

	if !contains(ValidKinds, b.Kind) {
		add("kind", fmt.Sprintf("must be one of %v, got %q", ValidKinds, b.Kind))
	}

	if agents != nil && (b.Agent != "" || b.Effort != "" || b.Chrome) {
		// Resolve the named agent (or registry default when unnamed) together
		// with the block's axes, surfacing unknown-agent, dangling-alias, and
		// axis-constraint violations in one shot.
		name := b.Agent
		if name == "" {
			if def, err := agents.Default(); err == nil {
				name = def.ID
			}
		}
		if _, _, err := agents.Resolve(name, b.Effort, b.Chrome); err != nil {
			add("agent", err.Error())
		}
	}

	// A pinned role has no cron recurrence — its loop is driven by status:active
	// (re-dispatch on every worker exit), not a schedule. A schedule would be
	// meaningless (and misleading on the board). Reject the combination loudly
	// rather than silently ignoring the schedule.
	if b.Kind == "pinned" && b.Schedule != nil {
		add("schedule", "not allowed for kind=pinned (pinned roles loop on status, not a cron)")
	}

	if b.Kind == "standing" {
		if b.Schedule == nil {
			add("schedule", "required for kind=standing")
		} else {
			if err := ValidateCron(b.Schedule.Expr); err != nil {
				add("schedule.expr", err.Error())
			}
			if b.Schedule.TZ == "" {
				add("schedule.tz", "required")
			} else if _, err := time.LoadLocation(b.Schedule.TZ); err != nil {
				add("schedule.tz", fmt.Sprintf("unknown timezone %q: %v", b.Schedule.TZ, err))
			}
		}
	}

	return errs
}

// ValidateCron checks that expr is a valid 5-field standard cron expression.
func ValidateCron(expr string) error {
	_, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(expr)
	if err != nil {
		return fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}
	return nil
}

// NextOccurrence returns the next scheduled time after `after`, using the
// cron expression and IANA timezone from the schedule.
func NextOccurrence(s *Schedule, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(s.TZ)
	if err != nil {
		return time.Time{}, fmt.Errorf("loading timezone %q: %w", s.TZ, err)
	}

	sched, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(s.Expr)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing cron %q: %w", s.Expr, err)
	}

	// cron library works in the location of the time passed to Next().
	// Convert after to the target timezone so the schedule fires at local wall time.
	localAfter := after.In(loc)
	next := sched.Next(localAfter)
	return next, nil
}

// ---- Helpers ---------------------------------------------------------------

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}
