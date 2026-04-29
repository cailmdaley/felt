// Package felt provides the core data structures and operations for the felt task tracker.
package felt

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

// ParseMode controls how much of a fiber file gets parsed.
type ParseMode int

const (
	ParseMetadataOnly ParseMode = iota
	ParseFull
)

// Status constants
const (
	StatusOpen   = "open"
	StatusActive = "active"
	StatusClosed = "closed"
)

// GraphEdge represents a directed edge in the in-memory relationship graph.
type GraphEdge struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// GraphEdges is a slice of graph edges with helper methods.
type GraphEdges []GraphEdge

// IDs returns just the edge target IDs.
func (deps GraphEdges) IDs() []string {
	ids := make([]string, len(deps))
	for i, d := range deps {
		ids[i] = d.ID
	}
	return ids
}

// HasID returns true if the given ID is in the edge set.
func (deps GraphEdges) HasID(id string) bool {
	for _, d := range deps {
		if d.ID == id {
			return true
		}
	}
	return false
}

// LabelFor returns the label for a given target ID, or empty string.
func (deps GraphEdges) LabelFor(id string) string {
	for _, d := range deps {
		if d.ID == id {
			return d.Label
		}
	}
	return ""
}

type ASTRAInput struct {
	ID          string `yaml:"id" json:"id"`
	Type        string `yaml:"type,omitempty" json:"type,omitempty"`
	From        string `yaml:"from,omitempty" json:"from,omitempty"`
	Source      string `yaml:"source,omitempty" json:"source,omitempty"`
	Checksum    string `yaml:"checksum,omitempty" json:"checksum,omitempty"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
}

type ASTRARecipe struct {
	Command   string         `yaml:"command,omitempty" json:"command,omitempty"`
	Resources map[string]any `yaml:"resources,omitempty" json:"resources,omitempty"`
}

type ASTRAOutput struct {
	ID          string       `yaml:"id" json:"id"`
	Type        string       `yaml:"type,omitempty" json:"type,omitempty"`
	Description string       `yaml:"description,omitempty" json:"description,omitempty"`
	Recipe      *ASTRARecipe `yaml:"recipe,omitempty" json:"recipe,omitempty"`
}

type ASTRADecisionOption struct {
	Label          string `yaml:"label,omitempty" json:"label,omitempty"`
	Description    string `yaml:"description,omitempty" json:"description,omitempty"`
	Excluded       bool   `yaml:"excluded,omitempty" json:"excluded,omitempty"`
	ExcludedReason string `yaml:"excluded_reason,omitempty" json:"excluded_reason,omitempty"`
}

type ASTRADecision struct {
	Label     string                         `yaml:"label,omitempty" json:"label,omitempty"`
	Rationale string                         `yaml:"rationale,omitempty" json:"rationale,omitempty"`
	Default   string                         `yaml:"default,omitempty" json:"default,omitempty"`
	Options   map[string]ASTRADecisionOption `yaml:"options,omitempty" json:"options,omitempty"`
}

type ASTRAQuote struct {
	Type   string `yaml:"type,omitempty" json:"type,omitempty"`
	Exact  string `yaml:"exact,omitempty" json:"exact,omitempty"`
	Prefix string `yaml:"prefix,omitempty" json:"prefix,omitempty"`
	Suffix string `yaml:"suffix,omitempty" json:"suffix,omitempty"`
}

type ASTRAFigure struct {
	Type    string `yaml:"type,omitempty" json:"type,omitempty"`
	Label   string `yaml:"label,omitempty" json:"label,omitempty"`
	Caption string `yaml:"caption,omitempty" json:"caption,omitempty"`
}

type ASTRATable struct {
	Type    string `yaml:"type,omitempty" json:"type,omitempty"`
	Label   string `yaml:"label,omitempty" json:"label,omitempty"`
	Caption string `yaml:"caption,omitempty" json:"caption,omitempty"`
	Region  string `yaml:"region,omitempty" json:"region,omitempty"`
}

type ASTRAFragment struct {
	Type       string `yaml:"type,omitempty" json:"type,omitempty"`
	ConformsTo string `yaml:"conformsTo,omitempty" json:"conformsTo,omitempty"`
	Value      string `yaml:"value,omitempty" json:"value,omitempty"`
	Page       *int   `yaml:"page,omitempty" json:"page,omitempty"`
	Start      *int   `yaml:"start,omitempty" json:"start,omitempty"`
	End        *int   `yaml:"end,omitempty" json:"end,omitempty"`
}

type ASTRADocument struct {
	Path   string `yaml:"path,omitempty" json:"path,omitempty"`
	Commit string `yaml:"commit,omitempty" json:"commit,omitempty"`
}

type ASTRAEvidence struct {
	ID           string         `yaml:"id,omitempty" json:"id,omitempty"`
	DOI          string         `yaml:"doi,omitempty" json:"doi,omitempty"`
	Artifact     string         `yaml:"artifact,omitempty" json:"artifact,omitempty"`
	Description  string         `yaml:"description,omitempty" json:"description,omitempty"`
	Document     *ASTRADocument `yaml:"document,omitempty" json:"document,omitempty"`
	Version      *int           `yaml:"version,omitempty" json:"version,omitempty"`
	Checksum     string         `yaml:"checksum,omitempty" json:"checksum,omitempty"`
	Snapshot     string         `yaml:"snapshot,omitempty" json:"snapshot,omitempty"`
	SourceCommit string         `yaml:"source_commit,omitempty" json:"source_commit,omitempty"`
	Quote        *ASTRAQuote    `yaml:"quote,omitempty" json:"quote,omitempty"`
	Figure       *ASTRAFigure   `yaml:"figure,omitempty" json:"figure,omitempty"`
	Table        *ASTRATable    `yaml:"table,omitempty" json:"table,omitempty"`
	Location     *ASTRAFragment `yaml:"location,omitempty" json:"location,omitempty"`
}

type ASTRAInsight struct {
	Claim     string          `yaml:"claim,omitempty" json:"claim,omitempty"`
	CreatedAt *time.Time      `yaml:"created_at,omitempty" json:"created_at,omitempty"`
	Derived   bool            `yaml:"derived,omitempty" json:"derived,omitempty"`
	Scope     string          `yaml:"scope,omitempty" json:"scope,omitempty"`
	Tags      []string        `yaml:"tags,omitempty" json:"tags,omitempty"`
	Notes     string          `yaml:"notes,omitempty" json:"notes,omitempty"`
	Evidence  []ASTRAEvidence `yaml:"evidence,omitempty" json:"evidence,omitempty"`
}

type ASTRASuccessCriterion struct {
	Claim     string `yaml:"claim,omitempty" json:"claim,omitempty"`
	Output    string `yaml:"output,omitempty" json:"output,omitempty"`
	Condition string `yaml:"condition,omitempty" json:"condition,omitempty"`
}

type BodyRef struct {
	Target   string `json:"target"`
	Fragment string `json:"fragment,omitempty"`
}

// Felt represents a single fiber.
type Felt struct {
	ID              string                   `yaml:"-" json:"id"`
	Name            string                   `yaml:"name" json:"name"`
	Status          string                   `yaml:"status,omitempty" json:"status,omitempty"`
	Tags            []string                 `yaml:"tags,omitempty" json:"tags,omitempty"`
	CreatedAt       time.Time                `yaml:"created-at" json:"created_at"`
	ClosedAt        *time.Time               `yaml:"closed-at,omitempty" json:"closed_at,omitempty"`
	Outcome         string                   `yaml:"outcome,omitempty" json:"outcome,omitempty"`
	Due             *time.Time               `yaml:"due,omitempty" json:"due,omitempty"`
	Description     string                   `yaml:"description,omitempty" json:"description,omitempty"`
	Inputs          []ASTRAInput             `yaml:"inputs,omitempty" json:"inputs,omitempty"`
	Outputs         []ASTRAOutput            `yaml:"outputs,omitempty" json:"outputs,omitempty"`
	Decisions       map[string]ASTRADecision `yaml:"decisions,omitempty" json:"decisions,omitempty"`
	Insights        map[string]ASTRAInsight  `yaml:"insights,omitempty" json:"insights,omitempty"`
	SuccessCriteria []ASTRASuccessCriterion  `yaml:"success_criteria,omitempty" json:"success_criteria,omitempty"`
	Container       string                   `yaml:"container,omitempty" json:"container,omitempty"`
	Body            string                   `yaml:"-" json:"body,omitempty"`
	ModifiedAt      time.Time                `yaml:"-" json:"modified_at,omitempty"` // populated from file stat
	// EntryPoint is true when the fiber lives as a bare `.felt/<slug>.md`
	// at the .felt/ root (the project's entry-point / root fiber, as it
	// appears through loom symlinks). Distinguishes the root from top-level
	// folder fibers — both have unslashed IDs, only EntryPoint tells them apart.
	EntryPoint bool `yaml:"-" json:"entry_point,omitempty"`
}

// HasStatus returns true if the fiber has opt-in status tracking.
func (f *Felt) HasStatus() bool {
	return f.Status != ""
}

// New creates a new Felt from a slug and name.
// The slug is slugified silently if it contains spaces or uppercase.
// Fibers have no status by default — status is opt-in for tracked work.
func New(slug string, name string) (*Felt, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, fmt.Errorf("slug cannot be empty")
	}

	id := SlugifyPath(slug)
	if id == "" {
		return nil, fmt.Errorf("slug must contain at least one alphanumeric character")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("name cannot be empty")
	}

	return &Felt{
		ID:        id,
		Name:      name,
		CreatedAt: time.Now(),
	}, nil
}

// GenerateID creates a slug-based ID from a title string.
// Used by migration and legacy paths that derive slugs from titles.
func GenerateID(title string) (string, error) {
	slug := Slugify(title)
	if len(slug) > 32 {
		// Truncate at word boundary
		slug = truncateAtWord(slug, 32)
	}

	if slug == "" {
		return "", fmt.Errorf("title must contain at least one alphanumeric character")
	}
	return slug, nil
}

// SlugifyPath handles slash-separated paths: prefix segments are directory names
// kept as-is (must match existing directories), only the final segment is slugified.
// This lets "felt add pure_eb/my-fiber" work without mangling "pure_eb".
func SlugifyPath(s string) string {
	idx := strings.LastIndex(s, "/")
	if idx < 0 {
		return Slugify(s)
	}
	prefix := s[:idx]
	slug := Slugify(s[idx+1:])
	if slug == "" {
		return ""
	}
	return prefix + "/" + slug
}

// Slugify converts a string to a URL-safe slug.
func Slugify(s string) string {
	// Strip bracketed tags like [loom], [pure-eb], [thread:X]
	s = stripBracketedTags(s)
	s = strings.ToLower(s)

	// Replace non-alphanumeric with hyphens
	var result strings.Builder
	prevHyphen := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			result.WriteRune(r)
			prevHyphen = false
		} else if !prevHyphen {
			result.WriteRune('-')
			prevHyphen = true
		}
	}

	// Trim leading/trailing hyphens
	return strings.Trim(result.String(), "-")
}

// stripBracketedTags removes [tag] patterns from a string.
func stripBracketedTags(s string) string {
	result := s
	for {
		start := strings.Index(result, "[")
		if start == -1 {
			break
		}
		end := strings.Index(result[start:], "]")
		if end == -1 {
			break
		}
		result = result[:start] + result[start+end+1:]
	}
	return strings.TrimSpace(result)
}

// truncateAtWord truncates s to at most maxLen, breaking at word boundary.
func truncateAtWord(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}

	// Find last hyphen before maxLen
	lastHyphen := strings.LastIndex(s[:maxLen], "-")
	if lastHyphen > 0 {
		return s[:lastHyphen]
	}
	return s[:maxLen]
}

// bracketPattern matches [tag] at the start of titles.
var bracketPattern = regexp.MustCompile(`^\[([^\]]+)\]\s*`)
var inlineTagPattern = regexp.MustCompile(`(^|[\s(])#([A-Za-z0-9:_/-]+)\b`)

// ExtractTags extracts [bracketed] tags from a title.
// Returns the extracted tags and the remaining title with brackets removed.
// Example: "[pure-eb] [covariance] Fix bug" → (["pure-eb", "covariance"], "Fix bug")
func ExtractTags(title string) ([]string, string) {
	var tags []string
	remaining := title

	for {
		match := bracketPattern.FindStringSubmatch(remaining)
		if match == nil {
			break
		}
		tags = append(tags, match[1])
		remaining = remaining[len(match[0]):]
	}

	return tags, strings.TrimSpace(remaining)
}

// ExtractInlineTags finds hashtag-style body tags such as #question or
// #tapestry:cosebis_data_vector.
func ExtractInlineTags(body string) []string {
	matches := inlineTagPattern.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	var tags []string
	for _, match := range matches {
		tag := strings.TrimSpace(match[2])
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	return tags
}

// HasTag returns true if the felt has the specified tag.
// Supports prefix matching: if tag ends with ":", matches any tag with that prefix.
func (f *Felt) HasTag(tag string) bool {
	if strings.HasSuffix(tag, ":") {
		// Prefix match: "rule:" matches "rule:cosebis_data_vector"
		for _, t := range f.Tags {
			if strings.HasPrefix(t, tag) {
				return true
			}
		}
		return false
	}
	for _, t := range f.Tags {
		if t == tag {
			return true
		}
	}
	return false
}

// AddTag adds a tag if it doesn't already exist.
func (f *Felt) AddTag(tag string) {
	if !f.HasTag(tag) {
		f.Tags = append(f.Tags, tag)
	}
}

// RemoveTag removes a tag if it exists.
func (f *Felt) RemoveTag(tag string) {
	for i, t := range f.Tags {
		if t == tag {
			f.Tags = append(f.Tags[:i], f.Tags[i+1:]...)
			return
		}
	}
}

// Parse parses a felt file content into a Felt struct.
// The id parameter is the ID extracted from the filename.
func Parse(id string, content []byte) (*Felt, error) {
	return ParseWithMode(id, content, ParseFull)
}

// ParseWithMode parses a felt file, optionally skipping body extraction.
func ParseWithMode(id string, content []byte, mode ParseMode) (*Felt, error) {
	frontmatter, body, err := splitFrontmatter(content, mode == ParseFull)
	if err != nil {
		return nil, err
	}

	f, err := parseFrontmatter(id, frontmatter)
	if err != nil {
		return nil, err
	}
	if mode == ParseFull {
		f.Body = strings.TrimSpace(body)
	}

	return f, nil
}

func parseFrontmatter(id string, frontmatter []byte) (*Felt, error) {
	type feltFrontmatter struct {
		Name            string                   `yaml:"name"`
		LegacyTitle     string                   `yaml:"title"`
		Status          string                   `yaml:"status,omitempty"`
		Tags            []string                 `yaml:"tags,omitempty"`
		CreatedAt       time.Time                `yaml:"created-at"`
		ClosedAt        *time.Time               `yaml:"closed-at,omitempty"`
		Outcome         string                   `yaml:"outcome,omitempty"`
		Due             *time.Time               `yaml:"due,omitempty"`
		Description     string                   `yaml:"description,omitempty"`
		Inputs          []ASTRAInput             `yaml:"inputs,omitempty"`
		Outputs         []ASTRAOutput            `yaml:"outputs,omitempty"`
		Decisions       map[string]ASTRADecision `yaml:"decisions,omitempty"`
		Insights        map[string]ASTRAInsight  `yaml:"insights,omitempty"`
		SuccessCriteria []ASTRASuccessCriterion  `yaml:"success_criteria,omitempty"`
		Container       string                   `yaml:"container,omitempty"`
	}

	var fm feltFrontmatter
	if err := yaml.Unmarshal(frontmatter, &fm); err != nil {
		return nil, fmt.Errorf("parsing YAML frontmatter: %w", err)
	}
	name := strings.TrimSpace(fm.Name)
	if name == "" {
		name = strings.TrimSpace(fm.LegacyTitle)
	}
	f := &Felt{
		ID:              id,
		Name:            name,
		Status:          fm.Status,
		Tags:            fm.Tags,
		CreatedAt:       fm.CreatedAt,
		ClosedAt:        fm.ClosedAt,
		Outcome:         fm.Outcome,
		Due:             fm.Due,
		Description:     fm.Description,
		Inputs:          fm.Inputs,
		Outputs:         fm.Outputs,
		Decisions:       fm.Decisions,
		Insights:        fm.Insights,
		SuccessCriteria: fm.SuccessCriteria,
		Container:       fm.Container,
	}
	f.canonicalizeName()
	return f, nil
}

func normalizeLegacyFrontmatter(frontmatter []byte) ([]byte, bool, bool, error) {
	var node yaml.Node
	if err := yaml.Unmarshal(frontmatter, &node); err != nil {
		return nil, false, false, fmt.Errorf("parsing YAML frontmatter: %w", err)
	}
	if len(node.Content) == 0 {
		return frontmatter, false, false, nil
	}

	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return nil, false, false, fmt.Errorf("frontmatter must be a YAML mapping")
	}

	nameIndex := -1
	titleIndex := -1
	dependsOnIndex := -1
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		switch mapping.Content[i].Value {
		case "name":
			nameIndex = i
		case "title":
			titleIndex = i
		case "depends-on":
			dependsOnIndex = i
		}
	}

	renamedTitle := false
	removedTitleEntry := false
	if nameIndex == -1 {
		if titleIndex != -1 {
			mapping.Content[titleIndex].Value = "name"
			renamedTitle = true
		}
	} else if titleIndex != -1 {
		mapping.Content = append(mapping.Content[:titleIndex], mapping.Content[titleIndex+2:]...)
		renamedTitle = true
		removedTitleEntry = true
	}
	removedDependsOn := false
	if dependsOnIndex != -1 {
		if removedTitleEntry && titleIndex != -1 && titleIndex < dependsOnIndex {
			dependsOnIndex -= 2
		}
		mapping.Content = append(mapping.Content[:dependsOnIndex], mapping.Content[dependsOnIndex+2:]...)
		removedDependsOn = true
	}
	if !renamedTitle && !removedDependsOn {
		return frontmatter, false, false, nil
	}

	rewritten, err := yaml.Marshal(mapping)
	if err != nil {
		return nil, false, false, fmt.Errorf("marshaling YAML frontmatter: %w", err)
	}
	return rewritten, renamedTitle, removedDependsOn, nil
}

