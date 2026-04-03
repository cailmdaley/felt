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

// Dependency represents a dependency with an optional label explaining why.
type Dependency struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

// UnmarshalYAML handles both bare string and {id, label} object forms.
func (d *Dependency) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		d.ID = value.Value
		return nil
	}
	if value.Kind == yaml.MappingNode {
		type raw struct {
			ID    string `yaml:"id"`
			Label string `yaml:"label"`
		}
		var r raw
		if err := value.Decode(&r); err != nil {
			return err
		}
		d.ID = r.ID
		d.Label = r.Label
		return nil
	}
	return fmt.Errorf("dependency must be a string or {id, label} object")
}

// MarshalYAML emits bare string when no label, object when label is present.
func (d Dependency) MarshalYAML() (interface{}, error) {
	if d.Label == "" {
		return d.ID, nil
	}
	return struct {
		ID    string `yaml:"id"`
		Label string `yaml:"label"`
	}{d.ID, d.Label}, nil
}

// Dependencies is a slice of Dependency with helper methods.
type Dependencies []Dependency

// IDs returns just the dependency IDs.
func (deps Dependencies) IDs() []string {
	ids := make([]string, len(deps))
	for i, d := range deps {
		ids[i] = d.ID
	}
	return ids
}

// HasID returns true if the given ID is in the dependencies.
func (deps Dependencies) HasID(id string) bool {
	for _, d := range deps {
		if d.ID == id {
			return true
		}
	}
	return false
}

// LabelFor returns the label for a given dependency ID, or empty string.
func (deps Dependencies) LabelFor(id string) string {
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

// Felt represents a single fiber in the DAG.
type Felt struct {
	ID              string                   `yaml:"-" json:"id"`
	Title           string                   `yaml:"title" json:"title"`
	Status          string                   `yaml:"status,omitempty" json:"status,omitempty"`
	Tags            []string                 `yaml:"tags,omitempty" json:"tags,omitempty"`
	DependsOn       Dependencies             `yaml:"depends-on,omitempty" json:"depends_on,omitempty"`
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
}

// HasStatus returns true if the fiber has opt-in status tracking.
func (f *Felt) HasStatus() bool {
	return f.Status != ""
}

// New creates a new Felt with default values.
// Returns an error if title is empty.
// Fibers have no status by default — status is opt-in for tracked work.
func New(title string) (*Felt, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, fmt.Errorf("title cannot be empty")
	}

	id, err := GenerateID(title)
	if err != nil {
		return nil, err
	}

	return &Felt{
		ID:        id,
		Title:     title,
		DependsOn: Dependencies{},
		CreatedAt: time.Now(),
	}, nil
}

// GenerateID creates a slug-based ID.
func GenerateID(title string) (string, error) {
	slug := slugify(title)
	if len(slug) > 32 {
		// Truncate at word boundary
		slug = truncateAtWord(slug, 32)
	}

	if slug == "" {
		return "", fmt.Errorf("title must contain at least one alphanumeric character")
	}
	return slug, nil
}

// slugify converts a title to a URL-safe slug.
func slugify(s string) string {
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
	f := &Felt{ID: id}
	if err := yaml.Unmarshal(frontmatter, f); err != nil {
		return nil, fmt.Errorf("parsing YAML frontmatter: %w", err)
	}
	return f, nil
}

// splitFrontmatter separates YAML frontmatter from markdown body.
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

// Marshal serializes a Felt to markdown with YAML frontmatter.
func (f *Felt) Marshal() ([]byte, error) {
	f.ensureMySTBody()

	// Build frontmatter struct for controlled field ordering
	fm := struct {
		Title           string                   `yaml:"title"`
		Status          string                   `yaml:"status,omitempty"`
		Tags            []string                 `yaml:"tags,omitempty"`
		DependsOn       Dependencies             `yaml:"depends-on,omitempty"`
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
		Title:           f.Title,
		Status:          f.Status,
		Tags:            f.Tags,
		DependsOn:       f.DependsOn,
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

func mystAnchor(id string) string {
	return path.Base(path.Clean(id))
}

func defaultMySTBody(id, title string) string {
	anchor := mystAnchor(id)
	if anchor == "." || anchor == "" {
		return "# " + title
	}
	return fmt.Sprintf("(%s)=\n# %s", anchor, title)
}

func (f *Felt) ensureMySTBody() {
	body := strings.TrimSpace(f.Body)
	if body == "" {
		f.Body = defaultMySTBody(f.ID, f.Title)
		return
	}

	anchorLine := fmt.Sprintf("(%s)=", mystAnchor(f.ID))
	if strings.HasPrefix(body, anchorLine) {
		f.Body = body
		return
	}

	f.Body = anchorLine + "\n" + body
}

// HasScaffoldOnlyBody reports whether the body is just the generated MyST scaffold.
func (f *Felt) HasScaffoldOnlyBody() bool {
	return strings.TrimSpace(f.Body) == defaultMySTBody(f.ID, f.Title)
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

// AppendComment adds a timestamped comment to the body.
func (f *Felt) AppendComment(text string) {
	f.ensureMySTBody()

	timestamp := time.Now().Format("2006-01-02 15:04")
	comment := fmt.Sprintf("\n**%s** — %s", timestamp, text)

	// Ensure Comments section exists
	if !strings.Contains(f.Body, "## Comments") {
		if f.Body != "" {
			f.Body += "\n"
		}
		f.Body += "\n## Comments"
	}

	f.Body += comment + "\n"
}

// idPattern matches slash-separated slug paths.
var idPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$`)

// ValidateID checks if an ID matches the expected format.
func ValidateID(id string) bool {
	return idPattern.MatchString(id)
}
