package felt

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// SetExtraField installs a non-native top-level frontmatter key on the fiber.
// The value is encoded as YAML and stored in ExtraFields so Marshal/JSON
// round-trips it like any other opaque namespace.
func (f *Felt) SetExtraField(key string, value any) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("extra field key cannot be empty")
	}
	if value == nil {
		if f.ExtraFields != nil {
			delete(f.ExtraFields, key)
		}
		f.removeExtraFieldOrder(key)
		return nil
	}

	wrapped, err := yaml.Marshal(map[string]any{key: value})
	if err != nil {
		return fmt.Errorf("marshal extra field %q: %w", key, err)
	}
	var node yaml.Node
	if err := yaml.Unmarshal(wrapped, &node); err != nil {
		return fmt.Errorf("decode extra field %q: %w", key, err)
	}
	if len(node.Content) == 0 || node.Content[0].Kind != yaml.MappingNode || len(node.Content[0].Content) < 2 {
		return fmt.Errorf("extra field %q did not decode to a mapping", key)
	}
	_, existed := f.ExtraFields[key]
	if f.ExtraFields == nil {
		f.ExtraFields = map[string]*yaml.Node{}
	}
	f.ExtraFields[key] = node.Content[0].Content[1]
	if !existed {
		f.ExtraFieldOrder = append(f.ExtraFieldOrder, key)
	}
	return nil
}

// removeExtraFieldOrder drops key from the recorded extra-field order.
func (f *Felt) removeExtraFieldOrder(key string) {
	if len(f.ExtraFieldOrder) == 0 {
		return
	}
	out := f.ExtraFieldOrder[:0]
	for _, k := range f.ExtraFieldOrder {
		if k != key {
			out = append(out, k)
		}
	}
	f.ExtraFieldOrder = out
}

// ExtraFieldKeys returns sorted non-native top-level frontmatter keys.
func (f *Felt) ExtraFieldKeys() []string {
	if len(f.ExtraFields) == 0 {
		return nil
	}
	keys := make([]string, 0, len(f.ExtraFields))
	for key := range f.ExtraFields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ExtraFieldsYAML renders opaque frontmatter back to YAML for display/search.
func (f *Felt) ExtraFieldsYAML() string {
	mapping := extraFieldsMappingNode(f.ExtraFields)
	if mapping == nil {
		return ""
	}
	data, err := yaml.Marshal(mapping)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// ExtraFieldsSearchText exposes opaque frontmatter to felt ls/search without
// interpreting any schema beyond serializing the YAML text.
func (f *Felt) ExtraFieldsSearchText() string {
	return f.ExtraFieldsYAML()
}

// DataFlowInputs returns generic input refs extracted from an opaque
// top-level `inputs:` field when present. felt treats these only as a data-flow
// convention, not as a native semantic schema.
func (f *Felt) DataFlowInputs() []DataFlowInputRef {
	node := extraFieldNode(f.ExtraFields, "inputs")
	if node == nil || node.Kind != yaml.SequenceNode {
		return nil
	}
	out := make([]DataFlowInputRef, 0, len(node.Content))
	for _, item := range node.Content {
		if item == nil || item.Kind != yaml.MappingNode {
			continue
		}
		inputID := strings.TrimSpace(mappingScalar(item, "id"))
		if inputID == "" {
			continue
		}
		out = append(out, DataFlowInputRef{
			InputID: inputID,
			From:    strings.TrimSpace(mappingScalar(item, "from")),
		})
	}
	return out
}

// HasDataFlowOutput reports whether an opaque top-level `outputs:` sequence has
// an item with the requested id.
func (f *Felt) HasDataFlowOutput(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	node := extraFieldNode(f.ExtraFields, "outputs")
	if node == nil || node.Kind != yaml.SequenceNode {
		return false
	}
	for _, item := range node.Content {
		if item == nil || item.Kind != yaml.MappingNode {
			continue
		}
		if strings.TrimSpace(mappingScalar(item, "id")) == id {
			return true
		}
	}
	return false
}

// HasFrontmatterFragment reports whether any opaque frontmatter field exposes a
// fragment-compatible element with the requested id. Mapping-of-mappings fields
// contribute their first-level keys (e.g. `decisions.<id>`), and sequences of
// mappings contribute each item's `id` field (e.g. `inputs[].id`).
func (f *Felt) HasFrontmatterFragment(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	for _, node := range f.ExtraFields {
		for _, candidate := range fragmentIDsFromNode(node) {
			if candidate == id {
				return true
			}
		}
	}
	return false
}

// RewriteDataFlowRefs rewrites opaque `inputs[].from` references in place.
// Returns true when at least one scalar changed.
func (f *Felt) RewriteDataFlowRefs(rewrite func(string) (string, bool)) bool {
	node := extraFieldNode(f.ExtraFields, "inputs")
	if node == nil || node.Kind != yaml.SequenceNode {
		return false
	}
	changed := false
	for _, item := range node.Content {
		if item == nil || item.Kind != yaml.MappingNode {
			continue
		}
		fromNode := mappingValueNode(item, "from")
		if fromNode == nil || fromNode.Kind != yaml.ScalarNode {
			continue
		}
		current := strings.TrimSpace(fromNode.Value)
		if current == "" {
			continue
		}
		next, ok := rewrite(current)
		if !ok || next == current {
			continue
		}
		fromNode.Value = next
		changed = true
	}
	return changed
}

func extraFieldNode(extra map[string]*yaml.Node, key string) *yaml.Node {
	if len(extra) == 0 {
		return nil
	}
	return extra[key]
}

func extraFieldsMappingNode(extra map[string]*yaml.Node) *yaml.Node {
	if len(extra) == 0 {
		return nil
	}
	mapping := &yaml.Node{Kind: yaml.MappingNode}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := extra[key]
		if value == nil {
			continue
		}
		mapping.Content = append(mapping.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
			value,
		)
	}
	if len(mapping.Content) == 0 {
		return nil
	}
	return mapping
}

func mappingValueNode(mapping *yaml.Node, key string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if strings.TrimSpace(mapping.Content[i].Value) == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

func mappingScalar(mapping *yaml.Node, key string) string {
	node := mappingValueNode(mapping, key)
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return node.Value
}

func fragmentIDsFromNode(node *yaml.Node) []string {
	if node == nil {
		return nil
	}
	switch node.Kind {
	case yaml.SequenceNode:
		var ids []string
		for _, item := range node.Content {
			if item == nil || item.Kind != yaml.MappingNode {
				continue
			}
			if id := strings.TrimSpace(mappingScalar(item, "id")); id != "" {
				ids = append(ids, id)
			}
		}
		return ids
	case yaml.MappingNode:
		if !mappingOfCompositeValues(node) {
			return nil
		}
		ids := make([]string, 0, len(node.Content)/2)
		for i := 0; i+1 < len(node.Content); i += 2 {
			if id := strings.TrimSpace(node.Content[i].Value); id != "" {
				ids = append(ids, id)
			}
		}
		return ids
	default:
		return nil
	}
}

func mappingOfCompositeValues(node *yaml.Node) bool {
	if node == nil || node.Kind != yaml.MappingNode || len(node.Content) == 0 {
		return false
	}
	for i := 1; i < len(node.Content); i += 2 {
		switch node.Content[i].Kind {
		case yaml.MappingNode, yaml.SequenceNode:
		default:
			return false
		}
	}
	return true
}
