// Package felt provides the core data structures and operations for the felt task tracker.
package felt

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

// Status constants
const (
	StatusOpen   = "open"
	StatusActive = "active"
	StatusClosed = "closed"
)

// Default kind
const DefaultKind = "task"

// Felt represents a single task/spec/thread in the DAG.
type Felt struct {
	ID          string     `yaml:"-" json:"id"`
	Title       string     `yaml:"title" json:"title"`
	Status      string     `yaml:"status" json:"status"`
	Kind        string     `yaml:"kind,omitempty" json:"kind,omitempty"`
	Tags        []string   `yaml:"tags,omitempty" json:"tags,omitempty"`
	Priority    int        `yaml:"priority,omitempty" json:"priority,omitempty"`
	DependsOn   []string   `yaml:"depends-on,omitempty" json:"depends_on,omitempty"`
	CreatedAt   time.Time  `yaml:"created-at" json:"created_at"`
	ClosedAt    *time.Time `yaml:"closed-at,omitempty" json:"closed_at,omitempty"`
	CloseReason string     `yaml:"close-reason,omitempty" json:"close_reason,omitempty"`
	Due         *time.Time `yaml:"due,omitempty" json:"due,omitempty"`
	Body        string     `yaml:"-" json:"body,omitempty"`
}

// New creates a new Felt with default values.
// Returns an error if title is empty.
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
		Status:    StatusOpen,
		Kind:      DefaultKind,
		Priority:  2,
		DependsOn: []string{},
		CreatedAt: time.Now(),
	}, nil
}

// GenerateID creates a slug-based ID with random hex suffix.
func GenerateID(title string) (string, error) {
	slug := slugify(title)
	if len(slug) > 32 {
		// Truncate at word boundary
		slug = truncateAtWord(slug, 32)
	}

	// Generate 4 random bytes (8 hex chars)
	randBytes := make([]byte, 4)
	if _, err := rand.Read(randBytes); err != nil {
		return "", fmt.Errorf("generating random bytes: %w", err)
	}
	hexSuffix := hex.EncodeToString(randBytes)

	if slug == "" {
		return hexSuffix, nil
	}
	return slug + "-" + hexSuffix, nil
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
func (f *Felt) HasTag(tag string) bool {
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
	frontmatter, body, err := splitFrontmatter(content)
	if err != nil {
		return nil, err
	}

	f := &Felt{ID: id}
	if err := yaml.Unmarshal(frontmatter, f); err != nil {
		return nil, fmt.Errorf("parsing YAML frontmatter: %w", err)
	}

	f.Body = strings.TrimSpace(body)

	// Set defaults
	if f.Kind == "" {
		f.Kind = DefaultKind
	}

	return f, nil
}

// splitFrontmatter separates YAML frontmatter from markdown body.
// Frontmatter must be delimited by --- lines.
func splitFrontmatter(content []byte) ([]byte, string, error) {
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
	// Build frontmatter struct for controlled field ordering
	fm := struct {
		Title       string     `yaml:"title"`
		Status      string     `yaml:"status"`
		Kind        string     `yaml:"kind,omitempty"`
		Tags        []string   `yaml:"tags,omitempty"`
		Priority    int        `yaml:"priority,omitempty"`
		DependsOn   []string   `yaml:"depends-on,omitempty"`
		CreatedAt   time.Time  `yaml:"created-at"`
		ClosedAt    *time.Time `yaml:"closed-at,omitempty"`
		CloseReason string     `yaml:"close-reason,omitempty"`
		Due         *time.Time `yaml:"due,omitempty"`
	}{
		Title:       f.Title,
		Status:      f.Status,
		Kind:        f.Kind,
		Tags:        f.Tags,
		Priority:    f.Priority,
		DependsOn:   f.DependsOn,
		CreatedAt:   f.CreatedAt,
		ClosedAt:    f.ClosedAt,
		CloseReason: f.CloseReason,
		Due:         f.Due,
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

// MatchesID returns true if the given query matches this felt's ID.
// Supports prefix matching and hex suffix matching.
func (f *Felt) MatchesID(query string) bool {
	// Exact or prefix match
	if f.ID == query || strings.HasPrefix(f.ID, query) {
		return true
	}

	// Try matching just the hex suffix (e.g., "ac6b19c1" or "ac6b")
	// This is useful when the slug is long but you know the hex part
	parts := strings.Split(f.ID, "-")
	if len(parts) >= 2 {
		hexPart := parts[len(parts)-1]
		if strings.HasPrefix(hexPart, query) {
			return true
		}
	}

	return false
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

// idPattern matches the felt ID format: either slug-8hexchars or just 8hexchars
// The hex-only case occurs when titles contain no alphanumeric characters
var idPattern = regexp.MustCompile(`^([a-z0-9-]+-)?[a-f0-9]{8}$`)

// ValidateID checks if an ID matches the expected format.
func ValidateID(id string) bool {
	return idPattern.MatchString(id)
}
