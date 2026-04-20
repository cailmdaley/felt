package felt

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const (
	CheckLevelError = "error"
	CheckLevelWarn  = "warn"
)

type CheckIssue struct {
	Level   string `json:"level"`
	FiberID string `json:"fiber_id"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

func (i CheckIssue) String() string {
	location := i.FiberID
	if i.Path != "" {
		location += " " + i.Path
	}
	return fmt.Sprintf("%s: %s: %s", strings.ToUpper(i.Level), location, i.Message)
}

// Check inspects fibers for quality problems in the current relationship model:
// malformed ASTRA structure, broken narrative/data-flow references, and
// suspicious formalization gaps.
func Check(felts []*Felt) []CheckIssue {
	var issues []CheckIssue
	issues = append(issues, checkRelationshipIntegrity(felts)...)
	for _, f := range felts {
		issues = append(issues, checkDecisions(f)...)
		issues = append(issues, checkInsights(f)...)
	}
	issues = append(issues, checkSiblingDepthConsistency(felts)...)

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].FiberID != issues[j].FiberID {
			return issues[i].FiberID < issues[j].FiberID
		}
		if issues[i].Path != issues[j].Path {
			return issues[i].Path < issues[j].Path
		}
		if issues[i].Level != issues[j].Level {
			return issues[i].Level < issues[j].Level
		}
		return issues[i].Message < issues[j].Message
	})
	return issues
}

func checkDecisions(f *Felt) []CheckIssue {
	var issues []CheckIssue
	for id, decision := range f.Decisions {
		path := "decisions." + id
		if len(decision.Options) == 0 {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    path,
				Message: "decision has no options",
			})
		}
		if len(decision.Options) > 0 {
			hasUnexcluded := false
			for _, option := range decision.Options {
				if !option.Excluded {
					hasUnexcluded = true
					break
				}
			}
			if !hasUnexcluded {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelWarn,
					FiberID: f.ID,
					Path:    path,
					Message: "decision has no remaining unexcluded options",
				})
			}
		}

		if !f.IsClosed() {
			continue
		}
		if strings.TrimSpace(decision.Default) == "" {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    path,
				Message: "closed fiber has decision with no selected option",
			})
			continue
		}

		option, ok := decision.Options[decision.Default]
		if !ok {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    path,
				Message: fmt.Sprintf("default %q is not defined in options", decision.Default),
			})
			continue
		}
		if option.Excluded {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    path,
				Message: fmt.Sprintf("default %q selects an excluded option", decision.Default),
			})
		}
	}
	return issues
}

// CheckStructure inspects the .felt/ layout for structural problems:
// slug collisions between bare (<slug>.md) and nested (<slug>/<slug>.md)
// fiber forms, and multiple bare .md files at .felt/ root (which would mean
// .felt/ itself does not have a single entry-point fiber).
func CheckStructure(s *Storage) ([]CheckIssue, error) {
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("reading .felt directory: %w", err)
	}

	var bareSlugs []string
	bareSet := map[string]struct{}{}
	nestedSet := map[string]struct{}{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			nestedPath := filepath.Join(root, name, name+FileExt)
			if info, err := os.Stat(nestedPath); err == nil && !info.IsDir() {
				nestedSet[name] = struct{}{}
			}
			continue
		}
		if name == MystConfigName || !strings.HasSuffix(name, FileExt) {
			continue
		}
		slug := strings.TrimSuffix(name, FileExt)
		bareSlugs = append(bareSlugs, slug)
		bareSet[slug] = struct{}{}
	}

	var issues []CheckIssue
	if len(bareSlugs) > 1 {
		sort.Strings(bareSlugs)
		issues = append(issues, CheckIssue{
			Level:   CheckLevelError,
			FiberID: ".",
			Message: fmt.Sprintf("multiple bare fiber files at .felt/ root: %s — at most one (the entry-point fiber) is allowed", strings.Join(bareSlugs, ", ")),
		})
	}
	for slug := range bareSet {
		if _, nested := nestedSet[slug]; nested {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: slug,
				Message: fmt.Sprintf("slug collision: both bare .felt/%s.md and nested .felt/%s/%s.md exist", slug, slug, slug),
			})
		}
	}

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].FiberID != issues[j].FiberID {
			return issues[i].FiberID < issues[j].FiberID
		}
		return issues[i].Message < issues[j].Message
	})
	return issues, nil
}

// CheckLegacyFormat inspects raw fiber files for storage-model residue that
// should be eliminated by the relationship-model migration.
func CheckLegacyFormat(s *Storage) ([]CheckIssue, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	var issues []CheckIssue
	for _, file := range files {
		data, err := os.ReadFile(file.path)
		if err != nil {
			return nil, fmt.Errorf("reading fiber %s: %w", file.path, err)
		}
		frontmatter, body, err := splitFrontmatter(data, true)
		if err != nil {
			continue
		}
		_, renamedTitle, removedDependsOn, err := normalizeLegacyFrontmatter(frontmatter)
		if err != nil {
			continue
		}
		if renamedTitle {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: file.id,
				Path:    "frontmatter",
				Message: `legacy frontmatter key "title" should be renamed to "name"`,
			})
		}
		if removedDependsOn {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: file.id,
				Path:    "frontmatter",
				Message: `legacy frontmatter key "depends-on" should be removed`,
			})
		}
		if _, strippedAnchor := stripLegacyMystAnchor(file.id, body); strippedAnchor {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: file.id,
				Path:    "body",
				Message: "legacy MyST anchor should be removed",
			})
		}
	}

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].FiberID != issues[j].FiberID {
			return issues[i].FiberID < issues[j].FiberID
		}
		if issues[i].Path != issues[j].Path {
			return issues[i].Path < issues[j].Path
		}
		return issues[i].Message < issues[j].Message
	})
	return issues, nil
}

func checkInsights(f *Felt) []CheckIssue {
	var issues []CheckIssue
	for id, insight := range f.Insights {
		if len(insight.Evidence) == 0 {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelWarn,
				FiberID: f.ID,
				Path:    "insights." + id,
				Message: "insight has no evidence",
			})
		}
		for idx, evidence := range insight.Evidence {
			if evidenceLooksStubby(evidence) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    fmt.Sprintf("insights.%s.evidence[%d]", id, idx),
					Message: "evidence stub has no description or anchor details",
				})
			}
		}
	}
	return issues
}

func checkRelationshipIntegrity(felts []*Felt) []CheckIssue {
	ids := make([]string, 0, len(felts))
	byID := make(map[string]*Felt, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
		byID[f.ID] = f
	}
	sort.Strings(ids)

	var issues []CheckIssue
	for _, f := range felts {
		for _, ref := range ExtractBodyRefs(f.Body) {
			targetID, err := ResolveScopedID(ids, f.ID, ref.Target)
			if err != nil {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "body",
					Message: fmt.Sprintf("broken body reference %q", ref.String()),
				})
				continue
			}
			if strings.TrimSpace(ref.Fragment) != "" && !hasASTRAElement(byID[targetID], ref.Fragment) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "body",
					Message: fmt.Sprintf("broken body reference %q: target has no element %q", ref.String(), ref.Fragment),
				})
			}
		}
		for _, input := range f.Inputs {
			targetFiber, fragment := splitDataFlowRef(input.From)
			if targetFiber == "" {
				continue
			}
			targetID, err := ResolveScopedID(ids, f.ID, targetFiber)
			if err != nil {
				message := fmt.Sprintf("broken data-flow reference %q", input.From)
				if strings.TrimSpace(fragment) == "" {
					message = fmt.Sprintf("broken data-flow reference %q", targetFiber)
				}
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "inputs." + input.ID + ".from",
					Message: message,
				})
				continue
			}
			if strings.TrimSpace(fragment) != "" && !hasOutput(byID[targetID], fragment) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "inputs." + input.ID + ".from",
					Message: fmt.Sprintf("broken data-flow reference %q: target has no output %q", input.From, fragment),
				})
			}
		}
	}
	return issues
}

func hasASTRAElement(f *Felt, id string) bool {
	id = strings.TrimSpace(id)
	if f == nil || id == "" {
		return false
	}
	if _, ok := f.Decisions[id]; ok {
		return true
	}
	if _, ok := f.Insights[id]; ok {
		return true
	}
	for _, input := range f.Inputs {
		if input.ID == id {
			return true
		}
	}
	for _, output := range f.Outputs {
		if output.ID == id {
			return true
		}
	}
	return false
}

func hasOutput(f *Felt, id string) bool {
	id = strings.TrimSpace(id)
	if f == nil || id == "" {
		return false
	}
	for _, output := range f.Outputs {
		if output.ID == id {
			return true
		}
	}
	return false
}

func evidenceLooksStubby(e ASTRAEvidence) bool {
	if strings.TrimSpace(e.Description) != "" {
		return false
	}
	if e.Quote != nil || e.Figure != nil || e.Table != nil || e.Location != nil {
		return false
	}
	if strings.TrimSpace(e.DOI) != "" || strings.TrimSpace(e.Artifact) != "" {
		return false
	}
	if e.Document != nil && (strings.TrimSpace(e.Document.Path) != "" || strings.TrimSpace(e.Document.Commit) != "") {
		return false
	}
	if e.Version != nil || strings.TrimSpace(e.Checksum) != "" || strings.TrimSpace(e.Snapshot) != "" || strings.TrimSpace(e.SourceCommit) != "" {
		return false
	}
	return true
}

func checkSiblingDepthConsistency(felts []*Felt) []CheckIssue {
	groups := map[string][]*Felt{}
	for _, f := range felts {
		groups[parentPath(f.ID)] = append(groups[parentPath(f.ID)], f)
	}

	var issues []CheckIssue
	for parent, siblings := range groups {
		if parent == "" || len(siblings) < 2 {
			continue
		}

		minDepth := 1 << 30
		maxDepth := -1
		depthGroups := map[int][]string{}
		nonZero := 0

		for _, sibling := range siblings {
			depth := formalizationDepth(sibling)
			if depth > 0 {
				nonZero++
			}
			if depth < minDepth {
				minDepth = depth
			}
			if depth > maxDepth {
				maxDepth = depth
			}
			depthGroups[depth] = append(depthGroups[depth], sibling.ID)
		}

		if nonZero < 2 || maxDepth-minDepth < 2 {
			continue
		}

		var summaries []string
		for depth, ids := range depthGroups {
			sort.Strings(ids)
			summaries = append(summaries, fmt.Sprintf("depth %d: %s", depth, strings.Join(ids, ", ")))
		}
		sort.Strings(summaries)

		scope := parent
		if scope == "" {
			scope = "."
		}
		issues = append(issues, CheckIssue{
			Level:   CheckLevelWarn,
			FiberID: scope,
			Message: "siblings have inconsistent ASTRA formalization depth: " + strings.Join(summaries, "; "),
		})
	}

	return issues
}

func formalizationDepth(f *Felt) int {
	depth := 0
	if len(f.Inputs) > 0 || len(f.Outputs) > 0 || len(f.Decisions) > 0 || len(f.Insights) > 0 || len(f.SuccessCriteria) > 0 {
		depth = 1
	}

	for _, input := range f.Inputs {
		if strings.TrimSpace(input.From) != "" || strings.TrimSpace(input.Description) != "" || strings.TrimSpace(input.Source) != "" {
			if depth < 2 {
				depth = 2
			}
		}
	}
	for _, output := range f.Outputs {
		if strings.TrimSpace(output.Description) != "" || output.Recipe != nil {
			if depth < 2 {
				depth = 2
			}
		}
	}
	for _, decision := range f.Decisions {
		if len(decision.Options) > 0 || strings.TrimSpace(decision.Default) != "" {
			if depth < 2 {
				depth = 2
			}
		}
		for _, option := range decision.Options {
			if option.Excluded || strings.TrimSpace(option.ExcludedReason) != "" || strings.TrimSpace(option.Description) != "" {
				if depth < 3 {
					depth = 3
				}
			}
		}
	}
	for _, insight := range f.Insights {
		if len(insight.Evidence) > 0 || strings.TrimSpace(insight.Scope) != "" || len(insight.Tags) > 0 || strings.TrimSpace(insight.Notes) != "" {
			if depth < 2 {
				depth = 2
			}
		}
		for _, evidence := range insight.Evidence {
			if !evidenceLooksStubby(evidence) {
				if depth < 3 {
					depth = 3
				}
			}
		}
	}

	return depth
}

func parentPath(id string) string {
	clean := path.Clean(id)
	if clean == "." {
		return ""
	}
	parent := path.Dir(clean)
	if parent == "." {
		return ""
	}
	return parent
}