func stripLegacyMystAnchor(id, body string) (string, bool) {
	lines := strings.Split(body, "\n")
	if len(lines) == 0 {
		return body, false
	}

	anchor := fmt.Sprintf("(%s)=", path.Base(id))
	firstContent := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		firstContent = i
		break
	}
	if firstContent == -1 || strings.TrimSpace(lines[firstContent]) != anchor {
		return body, false
	}

	lines = append(lines[:firstContent], lines[firstContent+1:]...)
	if firstContent < len(lines) && strings.TrimSpace(lines[firstContent]) == "" {
		lines = append(lines[:firstContent], lines[firstContent+1:]...)
	}
	return strings.Join(lines, "\n"), true
}

// splitFrontmatter separates YAML frontmatter from markdown body.
// SplitFrontmatter is the exported entry-point for callers outside the
// felt package that need raw YAML frontmatter bytes (e.g. `felt show
// --field <name>` reads the unparsed frontmatter, walks it as a yaml.Node,
// and emits one field). Mirrors `splitFrontmatter` semantics: returns
// (frontmatterBytes, body, error). Pass `includeBody=false` to skip body
// allocation when only frontmatter is needed.
func SplitFrontmatter(content []byte, includeBody bool) ([]byte, string, error) {
	return splitFrontmatter(content, includeBody)
}

