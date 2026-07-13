package shuttle

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// AgentRecord holds the configuration for one agent harness.
//
// An agent is either a *base* agent (carries cli/wrapper/model and the axis
// constraint metadata) or an *alias* record (carries AliasOf + Axes and nothing
// else). An alias resolves to its base agent with the alias's Axes overlaid —
// this is how `claude-opus-chrome` retired from an enumerated combination into
// `claude-opus` + chrome:true without breaking fibers that still name it.
type AgentRecord struct {
	ID            string `json:"id"`
	CLI           string `json:"cli,omitempty"`
	Wrapper       string `json:"wrapper,omitempty"`
	Provider      string `json:"provider,omitempty"`
	Model         string `json:"model,omitempty"`
	ExtraFlags    string `json:"extra_flags,omitempty"`
	RequiresModel bool   `json:"requires_model,omitempty"`
	// Axis constraint metadata (base agents only). EffortLevels is the literal
	// set of effort tokens this harness/model accepts — rendered through to the
	// CLI verbatim, so each harness/model's native vocabulary lives here (Claude:
	// …xhigh,max; Codex varies through max/ultra; Copilot Sonnet caps at high). Empty =
	// effort axis unsupported. DefaultEffort is applied when a fiber omits
	// effort (preserves the pi `:level` suffix behaviour). ChromeCapable gates
	// the chrome axis.
	EffortLevels  []string `json:"effort_levels,omitempty"`
	DefaultEffort string   `json:"default_effort,omitempty"`
	ChromeCapable bool     `json:"chrome_capable,omitempty"`
	CostClass     string   `json:"cost_class,omitempty"`
	// Alias record fields. AliasOf names the base agent; Axes is the overlay
	// applied on resolution.
	AliasOf string   `json:"alias_of,omitempty"`
	Axes    *Axes    `json:"axes,omitempty"`
	Aliases []string `json:"aliases"`
	Default bool     `json:"default"`
}

// Axes carries the orthogonal per-fiber dispatch axes beyond base agent: effort
// (a token from the base agent's EffortLevels), chrome (claude harness only),
// and headless (claude `-p` print mode, claude harness only). Used both as an
// alias record's overlay and as the resolved effective axes. Headless has no
// shuttle:-block field — a fiber opts into print mode by naming a `*-headless`
// alias agent, so it only ever arrives via the overlay.
type Axes struct {
	Effort   string `json:"effort,omitempty"`
	Chrome   bool   `json:"chrome,omitempty"`
	Headless bool   `json:"headless,omitempty"`
}

// IsAlias reports whether this record is an alias (resolves to another agent).
func (a AgentRecord) IsAlias() bool { return a.AliasOf != "" }

// AgentRegistry is the loaded registry of agents.
type AgentRegistry struct {
	agents []AgentRecord
}

// LoadAgentRegistry returns the built-in agent registry, parsed from the
// agents.json embedded into the binary at compile time (see embed.go).
func LoadAgentRegistry() (*AgentRegistry, error) {
	return LoadAgentRegistryFromBytes(embeddedAgentJSON)
}

// LoadAgentRegistryFromBytes parses an agents.json payload from raw bytes.
func LoadAgentRegistryFromBytes(data []byte) (*AgentRegistry, error) {
	var agents []AgentRecord
	if err := json.Unmarshal(data, &agents); err != nil {
		return nil, fmt.Errorf("parsing agents.json: %w", err)
	}
	return &AgentRegistry{agents: agents}, nil
}

// LoadAgentRegistryFromFile reads agents.json from the given path.
func LoadAgentRegistryFromFile(path string) (*AgentRegistry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	return LoadAgentRegistryFromBytes(data)
}

