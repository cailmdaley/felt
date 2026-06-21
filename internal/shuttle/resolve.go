package shuttle

import "time"

// ResolvedAgent is the daemon-facing resolution of a block's agent: the base
// agent record (cli/wrapper/model/...) plus the effective axes (effort/chrome/
// headless after alias overlay + block + defaults). Rendering these into CLI
// flags stays the daemon's job — this is the resolved INPUT to that, so the
// daemon needs neither the embedded registry nor the alias/axis logic.
type ResolvedAgent struct {
	ID            string `json:"id"`
	CLI           string `json:"cli,omitempty"`
	Wrapper       string `json:"wrapper,omitempty"`
	Provider      string `json:"provider,omitempty"`
	Model         string `json:"model,omitempty"`
	ExtraFlags    string `json:"extra_flags,omitempty"`
	RequiresModel bool   `json:"requires_model,omitempty"`
	// Effective axes (post-resolution).
	Effort   string `json:"effort,omitempty"`
	Chrome   bool   `json:"chrome,omitempty"`
	Headless bool   `json:"headless,omitempty"`
}

// Resolved is the resolved view of a shuttle: block — what felt emits additively
// under shuttle.resolved in `felt show -j` / `felt ls --json`. The daemon reads
// this instead of re-resolving the agent name and re-parsing cron itself; the
// flat config/runtime fields beside it stay the source of truth and are
// unchanged, so a daemon that ignores `resolved` (Stage 2) keeps working.
type Resolved struct {
	Agent   *ResolvedAgent `json:"agent,omitempty"`
	NextDue *time.Time     `json:"next_due,omitempty"`
}

// IsEmpty reports whether nothing resolved (no agent, no schedule) — callers
// skip attaching an empty resolved object.
func (r *Resolved) IsEmpty() bool {
	return r == nil || (r.Agent == nil && r.NextDue == nil)
}

// NewResolvedAgent folds a base agent record and the effective axes into the
// daemon-facing ResolvedAgent. It is the single place this projection is made,
// so `felt show -j`'s shuttle.resolved.agent (via ResolveBlock) and
// `felt shuttle agents resolve` (ad-hoc, for the daemon's capture path) emit a
// byte-identical shape.
func NewResolvedAgent(rec AgentRecord, axes Axes) *ResolvedAgent {
	return &ResolvedAgent{
		ID:            rec.ID,
		CLI:           rec.CLI,
		Wrapper:       rec.Wrapper,
		Provider:      rec.Provider,
		Model:         rec.Model,
		ExtraFlags:    rec.ExtraFlags,
		RequiresModel: rec.RequiresModel,
		Effort:        axes.Effort,
		Chrome:        axes.Chrome,
		Headless:      axes.Headless,
	}
}

// ResolveBlock computes the resolved view of a block: the agent name (or the
// registry default when unnamed) → base record + effective axes, and — for a
// standing role — the next scheduled occurrence strictly after `now`. Returns an
// error on a structurally invalid block (unknown agent, dangling alias, axis
// violation, unparseable cron); a read-path caller that has not pre-validated
// can treat that as "emit the flat block without a resolved sub-key".
func ResolveBlock(b *Block, reg *AgentRegistry, now time.Time) (*Resolved, error) {
	res := &Resolved{}

	name := b.Agent
	if name == "" && reg != nil {
		if def, err := reg.Default(); err == nil {
			name = def.ID
		}
	}
	if name != "" && reg != nil {
		rec, axes, err := reg.Resolve(name, b.Effort, b.Chrome)
		if err != nil {
			return nil, err
		}
		res.Agent = NewResolvedAgent(rec, axes)
	}

	if b.Kind == "standing" && b.Schedule != nil {
		next, err := NextOccurrence(b.Schedule, now)
		if err != nil {
			return nil, err
		}
		res.NextDue = &next
	}

	return res, nil
}