// Frontmatter must be delimited by --- lines.
func splitFrontmatter(content []byte, includeBody bool) ([]byte, string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(content))

	// First line must be ---
	if !scanner.Scan() {
		return nil, "", fmt.Errorf("empty file")
	}
	if strings.TrimSpace(scanner.Text()) != "---" {
		return nil, "", fmt.Errorf("file must start with ---")
	}

	// Collect frontmatter until closing ---
	var frontmatter bytes.Buffer
	foundClosing := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			// Found closing delimiter
			foundClosing = true
			break
		}
		frontmatter.WriteString(line)
		frontmatter.WriteString("\n")
	}

	if err := scanner.Err(); err != nil {
		return nil, "", fmt.Errorf("scanning file: %w", err)
	}

	if !foundClosing {
		return nil, "", fmt.Errorf("unclosed frontmatter (missing closing ---)")
	}

	if !includeBody {
		return frontmatter.Bytes(), "", nil
	}

	// Rest is body
	var body strings.Builder
	for scanner.Scan() {
		body.WriteString(scanner.Text())
		body.WriteString("\n")
	}

	return frontmatter.Bytes(), body.String(), nil
}

// BodyStartLine returns the 1-based line number where body editing should
// begin: the line after frontmatter, skipping a single blank separator line
// when present.
func BodyStartLine(content []byte) (int, error) {
	scanner := bufio.NewScanner(bytes.NewReader(content))

	line := 0
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return 0, fmt.Errorf("scanning file: %w", err)
		}
		return 0, fmt.Errorf("empty file")
	}
	line++
	if strings.TrimSpace(scanner.Text()) != "---" {
		return 0, fmt.Errorf("file must start with ---")
	}

	foundClosing := false
	for scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "---" {
			foundClosing = true
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("scanning file: %w", err)
	}
	if !foundClosing {
		return 0, fmt.Errorf("unclosed frontmatter (missing closing ---)")
	}

	bodyStart := line + 1
	if scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "" {
			bodyStart = line + 1
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("scanning file: %w", err)
	}

	return bodyStart, nil
}

