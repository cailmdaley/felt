package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The user agent registry — how a machine adds to or restricts the agents the
// binary ships.
//
// The embedded set (embed.go) is the maintained default fleet. A user file is
// still useful for local wrappers, account-specific additions, and restricting
// a host to an explicit subset:
//
//	1. $FELT_AGENTS_FILE      (single path, `~` expanded)
//	2. ~/.config/felt/agents.json
//
// This mirrors the stores registry (cmd/shuttle_stores.go) one step short: there
// is no inline-value env var, because a comma list of paths inlines into an
// environment and a JSON registry does not.
//
// Because every Go call site already funnels through LoadAgentRegistry(), the
// whole feature is a change *inside* that function. No caller, no signature and
// no wire shape moves — including install-time validation (schema.go's Validate
// resolves against whatever registry it is handed) and the daemon (which shells
// `felt shuttle agents`).

// Provenance values for AgentRecord.Source.
const (
	SourceBuiltin = "builtin"
	SourceUser    = "user"
)

// Values for the user file's `builtins` field.
const (
	BuiltinsMerge    = "merge"
	BuiltinsRestrict = "restrict"
)

// agentsFileVersion is the only envelope version this felt reads.
const agentsFileVersion = 1

// DefaultEffortOverride is AgentRecord.DefaultEffortSource for a record whose
// default_effort comes from the file's `overrides` block.
const DefaultEffortOverride = "override"

// agentsFile is the user registry's canonical envelope. A bare array is also
// accepted and read as {version: 1, builtins: "merge", agents: […]}.
//
// Overrides patch single fields of the RESOLVED registry, keyed by agent id —
// the one structured gesture beside wholesale records:
//
//	"overrides": { "claude-opus": { "default_effort": "high" } }
//
// They apply after the layer merge, so they reach built-in and user records
// alike without copying a record into the file. An alias key (an `aliases`
// entry or an alias record) lands on its canonical base agent. default_effort
// is the only field an override may set; an unknown field, an unknown agent, or
// an effort outside that agent's effort_levels fails the load.
type agentsFile struct {
	Version   int                        `json:"version"`
	Builtins  string                     `json:"builtins"`
	Agents    []AgentRecord              `json:"agents"`
	Overrides map[string]json.RawMessage `json:"overrides,omitempty"`
}

// agentOverride is one entry of the `overrides` block.
type agentOverride struct {
	DefaultEffort string `json:"default_effort"`
}