// Find returns the agent with the given ID or alias.
func (r *AgentRegistry) Find(nameOrAlias string) (AgentRecord, bool) {
	lower := strings.ToLower(nameOrAlias)
	// Exact ID match first.
	for _, a := range r.agents {
		if strings.ToLower(a.ID) == lower {
			return a, true
		}
	}
	// Alias match.
	for _, a := range r.agents {
		for _, alias := range a.Aliases {
			if strings.ToLower(alias) == lower {
				return a, true
			}
		}
	}
	return AgentRecord{}, false
}

// Resolve expands a fiber's agent name + block-declared axes into the base
// agent and the effective axes, validating against the base agent's
// constraints. blockEffort/"" and blockChrome/false are the values declared in
// the shuttle: block; an alias record's Axes are overlaid beneath them (block
// wins). Returns a descriptive error when the name is unknown, an alias dangles,
// or an axis violates a constraint.
func (r *AgentRegistry) Resolve(name, blockEffort string, blockChrome bool) (AgentRecord, Axes, error) {
	rec, ok := r.Find(name)
	if !ok {
		return AgentRecord{}, Axes{}, fmt.Errorf("unknown agent %q (known: %s)", name, strings.Join(r.IDs(), ", "))
	}

	// Overlay alias axes beneath block axes (block wins).
	var overlay Axes
	if rec.IsAlias() {
		base, ok := r.Find(rec.AliasOf)
		if !ok {
			return AgentRecord{}, Axes{}, fmt.Errorf("agent %q aliases unknown base %q", rec.ID, rec.AliasOf)
		}
		if rec.Axes != nil {
			overlay = *rec.Axes
		}
		rec = base
	}

	effort := blockEffort
	if effort == "" {
		effort = overlay.Effort
	}
	if effort == "" {
		effort = rec.DefaultEffort
	}
	chrome := blockChrome || overlay.Chrome
	// Headless rides the overlay only — there is no block field for it.
	headless := overlay.Headless

	eff := Axes{Effort: effort, Chrome: chrome, Headless: headless}
	if err := r.validateAxes(rec, eff); err != nil {
		return AgentRecord{}, Axes{}, err
	}
	return rec, eff, nil
}

// validateAxes checks effective axes against a base agent's constraints.
func (r *AgentRegistry) validateAxes(base AgentRecord, eff Axes) error {
	if eff.Effort != "" {
		if len(base.EffortLevels) == 0 {
			return fmt.Errorf("agent %q does not support an effort axis", base.ID)
		}
		found := false
		for _, lvl := range base.EffortLevels {
			if lvl == eff.Effort {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("effort %q not allowed for agent %q (allowed: %s)", eff.Effort, base.ID, strings.Join(base.EffortLevels, ", "))
		}
	}
	if eff.Chrome && !base.ChromeCapable {
		return fmt.Errorf("chrome not supported by agent %q (claude harness only)", base.ID)
	}
	if eff.Headless && base.CLI != "claude" {
		return fmt.Errorf("headless (-p print mode) not supported by agent %q (claude harness only)", base.ID)
	}
	return nil
}

// BaseIDs returns the IDs of pickable base agents (alias records excluded).
func (r *AgentRegistry) BaseIDs() []string {
	var ids []string
	for _, a := range r.agents {
		if !a.IsAlias() {
			ids = append(ids, a.ID)
		}
	}
	return ids
}

// Records returns all agent records (for API exposure of constraint metadata).
func (r *AgentRegistry) Records() []AgentRecord { return r.agents }

// Default returns the registry's default agent, or an error if none is marked.
func (r *AgentRegistry) Default() (AgentRecord, error) {
	for _, a := range r.agents {
		if a.Default {
			return a, nil
		}
	}
	if len(r.agents) > 0 {
		return r.agents[0], nil
	}
	return AgentRecord{}, fmt.Errorf("agent registry is empty")
}

// IDs returns all agent IDs in the registry.
func (r *AgentRegistry) IDs() []string {
	ids := make([]string, len(r.agents))
	for i, a := range r.agents {
		ids[i] = a.ID
	}
	return ids
}