// Marshal serializes a Felt to markdown with YAML frontmatter.
func (f *Felt) Marshal() ([]byte, error) {
	f.canonicalizeName()

	// Build frontmatter struct for controlled field ordering
	fm := struct {
		Name            string                   `yaml:"name"`
		Status          string                   `yaml:"status,omitempty"`
		Tags            []string                 `yaml:"tags,omitempty"`
		CreatedAt       time.Time                `yaml:"created-at"`
		ClosedAt        *time.Time               `yaml:"closed-at,omitempty"`
		Outcome         string                   `yaml:"outcome,omitempty"`
		Due             *time.Time               `yaml:"due,omitempty"`
		Description     string                   `yaml:"description,omitempty"`
		Inputs          []ASTRAInput             `yaml:"inputs,omitempty"`
		Outputs         []ASTRAOutput            `yaml:"outputs,omitempty"`
		Decisions       map[string]ASTRADecision `yaml:"decisions,omitempty"`
		Insights        map[string]ASTRAInsight  `yaml:"insights,omitempty"`
		SuccessCriteria []ASTRASuccessCriterion  `yaml:"success_criteria,omitempty"`
		Container       string                   `yaml:"container,omitempty"`
	}{
		Name:            f.Name,
		Status:          f.Status,
		Tags:            f.Tags,
		CreatedAt:       f.CreatedAt,
		ClosedAt:        f.ClosedAt,
		Outcome:         f.Outcome,
		Due:             f.Due,
		Description:     f.Description,
		Inputs:          f.Inputs,
		Outputs:         f.Outputs,
		Decisions:       f.Decisions,
		Insights:        f.Insights,
		SuccessCriteria: f.SuccessCriteria,
		Container:       f.Container,
	}

	yamlBytes, err := yaml.Marshal(fm)
	if err != nil {
		return nil, fmt.Errorf("marshaling YAML: %w", err)
	}

	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.Write(yamlBytes)
	buf.WriteString("---\n")
	if f.Body != "" {
		buf.WriteString("\n")
		buf.WriteString(f.Body)
		buf.WriteString("\n")
	}

	return buf.Bytes(), nil
}

