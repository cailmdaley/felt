package shuttle

import (
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// FacetKey names the optional Shuttle configuration in fiber frontmatter.
const FacetKey = "shuttle"

// RuntimeKey names machine-managed continuation state inside the Shuttle facet.
const RuntimeKey = "runtime"

func facetNode(f *felt.Felt) (*yaml.Node, bool) {
	node, ok := f.ExtraFields[FacetKey]
	if !ok || node == nil || node.Kind != yaml.MappingNode {
		return nil, false
	}
	return node, true
}

// HasFacet reports whether the fiber carries a mapping-valued Shuttle facet.
func HasFacet(f *felt.Felt) bool {
	_, ok := facetNode(f)
	return ok
}

// BlockOf decodes the fiber's Shuttle facet, reading a legacy kind as the kind
// it stands for (see LegacyKinds). It returns false when the fiber has no
// mapping-valued facet.
func BlockOf(f *felt.Felt) (*Block, bool, error) {
	node, ok := facetNode(f)
	if !ok {
		return nil, false, nil
	}
	var block Block
	if err := node.Decode(&block); err != nil {
		return nil, true, fmt.Errorf("shuttle: block is malformed: %w", err)
	}
	block.Kind = NormalizeKind(block.Kind)
	return &block, true, nil
}

// StoredKind returns the kind exactly as the fiber's facet stores it, before
// any legacy value is normalized. Empty when there is no facet or no kind.
func StoredKind(f *felt.Felt) string {
	node, ok := facetNode(f)
	if !ok {
		return ""
	}
	kind := felt.MappingValueNode(node, "kind")
	if kind == nil || kind.Kind != yaml.ScalarNode {
		return ""
	}
	return strings.TrimSpace(kind.Value)
}

// SetField replaces one string-valued key inside the existing Shuttle facet.
func SetField(f *felt.Felt, key, value string) error {
	node, ok := facetNode(f)
	if !ok {
		return fmt.Errorf("shuttle: no shuttle block present to set %q on", key)
	}
	felt.SetMappingScalar(node, key, value)
	return nil
}

// SetNodeField replaces or removes one typed key inside the existing facet.
func SetNodeField(f *felt.Felt, key string, value any) error {
	node, ok := facetNode(f)
	if !ok {
		return fmt.Errorf("shuttle: no shuttle block present to set %q on", key)
	}
	return felt.SetMappingNode(node, key, value)
}

func runtimeNode(f *felt.Felt) *yaml.Node {
	facet, ok := facetNode(f)
	if !ok {
		return nil
	}
	if existing := felt.MappingValueNode(facet, RuntimeKey); existing != nil {
		if existing.Kind == yaml.MappingNode {
			return existing
		}
		existing.Kind = yaml.MappingNode
		existing.Tag = "!!map"
		existing.Value = ""
		existing.Style = 0
		existing.Content = nil
		return existing
	}
	runtime := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	facet.Content = append(facet.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: RuntimeKey},
		runtime,
	)
	return runtime
}

// SetRuntimeField writes one machine-managed key inside shuttle.runtime. An
// empty value removes that key; the runtime mapping is created as needed.
func SetRuntimeField(f *felt.Felt, key, value string) error {
	runtime := runtimeNode(f)
	if runtime == nil {
		return fmt.Errorf("shuttle: no shuttle block present to set runtime.%q on", key)
	}
	if value == "" {
		felt.RemoveMappingKey(runtime, key)
		return nil
	}
	felt.SetMappingScalar(runtime, key, value)
	return nil
}

var configKeys = map[string]bool{
	"kind": true, "host": true, "project_dir": true, "agent": true,
	"effort": true, "chrome": true, "surface": true, "schedule": true,
}

// SetConfig replaces the typed configuration while preserving runtime and
// unknown sibling fields in the facet.
func SetConfig(f *felt.Felt, block *Block) error {
	node, ok := facetNode(f)
	if !ok {
		return f.SetExtraField(FacetKey, block)
	}
	var encoded yaml.Node
	if err := encoded.Encode(block); err != nil {
		return err
	}
	if encoded.Kind != yaml.MappingNode {
		return fmt.Errorf("shuttle: encoded config block is not a mapping")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if configKeys[strings.TrimSpace(node.Content[i].Value)] {
			continue
		}
		encoded.Content = append(encoded.Content, node.Content[i], node.Content[i+1])
	}
	if f.ExtraFields == nil {
		f.ExtraFields = map[string]*yaml.Node{}
	}
	f.ExtraFields[FacetKey] = &encoded
	return nil
}

// ValidateFacet checks a mapping-valued Shuttle facet against its block schema.
func ValidateFacet(f *felt.Felt) error {
	block, ok, err := BlockOf(f)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if errs := Validate(block, nil); len(errs) > 0 {
		return fmt.Errorf("invalid shuttle: block:\n%s", errs.Error())
	}
	return nil
}

// Resolve attaches the flat facet and its resolved agent/schedule view to the
// fiber's JSON representation. Facet data remains in frontmatter unchanged.
func Resolve(f *felt.Felt, reg *AgentRegistry, now time.Time) error {
	node, ok := facetNode(f)
	if !ok {
		return nil
	}
	var flat map[string]interface{}
	if err := node.Decode(&flat); err != nil || flat == nil {
		return nil
	}
	// Readers of the resolved view see the kind a legacy value is read as.
	if kind, ok := flat["kind"].(string); ok {
		flat["kind"] = NormalizeKind(kind)
	}
	var block Block
	if err := node.Decode(&block); err == nil {
		if resolved, err := ResolveBlock(&block, reg, now); err == nil && !resolved.IsEmpty() {
			if _, exists := flat["resolved"]; !exists {
				flat["resolved"] = resolved
			}
		}
	}
	f.SetJSONField(FacetKey, flat)
	return nil
}
