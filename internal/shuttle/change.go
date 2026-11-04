package shuttle

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Change is a self-contained snapshot of two committed Git trees and their story.
type Change struct {
	Version int            `json:"version"`
	Title   string         `json:"title"`
	Repo    ChangeRepo     `json:"repo"`
	Base    string         `json:"base"`
	Head    string         `json:"head"`
	BaseRef string         `json:"base_ref"`
	HeadRef string         `json:"head_ref"`
	Commits []ChangeCommit `json:"commits"`
	Patch   string         `json:"patch"`
	Files   []ChangeFile   `json:"files"`
	Story   *ChangeStory   `json:"story"`
}

type ChangeRepo struct {
	Name     string  `json:"name"`
	Dir      string  `json:"dir"`
	ForgeURL *string `json:"forge_url"`
}

type ChangeCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Time    string `json:"time"`
}

type ChangeFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Role      string `json:"role"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type ChangeStory struct {
	Title    string            `json:"title,omitempty"`
	Overview string            `json:"overview"`
	Flags    []ChangeFlag      `json:"flags"`
	Chapters []ChangeChapter   `json:"chapters"`
	Roles    map[string]string `json:"roles,omitempty"`
}

type ChangeRange struct {
	File string `json:"file"`
	From int    `json:"from,omitempty"`
	To   int    `json:"to,omitempty"`
	Side string `json:"side,omitempty"`
}

type ChangeFlag struct {
	ChangeRange
	Text string `json:"text"`
}

type ChangeChapter struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	Narrative string       `json:"narrative"`
	WhyHere   string       `json:"why_here"`
	Stops     []ChangeStop `json:"stops"`
}

type ChangeStop struct {
	ChangeRange
	Note       string `json:"note"`
	Importance string `json:"importance"`
}

// ChangeHunk identifies a unified-diff hunk on both sides. Zero counts have no lines.
type ChangeHunk struct {
	File     string `json:"file"`
	OldFrom  int    `json:"old_from"`
	OldLines int    `json:"old_lines"`
	NewFrom  int    `json:"new_from"`
	NewLines int    `json:"new_lines"`
}

type ChangeReport struct {
	Path      string       `json:"path,omitempty"`
	Valid     bool         `json:"valid"`
	Covered   int          `json:"covered"`
	Total     int          `json:"total"`
	Uncovered []ChangeHunk `json:"uncovered"`
	Errors    []string     `json:"errors"`
}

// BuildChange invokes Git directly; refs resolve before any tree or log reads.
// Base is the exact comparison tree, not an implicit merge base.
func BuildChange(env *sysenv.Env, repo, base, head string, story *ChangeStory) (*Change, []ChangeHunk, error) {
	git := func(args ...string) (string, error) {
		cmd := env.Command("git", append([]string{"-C", repo}, args...)...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(stderr.String()), err)
		}
		return string(out), nil
	}
	resolve := func(ref string) (string, error) {
		out, err := git("rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
		return strings.TrimSpace(out), err
	}
	baseSHA, err := resolve(base)
	if err != nil {
		return nil, nil, err
	}
	headSHA, err := resolve(head)
	if err != nil {
		return nil, nil, err
	}
	root, err := git("rev-parse", "--show-toplevel")
	if err != nil {
		return nil, nil, err
	}
	root = strings.TrimSpace(root)
	if head == "HEAD" {
		ref, err := git("symbolic-ref", "--quiet", "--short", "HEAD")
		if err == nil {
			head = strings.TrimSpace(ref)
		}
	}
	c := &Change{Version: 1, Repo: ChangeRepo{Name: filepath.Base(root), Dir: repo}, Base: baseSHA, Head: headSHA, BaseRef: base, HeadRef: head, Story: story, Files: []ChangeFile{}, Commits: []ChangeCommit{}}
	subject, err := git("show", "-s", "--format=%s", headSHA, "--")
	if err != nil {
		return nil, nil, err
	}
	c.Title = strings.TrimSpace(subject)
	if story != nil {
		if story.Title != "" {
			c.Title = story.Title
		}
		if story.Flags == nil {
			story.Flags = []ChangeFlag{}
		}
		if story.Chapters == nil {
			story.Chapters = []ChangeChapter{}
		}
		for i := range story.Chapters {
			if story.Chapters[i].Stops == nil {
				story.Chapters[i].Stops = []ChangeStop{}
			}
		}
	}
	log, err := git("log", "--reverse", "--no-show-signature", "--no-notes", "--format=%H%x00%s%x00%an%x00%aI%x00", baseSHA+".."+headSHA, "--")
	if err != nil {
		return nil, nil, err
	}
	fields := strings.Split(log, "\x00")
	for len(fields) >= 4 {
		c.Commits = append(c.Commits, ChangeCommit{SHA: strings.TrimLeft(fields[0], "\n"), Subject: fields[1], Author: fields[2], Time: fields[3]})
		fields = fields[4:]
	}
	diff := func(format ...string) (string, error) {
		args := []string{"diff", "-O", os.DevNull, "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--find-renames", "--ignore-submodules=none", "--submodule=short"}
		args = append(args, format...)
		return git(append(args, baseSHA, headSHA, "--")...)
	}
	names, err := diff("--name-status", "-z")
	if err != nil {
		return nil, nil, err
	}
	tokens := strings.Split(strings.TrimSuffix(names, "\x00"), "\x00")
	for len(tokens) >= 2 {
		status, path := tokens[0], tokens[1]
		tokens = tokens[2:]
		if strings.HasPrefix(status, "R") {
			path = tokens[0]
			tokens = tokens[1:]
		}
		label := map[byte]string{'A': "added", 'M': "modified", 'D': "deleted", 'R': "renamed", 'T': "modified"}[status[0]]
		c.Files = append(c.Files, ChangeFile{Path: path, Status: label, Role: ChangeRole(path)})
	}
	stats, err := diff("--numstat", "-z")
	if err != nil {
		return nil, nil, err
	}
	tokens = strings.Split(strings.TrimSuffix(stats, "\x00"), "\x00")
	for i := 0; len(tokens) > 0 && tokens[0] != ""; i++ {
		parts := strings.SplitN(tokens[0], "\t", 3)
		tokens = tokens[1:]
		if parts[2] == "" {
			tokens = tokens[2:]
		} // Rename records carry two NUL-delimited paths.
		c.Files[i].Additions, _ = strconv.Atoi(parts[0])
		c.Files[i].Deletions, _ = strconv.Atoi(parts[1])
	}
	c.Patch, err = diff("--patch", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/")
	if err != nil {
		return nil, nil, err
	}
	hunks := []ChangeHunk{}
	file := ""
	inHunk := false
	for _, line := range strings.Split(c.Patch, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			file, inHunk = "", false
			continue
		}
		if !inHunk && (strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ")) {
			path := strings.TrimSuffix(line[4:], "\t")
			if strings.HasPrefix(path, "\"") {
				path, err = strconv.Unquote(path)
				if err != nil {
					return nil, nil, fmt.Errorf("decode Git patch path: %w", err)
				}
			}
			if path != "/dev/null" {
				file = path[2:]
			}
			continue
		}
		match := changeHunkHeader.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		inHunk = true
		count := func(s string) int {
			if s == "" {
				return 1
			}
			n, _ := strconv.Atoi(s)
			return n
		}
		oldFrom, _ := strconv.Atoi(match[1])
		newFrom, _ := strconv.Atoi(match[3])
		hunks = append(hunks, ChangeHunk{File: file, OldFrom: oldFrom, OldLines: count(match[2]), NewFrom: newFrom, NewLines: count(match[4])})
	}
	return c, hunks, nil
}

var changeHunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// ValidateChange checks every story reference and counts coverage from stops only.
// Flags direct attention but do not remove hunks from Remaining.
func ValidateChange(c *Change, hunks []ChangeHunk) ChangeReport {
	report := ChangeReport{Valid: true, Total: len(hunks), Uncovered: []ChangeHunk{}, Errors: []string{}}
	files := map[string]int{}
	for i, f := range c.Files {
		files[f.Path] = i
	}
	covered := make([]bool, len(hunks))
	bad := func(s string) { report.Errors = append(report.Errors, s) }
	check := func(label string, r ChangeRange, stop bool) {
		if _, ok := files[r.File]; !ok {
			bad(fmt.Sprintf("%s: unknown file %q", label, r.File))
			return
		}
		if r.Side != "" && r.Side != "old" && r.Side != "new" {
			bad(fmt.Sprintf("%s: invalid side %q (use old or new)", label, r.Side))
			return
		}
		whole := r.From == 0 && r.To == 0
		if !whole && (r.From < 1 || r.To < r.From) {
			bad(fmt.Sprintf("%s: invalid range %d..%d (supply both from and to, or neither)", label, r.From, r.To))
			return
		}
		overlaps := false
		hasHunks := false
		for i, h := range hunks {
			if h.File != r.File {
				continue
			}
			hasHunks = true
			from, lines := h.NewFrom, h.NewLines
			if r.Side == "old" {
				from, lines = h.OldFrom, h.OldLines
			}
			if lines > 0 && (whole || (r.From <= from+lines-1 && r.To >= from)) {
				overlaps = true
				if stop {
					covered[i] = true
				}
			}
		}
		if !overlaps && (!whole || hasHunks) {
			side := r.Side
			if side == "" {
				side = "new"
			}
			bad(fmt.Sprintf("%s: %s:%d..%d overlaps no hunk on %s side", label, r.File, r.From, r.To, side))
		}
	}
	if c.Story != nil {
		for i, flag := range c.Story.Flags {
			check(fmt.Sprintf("flags[%d]", i), flag.ChangeRange, false)
		}
		for i, chapter := range c.Story.Chapters {
			for j, stop := range chapter.Stops {
				label := fmt.Sprintf("chapters[%d].stops[%d]", i, j)
				switch stop.Importance {
				case "critical", "important", "supporting", "context":
				default:
					bad(fmt.Sprintf("%s: invalid importance %q", label, stop.Importance))
				}
				check(label, stop.ChangeRange, true)
			}
		}
		paths := make([]string, 0, len(c.Story.Roles))
		for path := range c.Story.Roles {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			role := c.Story.Roles[path]
			i, ok := files[path]
			if !ok {
				bad(fmt.Sprintf("roles: unknown file %q", path))
				continue
			}
			switch role {
			case "implementation", "test", "generated", "config", "docs":
				c.Files[i].Role = role
			default:
				bad(fmt.Sprintf("roles[%q]: invalid role %q", path, role))
			}
		}
	}
	for i, h := range hunks {
		if covered[i] {
			report.Covered++
		} else {
			report.Uncovered = append(report.Uncovered, h)
		}
	}
	report.Valid = len(report.Errors) == 0
	return report
}