func (f *Felt) canonicalizeName() {
	f.Name = strings.TrimSpace(f.Name)
}

// DisplayName returns the canonical user-facing label.
func (f *Felt) DisplayName() string {
	return strings.TrimSpace(f.Name)
}

// HasScaffoldOnlyBody reports whether the body is just the generated MyST scaffold.
func (f *Felt) HasScaffoldOnlyBody() bool {
	return strings.TrimSpace(f.Body) == ""
}

func splitDataFlowRef(ref string) (fiberID, fragment string) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", ""
	}
	if idx := strings.Index(ref, "."); idx >= 0 {
		return strings.TrimSpace(ref[:idx]), strings.TrimSpace(ref[idx+1:])
	}
	return ref, ""
}

func remapDataFlowRef(ref, oldID, newID string) (string, bool) {
	targetFiber, fragment := splitDataFlowRef(ref)
	if targetFiber == "" {
		return ref, false
	}
	remappedFiber, ok := remapIDPrefix(targetFiber, oldID, newID)
	if !ok {
		return ref, false
	}
	if fragment == "" {
		return remappedFiber, true
	}
	return remappedFiber + "." + fragment, true
}

// MatchesIDQuery checks if an ID matches a query string.
// Full paths match by prefix; bare slugs also match the final path segment.
func MatchesIDQuery(id, query string) bool {
	if query == "" {
		return false
	}
	id = path.Clean(id)
	query = path.Clean(query)
	if strings.HasPrefix(id, query) {
		return true
	}
	if !strings.Contains(query, "/") {
		return strings.HasPrefix(path.Base(id), query)
	}
	return false
}

