package felt

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	CheckLevelError   = "error"
	CheckLevelWarning = "warning"
	CheckLevelInfo    = "info"
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
//
// external comes from Storage.ExternalRefs and is nil for a top-level store.
// It is what keeps a link into the enclosing store — healthy, just outside
// this view — from being reported as broken.
func Check(felts []*Felt, external *ExternalRefs) []CheckIssue {
	issues := checkNativeMetadata(felts)
	issues = append(issues, checkRelationshipIntegrity(felts, external)...)
	issues = append(issues, checkDependsOn(felts, external)...)

	sortIssues(issues)
	return issues
}

// checkNativeMetadata validates felt-owned frontmatter fields; currently only
// that name is non-empty.
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
		if name == LegacyMystConfigName || !strings.HasSuffix(name, FileExt) {
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

	sortIssues(issues)
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
		frontmatter, body, err := SplitFrontmatter(data, true)
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

	sortIssues(issues)
	return issues, nil
}

func checkRelationshipIntegrity(felts []*Felt, external *ExternalRefs) []CheckIssue {
	ids := make([]string, 0, len(felts))
	byID := make(map[string]*Felt, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
		byID[f.ID] = f
	}
	sort.Strings(ids)

	var issues []CheckIssue
	resolver := newScopedIDResolverIn(ids, external)
	_ = iterRefsResolved(felts, resolver, func(r resolvedRef) error {
		// A reference that resolves to a fiber in the enclosing store is not
		// broken — this store simply cannot see it. Silence, not an issue,
		// EXCEPT where an INFERRED external hit shadowed a local basename
		// rescue: the reader loses a repair that used to fire, and that loss
		// should be visible rather than silent. A link written out in full
		// from the enclosing store's root is not that case — it is someone
		// naming the fiber they meant, and it gets the same silence a healthy
		// local link gets, local twin or no.
		if errors.Is(r.ResolveErr, ErrExternalReference) {
			if ref, ok := AsExternalReference(r.ResolveErr); ok && ref.Inferred {
				if local := resolver.byBase[path.Base(cleanLookupQuery(r.RawTarget))]; len(local) == 1 {
					issues = append(issues, CheckIssue{
						Level:   CheckLevelInfo,
						FiberID: r.Source.ID,
						Path:    "body",
						Message: fmt.Sprintf("reference %q resolves to %s in the enclosing store, shadowing a local basename rescue to %s", r.Label, ref.ID, local[0]),
					})
				}
			}
			return nil
		}
		if r.Kind == refKindReference {
			path := "body"
			if r.ResolveErr != nil {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: r.Source.ID,
					Path:    path,
					Message: fmt.Sprintf("broken body reference %q", r.Label),
				})
				return nil
			}
			if strings.TrimSpace(r.Fragment) != "" && !hasFrontmatterElement(byID[r.ResolvedID], r.Fragment) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelError,
					FiberID: r.Source.ID,
					Path:    path,
					Message: fmt.Sprintf("broken body reference %q: target has no element %q", r.Label, r.Fragment),
				})
			}
			return nil
		}
		// data-flow reference
		path := "inputs." + r.InputID + ".from"
		if r.ResolveErr != nil {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: r.Source.ID,
				Path:    path,
				Message: fmt.Sprintf("broken data-flow reference %q", r.Label),
			})
			return nil
		}
		if strings.TrimSpace(r.Fragment) != "" && !hasOutput(byID[r.ResolvedID], r.Fragment) {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: r.Source.ID,
				Path:    path,
				Message: fmt.Sprintf("broken data-flow reference %q: target has no output %q", r.Label, r.Fragment),
			})
		}
		return nil
	})
	return issues
}

// checkDependsOn validates the project-owned `depends_on` frontmatter field:
// every fiber id it names must resolve to a fiber in the store (or, quietly,
// into the enclosing store — same rule as body/data-flow references), and
// every entry must have one of the shapes ALL THREE readers accept — this
// checker, the Elixir poller (lib/shuttle/poller.ex normalize_deps/1 +
// dep_id/1) and the board's TS parser (ui/src/board/KanbanFiber.ts):
//
//	depends_on: some/fiber      a bare scalar id
//	depends_on: [a, b]          a list of ids
//	depends_on: [{id: a}]       a list of {id: <fiber-id>} maps
//
// and nothing else. An empty `depends_on:` (null) is absence, not a
// dependency. Anything outside the grammar is reported as malformed rather
// than silently ignored, since the poller would treat it as an unsatisfiable
// dependency and the fiber would never dispatch.
func checkDependsOn(felts []*Felt, external *ExternalRefs) []CheckIssue {
	ids := make([]string, 0, len(felts))
	byUID := make(map[string]*Felt, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
		if f.UID != "" {
			byUID[strings.ToLower(f.UID)] = f
		}
	}
	resolver := newScopedIDResolverIn(ids, external)

	var issues []CheckIssue
	for _, f := range felts {
		node := extraFieldNode(f.ExtraFields, "depends_on")
		if node == nil {
			continue
		}
		refs, malformed := dependsOnEntries(node)
		for _, m := range malformed {
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    "frontmatter.depends_on",
				Message: fmt.Sprintf("malformed depends_on entry: %s", m),
			})
		}
		for _, ref := range refs {
			if dependsOnRefResolves(resolver, byUID, f.ID, ref) {
				continue
			}
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: f.ID,
				Path:    "frontmatter.depends_on",
				Message: fmt.Sprintf("dangling depends_on reference %q", ref),
			})
		}
	}
	return issues
}