// UserAgentsPath is where the user registry is read from (and written to by
// `felt shuttle agents init`): $FELT_AGENTS_FILE, else ~/.config/felt/agents.json.
func UserAgentsPath() (string, error) {
	if env := os.Getenv("FELT_AGENTS_FILE"); env != "" {
		return expandHome(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "felt", "agents.json"), nil
}

// layerUserAgents folds the user registry (if present) onto the built-in layer.
func layerUserAgents(builtins *AgentRegistry) (*AgentRegistry, error) {
	path, err := UserAgentsPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return builtins, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	return foldUserAgents(builtins, data, path)
}

// foldUserAgents builds the effective registry from the built-in layer and the
// user file's bytes: parse, merge by id, then apply overrides.
func foldUserAgents(builtins *AgentRegistry, data []byte, path string) (*AgentRegistry, error) {
	file, warnings, err := parseAgentsFile(data, path)
	if err != nil {
		return nil, err
	}
	for i := range file.Agents {
		file.Agents[i].Source = SourceUser
	}

	agents, mergeWarnings := mergeAgentLayers(builtins.agents, file.Agents, file.Builtins)
	if err := applyOverrides(agents, file.Overrides); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &AgentRegistry{
		agents:       agents,
		userPath:     path,
		builtinsMode: file.Builtins,
		builtinCount: builtins.builtinCount,
		warnings:     append(warnings, mergeWarnings...),
	}, nil
}

// applyOverrides patches the merged records in place. Every problem is fatal:
// an override that silently does nothing is the failure this block exists to
// make impossible.
func applyOverrides(agents []AgentRecord, overrides map[string]json.RawMessage) error {
	keys := make([]string, 0, len(overrides))
	for k := range overrides {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	claimed := map[int]string{}
	for _, key := range keys {
		dec := json.NewDecoder(bytes.NewReader(overrides[key]))
		dec.DisallowUnknownFields()
		var ov agentOverride
		if err := dec.Decode(&ov); err != nil {
			return fmt.Errorf("overrides[%q]: %w (default_effort is the only field an override sets)", key, err)
		}
		if ov.DefaultEffort == "" {
			return fmt.Errorf("overrides[%q]: default_effort is required", key)
		}
		i, err := canonicalIndex(agents, key)
		if err != nil {
			return fmt.Errorf("overrides[%q]: %w", key, err)
		}
		if prev, ok := claimed[i]; ok {
			return fmt.Errorf("overrides %q and %q both name agent %q", prev, key, agents[i].ID)
		}
		claimed[i] = key
		if !containsString(agents[i].EffortLevels, ov.DefaultEffort) {
			if len(agents[i].EffortLevels) == 0 {
				return fmt.Errorf("overrides[%q]: agent %q has no effort axis", key, agents[i].ID)
			}
			return fmt.Errorf("overrides[%q]: effort %q not allowed for agent %q (allowed: %s)",
				key, ov.DefaultEffort, agents[i].ID, strings.Join(agents[i].EffortLevels, ", "))
		}
		agents[i].DefaultEffort = ov.DefaultEffort
		agents[i].DefaultEffortSource = DefaultEffortOverride
	}
	return nil
}

// canonicalIndex finds the base record a name lands on — by id, by an
// `aliases` entry, or through an alias record's alias_of — with Find's
// precedence.
func canonicalIndex(agents []AgentRecord, name string) (int, error) {
	reg := &AgentRegistry{agents: agents}
	rec, ok := reg.Find(name)
	if !ok {
		return 0, fmt.Errorf("unknown agent %q", name)
	}
	if rec.IsAlias() {
		base, ok := reg.Find(rec.AliasOf)
		if !ok {
			return 0, fmt.Errorf("agent %q aliases unknown base %q", rec.ID, rec.AliasOf)
		}
		rec = base
	}
	for i := range agents {
		if agents[i].ID == rec.ID {
			return i, nil
		}
	}
	return 0, fmt.Errorf("unknown agent %q", name)
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// parseAgentsFile reads the user registry envelope (or a bare array) and
// validates version + builtins mode. Malformed content is fatal and the error
// names the path; softer problems come back as warnings.
func parseAgentsFile(data []byte, path string) (agentsFile, []string, error) {
	var warnings []string

	if isBareArray(data) {
		agents, err := parseAgentRecords(data, path)
		if err != nil {
			return agentsFile{}, nil, err
		}
		return agentsFile{Version: agentsFileVersion, Builtins: BuiltinsMerge, Agents: agents}, nil, nil
	}

	var file agentsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return agentsFile{}, nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if file.Version != 0 && file.Version != agentsFileVersion {
		return agentsFile{}, nil, fmt.Errorf(
			"parsing %s: unsupported version %d (this felt reads version %d)", path, file.Version, agentsFileVersion)
	}
	switch file.Builtins {
	case "":
		file.Builtins = BuiltinsMerge
	case BuiltinsMerge, BuiltinsRestrict:
	default:
		return agentsFile{}, nil, fmt.Errorf(
			"parsing %s: builtins must be %q or %q, got %q", path, BuiltinsMerge, BuiltinsRestrict, file.Builtins)
	}
	if unknown := unknownFieldWarning(data, path); unknown != "" {
		warnings = append(warnings, unknown)
	}
	normalizeAgentRecords(file.Agents)
	return file, warnings, nil
}

// parseAgentRecords decodes a bare array of records and normalizes them.
func parseAgentRecords(data []byte, path string) ([]AgentRecord, error) {
	var agents []AgentRecord
	if err := json.Unmarshal(data, &agents); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	normalizeAgentRecords(agents)
	return agents, nil
}

// normalizeAgentRecords applies the two shape relaxations the record format
// allows, and strips any provenance a file tried to declare (Source and
// DefaultEffortSource are the loader's to assign, never the file's).
func normalizeAgentRecords(agents []AgentRecord) {
	for i := range agents {
		agents[i].Source = ""
		agents[i].DefaultEffortSource = ""
		if agents[i].Wrapper == "" {
			agents[i].Wrapper = agents[i].CLI
		}
	}
}

// mergeAgentLayers folds user records onto built-in ones by id: last wins
// *wholesale* (no field-level merge — a half-builtin record is unexplainable,
// and field merge cannot distinguish `chrome_capable: false` from absent), and
// the merged slice keeps first-seen position so listing order does not shuffle
// when a built-in gains an override.
func mergeAgentLayers(builtins, user []AgentRecord, mode string) ([]AgentRecord, []string) {
	var warnings []string

	base := builtins
	if mode == BuiltinsRestrict {
		base = nil
	}

	// A user-declared default retires every built-in default, so Default() still
	// finds exactly one. Two user defaults: the last wins, loudly.
	userDefaults := 0
	lastDefault := -1
	for i, rec := range user {
		if rec.Default {
			userDefaults++
			lastDefault = i
		}
	}
	if userDefaults > 1 {
		warnings = append(warnings, fmt.Sprintf(
			"%d agents declare default:true; using %q", userDefaults, user[lastDefault].ID))
		for i := range user {
			user[i].Default = i == lastDefault
		}
	}
	if userDefaults > 0 {
		cleared := make([]AgentRecord, len(base))
		copy(cleared, base)
		for i := range cleared {
			cleared[i].Default = false
		}
		base = cleared
	}

	merged := make([]AgentRecord, 0, len(base)+len(user))
	at := make(map[string]int, len(base)+len(user))
	for _, rec := range append(append([]AgentRecord{}, base...), user...) {
		key := strings.ToLower(rec.ID)
		if i, ok := at[key]; ok {
			merged[i] = rec
			continue
		}
		at[key] = len(merged)
		merged = append(merged, rec)
	}

	for _, rec := range merged {
		if rec.Source != SourceUser || rec.AliasOf == "" {
			continue
		}
		if _, ok := at[strings.ToLower(rec.AliasOf)]; !ok {
			warnings = append(warnings, fmt.Sprintf(
				"agent %q aliases unknown base %q", rec.ID, rec.AliasOf))
		}
	}

	return merged, warnings
}

// unknownFieldWarning re-decodes strictly, purely to name fields felt ignores —
// the commonest cause of "I set it and nothing happened". Never fatal: a file
// written for a newer felt should still load on an older one.
func unknownFieldWarning(data []byte, path string) string {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var probe agentsFile
	err := dec.Decode(&probe)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		return ""
	}
	return fmt.Sprintf("%s: %s (ignored)", path, err.Error())
}

// isBareArray reports whether the payload's first meaningful byte opens an
// array — the legacy/terse shape, read as a merge layer.
func isBareArray(data []byte) bool {
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

// expandHome resolves a leading `~` against the home directory.
func expandHome(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, path[2:]), nil
}