// MatchesID returns true if the given query matches this felt's ID.
func (f *Felt) MatchesID(query string) bool {
	return MatchesIDQuery(f.ID, query)
}

// SearchText returns searchable metadata content beyond the title.
func (f *Felt) SearchText() string {
	parts := []string{f.Outcome, f.Description, f.Container}
	for _, input := range f.Inputs {
		parts = append(parts, input.ID, input.Type, input.From, input.Source, input.Checksum, input.Description)
	}
	for _, output := range f.Outputs {
		parts = append(parts, output.ID, output.Type, output.Description)
		if output.Recipe != nil {
			parts = append(parts, output.Recipe.Command)
			parts = append(parts, flattenMapStrings(output.Recipe.Resources)...)
		}
	}
	for _, decision := range f.Decisions {
		parts = append(parts, decision.Label, decision.Rationale, decision.Default)
		for _, option := range decision.Options {
			parts = append(parts, option.Label, option.Description, option.ExcludedReason)
		}
	}
	for _, insight := range f.Insights {
		parts = append(parts, insight.Claim, insight.Scope, insight.Notes)
		parts = append(parts, insight.Tags...)
		for _, evidence := range insight.Evidence {
			parts = append(parts, evidence.ID, evidence.DOI, evidence.Artifact, evidence.Checksum, evidence.Snapshot, evidence.SourceCommit)
			if evidence.Document != nil {
				parts = append(parts, evidence.Document.Path, evidence.Document.Commit)
			}
			if evidence.Version != nil {
				parts = append(parts, fmt.Sprintf("%d", *evidence.Version))
			}
			if evidence.Quote != nil {
				parts = append(parts, evidence.Quote.Type, evidence.Quote.Exact, evidence.Quote.Prefix, evidence.Quote.Suffix)
			}
			if evidence.Figure != nil {
				parts = append(parts, evidence.Figure.Type, evidence.Figure.Label, evidence.Figure.Caption)
			}
			if evidence.Table != nil {
				parts = append(parts, evidence.Table.Type, evidence.Table.Label, evidence.Table.Caption, evidence.Table.Region)
			}
			if evidence.Location != nil {
				parts = append(parts, evidence.Location.Type, evidence.Location.ConformsTo, evidence.Location.Value)
				if evidence.Location.Page != nil {
					parts = append(parts, fmt.Sprintf("%d", *evidence.Location.Page))
				}
				if evidence.Location.Start != nil {
					parts = append(parts, fmt.Sprintf("%d", *evidence.Location.Start))
				}
				if evidence.Location.End != nil {
					parts = append(parts, fmt.Sprintf("%d", *evidence.Location.End))
				}
			}
		}
	}
	for _, criterion := range f.SuccessCriteria {
		parts = append(parts, criterion.Claim, criterion.Output, criterion.Condition)
	}
	return strings.Join(parts, "\n")
}