// dependsOnEntries extracts candidate fiber-id strings from a depends_on
// node, per the grammar on checkDependsOn: a bare string scalar, or a
// sequence whose items are each a bare string scalar or a mapping with a
// string "id" key. Null is absence. Anything else — a non-string scalar, a
// TOP-LEVEL mapping, a sequence item that is neither a scalar nor an "id"
// mapping, a mapping entry missing "id" or with a non-string "id" — is
// reported back as malformed instead of silently dropped.
func dependsOnEntries(node *yaml.Node) (refs []string, malformed []string) {
	switch node.Kind {
	case yaml.ScalarNode:
		if node.Tag == "!!null" {
			// `depends_on:` with nothing after it is ABSENCE, not a
			// dependency — a blank line is not a claim about ordering. Both
			// other readers agree: the poller normalizes nil to no deps and
			// the board's parser ignores it, so complaining here would be the
			// checker inventing a rule of its own.
			return nil, nil
		}
		if node.Tag == "!!str" {
			refs = append(refs, node.Value)
		} else {
			malformed = append(malformed, fmt.Sprintf("depends_on must be a fiber id, id list, or {id: ...} entries, got %q", node.Value))
		}
	case yaml.SequenceNode:
		for i, item := range node.Content {
			if item == nil {
				continue
			}
			switch item.Kind {
			case yaml.ScalarNode:
				if item.Tag == "!!str" {
					refs = append(refs, item.Value)
				} else {
					malformed = append(malformed, fmt.Sprintf("entry %d is not a fiber id: %q", i, item.Value))
				}
			case yaml.MappingNode:
				idNode := mappingValueNode(item, "id")
				if idNode == nil || idNode.Kind != yaml.ScalarNode || idNode.Tag != "!!str" || strings.TrimSpace(idNode.Value) == "" {
					malformed = append(malformed, fmt.Sprintf("entry %d has no string \"id\" key", i))
					continue
				}
				refs = append(refs, idNode.Value)
			default:
				malformed = append(malformed, fmt.Sprintf("entry %d is neither a fiber id nor an {id: ...} mapping", i))
			}
		}
	// NOTE the shape that is NOT here: a TOP-LEVEL `depends_on: {id: …}`. It
	// looks reasonable and no reader honors it — the board's parser ignores a
	// bare mapping, and the poller iterates it as {key, value} tuples that
	// `dep_id/1` answers nil for, so the fiber is gated forever with nothing
	// on screen to say why. Blessing it here was the checker promising a
	// contract the runtime does not keep; it is malformed, and the default
	// branch says so.
	default:
		malformed = append(malformed, "depends_on must be a fiber id, id list, or {id: ...} entries")
	}
	return refs, malformed
}

// dependsOnRefResolves reports whether ref names a fiber this store (or its
// enclosing store) can see. It reuses the same scoped-id resolution `felt
// show` and body-reference checking use — path ids, slugs, and basename
// rescue all apply — plus an exact-UID fallback for the ULID-shaped id form,
// since depends_on may name a fiber by its intrinsic uid rather than its
// path/slug.
func dependsOnRefResolves(resolver *scopedIDResolver, byUID map[string]*Felt, scopeID, ref string) bool {
	if _, err := resolver.Resolve(scopeID, ref); err == nil {
		return true
	} else if errors.Is(err, ErrExternalReference) {
		// Same silence as a body reference resolving into the enclosing
		// store: not visible here, but not broken.
		return true
	}
	if LooksLikeUID(ref) {
		_, ok := byUID[strings.ToLower(ref)]
		return ok
	}
	return false
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

// CheckParseability reports fibers that exist on disk but cannot be read into
// the assemblage — almost always malformed YAML frontmatter (an unquoted
// scalar containing ": " is the classic: YAML reads it as a nested mapping and
// the whole file stops parsing).
//
// This is the one failure the rest of the walk deliberately swallows.
// Storage.listWithMode warns on stderr and skips, which is right for `ls` and
// `show` — one broken file must not take down every other fiber — but it means
// a fiber can drop out of the store entirely and stay dropped. felt's own
// write path quotes correctly, so these files come from agents hand-editing
// frontmatter, which is the documented workflow for multi-line outcomes;
// nothing else validates that editing afterwards. `check` is where the
// swallowed failure gets a voice, and it outranks every other issue: a broken
// wikilink is cosmetic next to a fiber that has silently ceased to exist.
func CheckParseability(s *Storage) ([]CheckIssue, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	var issues []CheckIssue
	for _, file := range files {
		if _, err := s.readPathWithMode(file.path, file.id, ParseFull); err != nil {
			// An iCloud-dataless file is not malformed — the bytes simply
			// aren't here yet. Same symptom (invisible fiber), different fix,
			// and it isn't the store's fault, so it lands as a warning.
			if isEvictedFileError(err) {
				issues = append(issues, CheckIssue{
					Level:   CheckLevelWarning,
					FiberID: file.id,
					Path:    file.path,
					Message: "not materialized (iCloud) — run `brctl download` or open it in Files to hydrate",
				})
				continue
			}
			issues = append(issues, CheckIssue{
				Level:   CheckLevelError,
				FiberID: file.id,
				Path:    file.path,
				Message: fmt.Sprintf("unparseable, so invisible to every felt command until it is fixed: %s", parseFailureDetail(file.path, err)),
			})
		}
	}

	sortIssues(issues)
	return issues, nil
}

// parseFailureDetail strips the "reading file <path>: " wrapper Storage adds to
// I/O failures, since CheckIssue already carries the path — repeating it once
// per issue buries the part the reader needs (the YAML line and reason).
func parseFailureDetail(path string, err error) string {
	return strings.TrimPrefix(err.Error(), fmt.Sprintf("reading file %s: ", path))
}

// sortIssues gives every check a single stable ordering. Path and Level are
// constant within the checks that never set them, so the wider key sequence
// leaves their output unchanged.
func sortIssues(issues []CheckIssue) {
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
}
