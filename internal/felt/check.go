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

// Check inspects fibers for substrate problems in the relationship model:
// broken narrative/data-flow references plus repository layout/legacy issues.
func Check(felts []*Felt) []CheckIssue {
	issues := checkNativeMetadata(felts)
	issues = append(issues, checkRelationshipIntegrity(felts)...)

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

func checkNativeMetadata(felts []*Felt) []CheckIssue {
	var issues []CheckIssue
	for _, f := range felts {
		if strings.TrimSpace(f.Name) == "" {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    "frontmatter.name",
				Message: "name cannot be empty",
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
			if strings.TrimSpace(ref.Fragment) != "" && !hasFrontmatterElement(byID[targetID], ref.Fragment) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "body",
					Message: fmt.Sprintf("broken body reference %q: target has no element %q", ref.String(), ref.Fragment),
				})
			}
		}
		for _, input := range f.DataFlowInputs() {
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
					Path:    "inputs." + input.InputID + ".from",
					Message: message,
				})
				continue
			}
			if strings.TrimSpace(fragment) != "" && !hasOutput(byID[targetID], fragment) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: f.ID,
					Path:    "inputs." + input.InputID + ".from",
					Message: fmt.Sprintf("broken data-flow reference %q: target has no output %q", input.From, fragment),
				})
			}
		}
	}
	return issues
}

func hasFrontmatterElement(f *Felt, id string) bool {
	id = strings.TrimSpace(id)
	if f == nil || id == "" {
		return false
	}
	return f.HasFrontmatterFragment(id)
}

func hasOutput(f *Felt, id string) bool {
	id = strings.TrimSpace(id)
	if f == nil || id == "" {
		return false
	}
	return f.HasDataFlowOutput(id)
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