func flattenMapStrings(m map[string]any) []string {
	if len(m) == 0 {
		return nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return []string{string(data)}
}

// StatusIcon returns the display character for a status.
func StatusIcon(status string) string {
	switch status {
	case StatusOpen:
		return "○"
	case StatusActive:
		return "◐"
	case StatusClosed:
		return "●"
	case "":
		return "·"
	default:
		return "?"
	}
}

// ShortID truncates long path-like IDs for display.
func ShortID(id string) string {
	if len(id) <= 24 {
		return id
	}
	parts := strings.Split(id, "/")
	if len(parts) >= 2 {
		tail := strings.Join(parts[len(parts)-2:], "/")
		if len(tail)+4 <= 24 {
			return ".../" + tail
		}
	}
	return id[:21] + "..."
}

// IsOpen returns true if the felt is open.
func (f *Felt) IsOpen() bool {
	return f.Status == StatusOpen
}

// IsActive returns true if the felt is active.
func (f *Felt) IsActive() bool {
	return f.Status == StatusActive
}

// IsClosed returns true if the felt is closed.
func (f *Felt) IsClosed() bool {
	return f.Status == StatusClosed
}

// idPattern matches slash-separated slug paths.
var idPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9_]+(?:[-_][a-z0-9_]+)*)*$`)

// ValidateID checks if an ID matches the expected format.
func ValidateID(id string) bool {
	return idPattern.MatchString(id)
}

// bodyLinkRe matches markdown links: [text](target)
var bodyLinkRe = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)

// wikiLinkRe matches [[slug]], [[slug#fragment]], and [[slug#fragment|label]] wikilinks.
var wikiLinkRe = regexp.MustCompile(`\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]`)

// codeBlockRe matches fenced code blocks (``` or ~~~).
var codeBlockRe = regexp.MustCompile("(?s)```[^`]*```|~~~[^~]*~~~")

