package tapestry

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

const (
	astraSchemaURL      = "https://astra-spec.org/v1/analysis.schema.json"
	astraExportVersion  = "1.0"
	structuralInputID   = "felt_node_context"
	structuralOutputID  = "felt_node_report"
	defaultProjectTitle = "Project Fibers"
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

type exportASTRADocument struct {
	Schema   string                         `yaml:"$schema,omitempty"`
	Version  string                         `yaml:"version,omitempty"`
	Name     string                         `yaml:"name,omitempty"`
	Inputs   []felt.ASTRAInput              `yaml:"inputs,omitempty"`
	Outputs  []felt.ASTRAOutput             `yaml:"outputs,omitempty"`
	Analyses map[string]exportASTRAAnalysis `yaml:"analyses,omitempty"`
}

type exportASTRAAnalysis struct {
	Name            string                         `yaml:"name,omitempty"`
	Tags            []string                       `yaml:"tags,omitempty"`
	Description     string                         `yaml:"description,omitempty"`
	Inputs          []felt.ASTRAInput              `yaml:"inputs,omitempty"`
	Outputs         []felt.ASTRAOutput             `yaml:"outputs,omitempty"`
	Decisions       map[string]felt.ASTRADecision  `yaml:"decisions,omitempty"`
	Insights        map[string]felt.ASTRAInsight   `yaml:"insights,omitempty"`
	SuccessCriteria []felt.ASTRASuccessCriterion   `yaml:"success_criteria,omitempty"`
	Container       string                         `yaml:"container,omitempty"`
	Analyses        map[string]exportASTRAAnalysis `yaml:"analyses,omitempty"`
}

type exportASTRANode struct {
	felt     *felt.Felt
	children map[string]*exportASTRANode
}

func ExportASTRA(projectRoot, outPath string) error {
	storage := felt.NewStorage(projectRoot)
	felts, err := storage.ListMetadata()
	if err != nil {
		return err
	}

	root := buildASTRATree(felts)
	projectTitle, err := readMystProjectTitle(projectRoot)
	if err != nil {
		return err
	}
	doc := exportASTRADocument{
		Schema:   astraSchemaURL,
		Version:  astraExportVersion,
		Name:     projectTitle,
		Inputs:   buildStructuralInputs(root.requiredParentInputs()),
		Outputs:  buildStructuralOutputs(nil),
		Analyses: map[string]exportASTRAAnalysis{},
	}
	for _, id := range sortedKeys(root.children) {
		analysis, ok := root.children[id].export()
		if !ok {
			continue
		}
		doc.Analyses[id] = analysis
	}

	data, err := yaml.Marshal(doc)
	if err != nil {
		return fmt.Errorf("marshal astra yaml: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0644); err != nil {
		return fmt.Errorf("write astra yaml: %w", err)
	}
	return nil
}

func buildASTRATree(felts []*felt.Felt) *exportASTRANode {
	root := &exportASTRANode{children: map[string]*exportASTRANode{}}

	for _, f := range felts {
		node := root
		for _, segment := range strings.Split(f.ID, "/") {
			if node.children[segment] == nil {
				node.children[segment] = &exportASTRANode{children: map[string]*exportASTRANode{}}
			}
			node = node.children[segment]
		}
		node.felt = f
	}

	return root
}

func (n *exportASTRANode) export() (exportASTRAAnalysis, bool) {
	childAnalyses := map[string]exportASTRAAnalysis{}
	for _, id := range sortedKeys(n.children) {
		child, ok := n.children[id].export()
		if !ok {
			continue
		}
		childAnalyses[id] = child
	}

	includeSelf := n.felt != nil && hasASTRAExportContent(n.felt)
	if !includeSelf && len(childAnalyses) == 0 {
		return exportASTRAAnalysis{}, false
	}

	analysis := exportASTRAAnalysis{}
	if includeSelf {
		analysis.Name = n.felt.Title
		analysis.Tags = slices.Clone(n.felt.Tags)
		analysis.Description = n.felt.Description
		analysis.Inputs = normalizeASTRAInputs(n.felt.Inputs)
		analysis.Outputs = slices.Clone(n.felt.Outputs)
		if len(n.felt.Decisions) > 0 {
			analysis.Decisions = mapsClone(n.felt.Decisions)
		}
		if len(n.felt.Insights) > 0 {
			analysis.Insights = mapsClone(n.felt.Insights)
		}
		analysis.SuccessCriteria = slices.Clone(n.felt.SuccessCriteria)
		analysis.Container = n.felt.Container
	}
	if !includeSelf {
		analysis.Inputs = buildStructuralInputs(n.requiredParentInputs())
		analysis.Outputs = buildStructuralOutputs(analysis.Outputs)
	}
	if len(childAnalyses) > 0 {
		analysis.Analyses = childAnalyses
	}

	return analysis, true
}

func (n *exportASTRANode) requiredParentInputs() []string {
	required := map[string]struct{}{}
	for _, child := range n.children {
		var inputs []felt.ASTRAInput
		if child.felt != nil {
			inputs = child.felt.Inputs
		}
		for _, input := range inputs {
			ref := normalizeParentRef(input.From)
			if parentInput, ok := parentInputID(ref); ok {
				required[parentInput] = struct{}{}
			}
		}
	}

	ids := make([]string, 0, len(required))
	for id := range required {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func normalizeASTRAInputs(inputs []felt.ASTRAInput) []felt.ASTRAInput {
	if len(inputs) == 0 {
		return nil
	}
	normalized := make([]felt.ASTRAInput, 0, len(inputs))
	for _, input := range inputs {
		cloned := input
		cloned.From = normalizeParentRef(cloned.From)
		normalized = append(normalized, cloned)
	}
	return normalized
}

func normalizeParentRef(ref string) string {
	if !strings.HasPrefix(ref, "parent.") {
		return ref
	}
	trimmed := strings.TrimPrefix(ref, "parent.")
	if trimmed == "" {
		return ref
	}
	return "../" + trimmed
}

func parentInputID(ref string) (string, bool) {
	if ref == "" {
		return "", false
	}
	if strings.HasPrefix(ref, "../") {
		ref = strings.TrimPrefix(ref, "../")
	}
	if ref == "" || strings.Contains(ref, ".") {
		return "", false
	}
	return ref, true
}

func buildStructuralInputs(required []string) []felt.ASTRAInput {
	if len(required) == 0 {
		return []felt.ASTRAInput{{
			ID:          structuralInputID,
			Type:        "data",
			Description: "Synthetic context input for a structural felt analysis node.",
		}}
	}

	inputs := make([]felt.ASTRAInput, 0, len(required))
	for _, id := range required {
		inputs = append(inputs, felt.ASTRAInput{
			ID:          id,
			Type:        "data",
			Description: "Synthesized from child input references during felt ASTRA export.",
		})
	}
	return inputs
}

func buildStructuralOutputs(existing []felt.ASTRAOutput) []felt.ASTRAOutput {
	if len(existing) > 0 {
		return existing
	}
	return []felt.ASTRAOutput{{
		ID:          structuralOutputID,
		Type:        "report",
		Description: "Synthetic report output for a structural felt analysis node.",
	}}
}

func readMystProjectTitle(projectRoot string) (string, error) {
	data, err := os.ReadFile(filepath.Join(projectRoot, felt.DirName, felt.MystConfigName))
	if err != nil {
		if os.IsNotExist(err) {
			base := filepath.Base(projectRoot)
			if base == "" || base == "." || base == string(filepath.Separator) {
				return defaultProjectTitle, nil
			}
			return base, nil
		}
		return "", fmt.Errorf("read myst.yml: %w", err)
	}

	var cfg struct {
		Project struct {
			Title string `yaml:"title"`
		} `yaml:"project"`
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("parse myst.yml: %w", err)
	}
	if title := strings.TrimSpace(cfg.Project.Title); title != "" {
		return title, nil
	}
	base := filepath.Base(projectRoot)
	if base == "" || base == "." || base == string(filepath.Separator) {
		return defaultProjectTitle, nil
	}
	return base, nil
}

func hasASTRAExportContent(f *felt.Felt) bool {
	return len(f.Inputs) > 0 ||
		len(f.Outputs) > 0 ||
		len(f.Decisions) > 0 ||
		len(f.Insights) > 0 ||
		len(f.SuccessCriteria) > 0
}

func mapsClone[T any](in map[string]T) map[string]T {
	out := make(map[string]T, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
