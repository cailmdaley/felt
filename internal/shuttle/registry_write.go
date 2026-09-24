package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// The user registry's one structured writer: `felt shuttle agents effort`.
//
// Everything else in agents.json is edited as text. An override is a single
// field keyed by id, so it can be written without re-encoding the records
// around it: the file is edited at the top level only, keys keep their order,
// every value other than `overrides` passes through as the raw JSON it was
// (re-indented, never re-modelled), and the result is validated by the same
// fold the loader runs before it replaces the file.

// SetEffortOverride sets (level != "") or removes (level == "") the
// default_effort override for the agent `name` lands on, in the user registry
// file. It returns the file's path, the canonical agent id the override is
// keyed by, and whether the file changed. The current file must load cleanly:
// an edit never builds on a broken registry.
func SetEffortOverride(name, level string) (path, id string, changed bool, err error) {
	path, err = UserAgentsPath()
	if err != nil {
		return "", "", false, err
	}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return "", "", false, fmt.Errorf("reading %s: %w", path, err)
	}
	exists := err == nil

	builtins, err := LoadBuiltinAgentRegistry()
	if err != nil {
		return "", "", false, err
	}
	current := builtins
	if exists {
		if current, err = foldUserAgents(builtins, data, path); err != nil {
			return "", "", false, err
		}
	}
	target, err := canonicalIndex(current.agents, name)
	if err != nil {
		return "", "", false, err
	}
	id = current.agents[target].ID

	if !exists && level == "" {
		return path, id, false, nil
	}

	fields, err := topLevelFields(data, exists)
	if err != nil {
		return "", "", false, fmt.Errorf("parsing %s: %w", path, err)
	}
	overrides := map[string]json.RawMessage{}
	if raw, ok := fieldValue(fields, "overrides"); ok {
		if err := json.Unmarshal(raw, &overrides); err != nil {
			return "", "", false, fmt.Errorf("parsing %s: overrides: %w", path, err)
		}
	}
	before := len(overrides)
	for key := range overrides {
		if i, err := canonicalIndex(current.agents, key); err == nil && i == target {
			delete(overrides, key)
		}
	}
	if level == "" && len(overrides) == before {
		return path, id, false, nil
	}
	if level != "" {
		overrides[id], _ = json.Marshal(agentOverride{DefaultEffort: level})
	}

	if len(overrides) == 0 {
		fields = withoutField(fields, "overrides")
	} else {
		raw, err := json.Marshal(overrides)
		if err != nil {
			return "", "", false, fmt.Errorf("encoding overrides: %w", err)
		}
		fields = withField(fields, "overrides", raw)
	}
	out, err := renderFields(fields)
	if err != nil {
		return "", "", false, fmt.Errorf("encoding %s: %w", path, err)
	}
	if _, err := foldUserAgents(builtins, out, path); err != nil {
		return "", "", false, err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", "", false, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, out, 0644); err != nil {
		return "", "", false, fmt.Errorf("writing %s: %w", path, err)
	}
	return path, id, true, nil
}

// docField is one top-level key of the envelope, its value kept as raw JSON.
type docField struct {
	key string
	raw json.RawMessage
}

// topLevelFields reads the envelope's keys in file order. An absent file is the
// empty envelope; a bare array becomes the object form around it.
func topLevelFields(data []byte, exists bool) ([]docField, error) {
	envelope := func(agents json.RawMessage) []docField {
		return []docField{
			{"version", json.RawMessage(fmt.Sprint(agentsFileVersion))},
			{"builtins", json.RawMessage(`"` + BuiltinsMerge + `"`)},
			{"agents", agents},
		}
	}
	if !exists {
		return envelope(json.RawMessage(`[]`)), nil
	}
	if isBareArray(data) {
		return envelope(json.RawMessage(bytes.TrimSpace(data))), nil
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("expected a JSON object or array")
	}
	var fields []docField
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		fields = append(fields, docField{tok.(string), raw})
	}
	return fields, nil
}

func fieldValue(fields []docField, key string) (json.RawMessage, bool) {
	for _, f := range fields {
		if f.key == key {
			return f.raw, true
		}
	}
	return nil, false
}

// withField replaces key's value in place, or appends it.
func withField(fields []docField, key string, raw json.RawMessage) []docField {
	for i := range fields {
		if fields[i].key == key {
			fields[i].raw = raw
			return fields
		}
	}
	return append(fields, docField{key, raw})
}

func withoutField(fields []docField, key string) []docField {
	out := fields[:0:0]
	for _, f := range fields {
		if f.key != key {
			out = append(out, f)
		}
	}
	return out
}

// renderFields writes the envelope back with two-space indentation.
func renderFields(fields []docField) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, f := range fields {
		key, _ := json.Marshal(f.key)
		buf.WriteString("  ")
		buf.Write(key)
		buf.WriteString(": ")
		if err := json.Indent(&buf, f.raw, "  ", "  "); err != nil {
			return nil, err
		}
		if i < len(fields)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString("}\n")
	return buf.Bytes(), nil
}