// codeSpanRe matches inline code spans (`...`).
var codeSpanRe = regexp.MustCompile("`[^`]+`")

// stripCodeContent removes fenced code blocks and inline code spans from body
// so that wikilink extraction doesn't match illustrative examples in documentation.
func stripCodeContent(body string) string {
	body = codeBlockRe.ReplaceAllString(body, "")
	body = codeSpanRe.ReplaceAllString(body, "")
	return body
}

// ExtractBodyRefs finds fiber references in a body from markdown links and wikilinks.
// References inside code spans or fenced code blocks are ignored.
func ExtractBodyRefs(body string) []BodyRef {
	seen := map[string]bool{}
	var refs []BodyRef

	add := func(target, fragment string) {
		ref, ok := parseBodyRefTarget(target, fragment)
		if !ok {
			return
		}
		key := ref.Target + "#" + ref.Fragment
		if seen[key] {
			return
		}
		seen[key] = true
		refs = append(refs, ref)
	}

	stripped := stripCodeContent(body)
	for _, m := range bodyLinkRe.FindAllStringSubmatch(stripped, -1) {
		add(m[1], "")
	}
	for _, m := range wikiLinkRe.FindAllStringSubmatch(stripped, -1) {
		add(m[1], m[2])
	}
	return refs
}

func (r BodyRef) String() string {
	if r.Fragment == "" {
		return r.Target
	}
	return r.Target + "#" + r.Fragment
}

func parseBodyRefTarget(target, fragment string) (BodyRef, bool) {
	target = strings.TrimSpace(target)
	if target == "" {
		return BodyRef{}, false
	}
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "/") {
		return BodyRef{}, false
	}
	if fragment == "" {
		if idx := strings.Index(target, "#"); idx >= 0 {
			fragment = target[idx+1:]
			target = target[:idx]
		}
	}
	target = strings.TrimPrefix(target, "./")
	target = strings.TrimPrefix(target, "../")
	target = strings.Trim(target, "/")
	if target == "" || strings.Contains(path.Base(target), ".") {
		return BodyRef{}, false
	}
	return BodyRef{
		Target:   target,
		Fragment: strings.TrimSpace(fragment),
	}, true
}
