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

// UnmarshalYAML accepts the canonical `kind` field as well as the legacy `mode`
// alias, mirroring UnmarshalJSON. felt decodes the block from a yaml.Node (not
// from JSON), so without this the `mode` alias would be unreachable and a
// `mode:`-only legacy block would decode to an empty Kind — failing validation
// and skipping next_due resolution. The daemon tolerates `mode` (it reads
// kind || mode); as felt becomes the schema authority it must tolerate it too.
// The aux struct (not Block) breaks the decode recursion; the nested *Schedule
// still resolves through its own UnmarshalYAML (the legacy `timezone` alias).
func (b *Block) UnmarshalYAML(value *yaml.Node) error {
	var aux struct {
		Kind       string    `yaml:"kind"`
		Mode       string    `yaml:"mode"`
		Host       string    `yaml:"host"`
		ProjectDir string    `yaml:"project_dir"`
		Agent      string    `yaml:"agent"`
		Effort     string    `yaml:"effort"`
		Chrome     bool      `yaml:"chrome"`
		Schedule   *Schedule `yaml:"schedule"`
	}
	if err := value.Decode(&aux); err != nil {
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
//   - pinned   — schedule-less interactive role that rests PARKED on the board's
//     pinned strip (status:open). It never auto-dispatches: the human starts it
//     (Resume / strip → In-flight, which force-dispatches and flips it active);
//     the worker stays alive as a standing interface; on session end the poller
//     parks it back to the strip (active → open). Human-driven, not looped —
//     see Poller.filter_eligible and mark_pinned_parked.
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

	// A pinned role has no cron recurrence — it never auto-dispatches at all:
	// the human starts it (Resume/force-dispatch) and it parks back to the
	// strip on exit. A schedule would be meaningless (and misleading on the
	// board). Reject the combination loudly rather than silently ignoring it.
	if b.Kind == "pinned" && b.Schedule != nil {
		add("schedule", "not allowed for kind=pinned (pinned roles are human-driven, not cron-driven)")
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

// PrevOccurrence returns the most recent scheduled time at or before `before`,
// using the cron expression and IANA timezone from the schedule. It is the
// backward complement to NextOccurrence — robfig/cron exposes only forward
// Next — and exists for the daemon's catch-up dispatch decision: "did a tick
// fire since the role was last serviced?" reduces to "is PrevOccurrence(now)
// strictly after last_serviced?", a pure timestamp comparison the daemon makes
// from felt's resolved JSON without re-parsing cron.
//
// Scans minute-by-minute backward (cron's resolution), bounded to ~366 days. A
// minute m is an occurrence iff the first activation strictly after (m - 1s) is
// m itself. Returns an error if no occurrence is found within the window (an
// effectively-impossible schedule, e.g. one whose next real fire is years out);
// callers emitting prev_due treat that as "omit prev_due", not a hard failure.
func PrevOccurrence(s *Schedule, before time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(s.TZ)
	if err != nil {
		return time.Time{}, fmt.Errorf("loading timezone %q: %w", s.TZ, err)
	}

	sched, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(s.Expr)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing cron %q: %w", s.Expr, err)
	}

	// Truncate to the minute so the candidate sits on an occurrence boundary,
	// then walk backward. Truncate operates on the absolute instant; every IANA
	// offset is a whole number of minutes, so the result lands on local wall
	// :00 seconds in every zone. Work in loc to mirror NextOccurrence.
	candidate := before.In(loc).Truncate(time.Minute)
	for i := 0; i <= 366*24*60; i++ {
		if sched.Next(candidate.Add(-time.Second)).Equal(candidate) {
			return candidate, nil
		}
		candidate = candidate.Add(-time.Minute)
	}

	return time.Time{}, fmt.Errorf("no occurrence of %q within one year before %v", s.Expr, before)
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
