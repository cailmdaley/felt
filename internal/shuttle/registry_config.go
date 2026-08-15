package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	// BuiltinsReplace is the legacy spelling of BuiltinsRestrict. Keep reading
	// it so existing agents.json files do not fail after an upgrade.
	BuiltinsReplace = "replace"
)

// agentsFileVersion is the only envelope version this felt reads.
const agentsFileVersion = 1

// agentsFile is the user registry's canonical envelope. A bare array is also
// accepted and read as {version: 1, builtins: "merge", agents: […]}.
type agentsFile struct {
	Version  int           `json:"version"`
	Builtins string        `json:"builtins"`
	Agents   []AgentRecord `json:"agents"`
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

	file, warnings, err := parseAgentsFile(data, path)
	if err != nil {
		return nil, err
	}
	for i := range file.Agents {
		file.Agents[i].Source = SourceUser
	}

	agents, mergeWarnings := mergeAgentLayers(builtins.agents, file.Agents, file.Builtins)
	return &AgentRegistry{
		agents:       agents,
		userPath:     path,
		builtinsMode: file.Builtins,
		builtinCount: builtins.builtinCount,
		warnings:     append(warnings, mergeWarnings...),
	}, nil
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
	case BuiltinsMerge, BuiltinsRestrict, BuiltinsReplace:
	default:
		return agentsFile{}, nil, fmt.Errorf(
			"parsing %s: builtins must be %q or %q (legacy: %q), got %q", path, BuiltinsMerge, BuiltinsRestrict, BuiltinsReplace, file.Builtins)
	}
	if unknown := unknownFieldWarning(data, path); unknown != "" {
		warnings = append(warnings, unknown)
	}
	normalizeAgentRecords(file.Agents)
	return file, warnings, nil
}

// parseAnyAgentsPayload accepts either shape — a bare array or the envelope —
// and returns just the records. Version and builtins-mode validation still
// applies to the envelope, so a file written for a newer felt fails loudly
// wherever it is loaded from.
func parseAnyAgentsPayload(data []byte, path string) ([]AgentRecord, error) {
	if isBareArray(data) {
		return parseAgentRecords(data, path)
	}
	file, _, err := parseAgentsFile(data, path)
	if err != nil {
		return nil, err
	}
	return file.Agents, nil
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
// allows, and strips any Source a file tried to declare (provenance is the
// loader's to assign, never the file's).
func normalizeAgentRecords(agents []AgentRecord) {
	for i := range agents {
		agents[i].Source = ""
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
	if mode == BuiltinsRestrict || mode == BuiltinsReplace {
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
