package tapestry

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"

	"gopkg.in/yaml.v3"
)

type rawASTRA struct {
	Decisions map[string]rawDecision `yaml:"decisions"`
	Analyses  map[string]rawAnalysis `yaml:"analyses"`
}

type rawAnalysis struct {
	Decisions map[string]rawDecision `yaml:"decisions"`
	Analyses  map[string]rawAnalysis `yaml:"analyses"`
}

type rawDecision struct {
	Label         string               `yaml:"label"`
	Rationale     string               `yaml:"rationale"`
	Tags          []string             `yaml:"tags"`
	Default       string               `yaml:"default"`
	Options       map[string]rawOption `yaml:"options"`
	TapestryNodes []string             `yaml:"tapestry_nodes"`
}

type rawOption struct {
	Label          string `yaml:"label"`
	Description    string `yaml:"description"`
	Excluded       bool   `yaml:"excluded"`
	ExcludedReason string `yaml:"excluded_reason"`
}

func ReadASTRA(projectRoot string) ([]Decision, error) {
	data, err := os.ReadFile(filepath.Join(projectRoot, "astra.yaml"))
	if err != nil {
		if os.IsNotExist(err) {
			return []Decision{}, nil
		}
		return nil, fmt.Errorf("read astra.yaml: %w", err)
	}

	var raw rawASTRA
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse astra.yaml: %w", err)
	}

	decisions := flattenDecisions(raw.Decisions, "")
	flattenAnalysisDecisions(raw.Analyses, &decisions)
	return decisions, nil
}

func flattenAnalysisDecisions(analyses map[string]rawAnalysis, out *[]Decision) {
	ids := sortedKeys(analyses)
	for _, analysisID := range ids {
		analysis := analyses[analysisID]
		*out = append(*out, flattenDecisions(analysis.Decisions, analysisID)...)
		flattenAnalysisDecisions(analysis.Analyses, out)
	}
}

func flattenDecisions(rawDecisions map[string]rawDecision, analysisID string) []Decision {
	ids := sortedKeys(rawDecisions)
	decisions := make([]Decision, 0, len(ids))
	for _, id := range ids {
		raw := rawDecisions[id]
		decisions = append(decisions, Decision{
			ID:            id,
			Label:         raw.Label,
			Rationale:     raw.Rationale,
			Tags:          slices.Clone(raw.Tags),
			Default:       raw.Default,
			AnalysisID:    analysisID,
			Options:       flattenOptions(raw.Options),
			EvidenceIDs:   []string{},
			tapestryNodes: slices.Clone(raw.TapestryNodes),
		})
	}
	return decisions
}

func flattenOptions(rawOptions map[string]rawOption) []DecisionOption {
	ids := sortedKeys(rawOptions)
	options := make([]DecisionOption, 0, len(ids))
	for _, id := range ids {
		raw := rawOptions[id]
		options = append(options, DecisionOption{
			ID:             id,
			Label:          raw.Label,
			Description:    raw.Description,
			Excluded:       raw.Excluded,
			ExcludedReason: raw.ExcludedReason,
		})
	}
	return options
}

func WireEvidence(decisions []Decision, nodes []Node) {
	specToIDs := map[string][]string{}
	tagToIDs := map[string][]string{}
	for _, node := range nodes {
		if node.SpecName != "" {
			specToIDs[node.SpecName] = append(specToIDs[node.SpecName], node.ID)
		}
		for _, tag := range node.Tags {
			tagToIDs[tag] = append(tagToIDs[tag], node.ID)
		}
	}

	for i := range decisions {
		seen := map[string]struct{}{}
		evidenceIDs := []string{}
		for _, specName := range decisions[i].tapestryNodes {
			for _, id := range specToIDs[specName] {
				if _, ok := seen[id]; ok {
					continue
				}
				seen[id] = struct{}{}
				evidenceIDs = append(evidenceIDs, id)
			}
		}
		if len(evidenceIDs) == 0 {
			for _, id := range tagToIDs["evidence:"+decisions[i].ID] {
				if _, ok := seen[id]; ok {
					continue
				}
				seen[id] = struct{}{}
				evidenceIDs = append(evidenceIDs, id)
			}
		}
		sort.Strings(evidenceIDs)
		decisions[i].EvidenceIDs = evidenceIDs
	}
}

func sortedKeys[T any](m map[string]T) []string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
