// Package harness holds what Shuttle knows about each agent harness it runs
// workers on: one record of facts per harness, the single table every
// harness-dependent decision in the CLIs reads, and the one each resolved agent
// record carries to the daemon (shuttle.ResolvedAgent.Harness). What a harness
// does, as opposed to what it is, lives beside the code that calls it, in one
// table per package keyed by Name: messaging's delivery adapters, the
// transcript index's line parsers, felt setup's installers. docs/dev/harnesses.md
// describes the whole contract.
//
// The package is a leaf: felt, Shuttle and messaging packages all import it.
package harness

import "strings"

// Facts is one harness's record. Every field is read by a call site; a fact
// nothing branches on does not belong here.
type Facts struct {
	// Name is the harness's one canonical spelling: in agent records' `cli`,
	// in addresses, in the transcript index.
	Name string `json:"name"`
	// Ledger is the spelling session-ledger rows and the daemon's transcript
	// readers use, which differs from Name only for Claude Code.
	Ledger string `json:"ledger"`
	// Binary is the executable an agent record's wrapper defaults to.
	Binary string `json:"binary"`
	// Identity says how Shuttle learns a worker's conversation id: "assigned"
	// (chosen by the daemon and passed at launch) or "reported" (named by the
	// harness after launch, through its transcript or its SessionStart hook).
	Identity string `json:"identity"`
	// Delivery is how a message reaches a live worker: "native" (the
	// harness's own message socket), "extension" (a socket Shuttle's extension
	// opens inside the harness), "paste" (typed into the worker's terminal),
	// or "inject" (added to a running turn by a hook, and pasted when idle).
	Delivery string `json:"delivery"`
	// IdleSignal is true when the harness's hooks say the human's turn has
	// come, which is what pulse and idle-only wakes need.
	IdleSignal bool `json:"idle_signal"`
	// Interrupts is true when Shuttle can tell from the transcript that the
	// human interrupted a turn.
	Interrupts bool `json:"interrupts"`
	// Transcripts locates the tree the harness keeps conversations in.
	Transcripts Transcripts `json:"transcripts"`
}

// Transcripts names a transcript tree: Shuttle's override variable first,
// then the harness's own home variable joined with Leaf, then Home/Leaf under
// the user's home directory.
type Transcripts struct {
	Env     string `json:"env"`
	HomeEnv string `json:"home_env,omitempty"`
	Home    string `json:"home"`
	Leaf    string `json:"leaf"`
}

var all = []Facts{
	{
		Name: "claude", Ledger: "claude-code", Binary: "claude",
		Identity: "assigned", Delivery: "native", IdleSignal: true, Interrupts: true,
		Transcripts: Transcripts{Env: "SHUTTLE_CLAUDE_PROJECTS_DIR", HomeEnv: "CLAUDE_CONFIG_DIR", Home: ".claude", Leaf: "projects"},
	},
	{
		Name: "codex", Ledger: "codex", Binary: "codex",
		Identity: "reported", Delivery: "paste", IdleSignal: true, Interrupts: true,
		Transcripts: Transcripts{Env: "SHUTTLE_CODEX_SESSIONS_DIR", HomeEnv: "CODEX_HOME", Home: ".codex", Leaf: "sessions"},
	},
	{
		Name: "pi", Ledger: "pi", Binary: "pi",
		Identity: "reported", Delivery: "extension",
		Transcripts: Transcripts{Env: "SHUTTLE_PI_SESSIONS_DIR", Home: ".pi/agent", Leaf: "sessions"},
	},
	{
		Name: "antigravity", Ledger: "antigravity", Binary: "agy",
		Identity: "reported", Delivery: "inject", IdleSignal: true,
		Transcripts: Transcripts{Env: "SHUTTLE_ANTIGRAVITY_BRAIN_DIR", Home: ".gemini/antigravity-cli", Leaf: "brain"},
	},
}

// All returns every harness, in a fixed order.
func All() []Facts { return append([]Facts(nil), all...) }

// Lookup finds a harness by its canonical or ledger spelling.
func Lookup(name string) (Facts, bool) {
	for _, f := range all {
		if f.Name == name || f.Ledger == name {
			return f, true
		}
	}
	return Facts{}, false
}

// Known reports whether name is a harness's canonical spelling.
func Known(name string) bool {
	f, ok := Lookup(name)
	return ok && f.Name == name
}

// Normalize returns the canonical spelling of a known harness. Unknown names
// pass through, so a caller can tell an unsupported harness from bad syntax.
func Normalize(name string) string {
	if f, ok := Lookup(name); ok {
		return f.Name
	}
	return name
}

// LedgerName returns the session-ledger spelling of a known harness, or "".
func LedgerName(name string) string {
	if f, ok := Lookup(name); ok {
		return f.Ledger
	}
	return ""
}

// Names lists the canonical spellings, comma-separated, for messages that
// name the accepted values.
func Names() string {
	names := make([]string, len(all))
	for i, f := range all {
		names[i] = f.Name
	}
	return strings.Join(names, ", ")
}
