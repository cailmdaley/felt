package shuttle

import (
	"bytes"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"

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
	Patch   string         `json:"-"`
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
	Path      string       `json:"path"`
	Status    string       `json:"status"`
	Role      string       `json:"role"`
	Additions int          `json:"additions"`
	Deletions int          `json:"deletions"`
	Header    string       `json:"header"`
	Hunks     []ChangeHunk `json:"hunks"`
	Remaining []ChangeHunk `json:"remaining"`
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
	Note       string       `json:"note"`
	Importance string       `json:"importance"`
	Hunks      []ChangeHunk `json:"hunks"`
}

// ChangeHunk identifies a unified-diff hunk on both sides. Zero counts have no lines.
type ChangeHunk struct {
	File     string         `json:"file"`
	OldFrom  int            `json:"old_from"`
	OldLines int            `json:"old_lines"`
	NewFrom  int            `json:"new_from"`
	NewLines int            `json:"new_lines"`
	Patch    string         `json:"patch"`
	Windows  []ChangeWindow `json:"windows"`
	rows     []changeRow
	header   string
}

// ChangeWindow is an independently renderable, bounded piece of a hunk.
type ChangeWindow struct {
	OldFrom  int    `json:"old_from"`
	OldLines int    `json:"old_lines"`
	NewFrom  int    `json:"new_from"`
	NewLines int    `json:"new_lines"`
	Patch    string `json:"patch"`
	Rows     int    `json:"rows"`
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
// Base is the merge base of the requested base ref and head.
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
	mergeBase, err := git("merge-base", baseSHA, headSHA)
	if err != nil {
		return nil, nil, fmt.Errorf("no common ancestor for %q and %q: %w", base, head, err)
	}
	baseSHA = strings.TrimSpace(mergeBase)
	origin, _ := git("config", "--get", "remote.origin.url")
	name, forgeURL := changeOrigin(strings.TrimSpace(origin))
	if name == "" {
		worktrees, err := git("worktree", "list", "--porcelain", "-z")
		if err != nil {
			return nil, nil, err
		}
		mainDir, _, _ := strings.Cut(strings.TrimPrefix(worktrees, "worktree "), "\x00")
		name = filepath.Base(mainDir)
	}
	if head == "HEAD" {
		ref, err := git("symbolic-ref", "--quiet", "--short", "HEAD")
		if err == nil {
			head = strings.TrimSpace(ref)
		}
	}
	c := &Change{Version: 1, Repo: ChangeRepo{Name: name, Dir: repo, ForgeURL: forgeURL}, Base: baseSHA, Head: headSHA, BaseRef: base, HeadRef: head, Story: story, Files: []ChangeFile{}, Commits: []ChangeCommit{}}
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
	// An isolated index reads attributes from the captured head, not the worktree,
	// info/attributes or global attributes. This also works on Git without --attr-source.
	capture, err := os.MkdirTemp("", "shuttle-change-")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(capture)
	objects, err := git("rev-parse", "--path-format=absolute", "--git-path", "objects")
	if err != nil {
		return nil, nil, err
	}
	isolated := func(args ...string) (string, error) {
		prefix := []string{"--git-dir=" + capture, "-c", "core.attributesFile=" + os.DevNull,
			"-c", "diff.suppressBlankEmpty=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
			"-c", "diff.renames=true", "-c", "diff.context=3", "-c", "diff.interHunkContext=0", "-c", "diff.algorithm=myers", "-c", "diff.indentHeuristic=false", "-c", "core.quotePath=true"}
		cmd := env.Command("git", append(prefix, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git capture %v: %s: %w", args, out, err)
		}
		return string(out), nil
	}
	if _, err := isolated("init", "--bare", capture); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(filepath.Join(capture, "objects", "info", "alternates"), []byte(strings.TrimSpace(objects)+"\n"), 0600); err != nil {
		return nil, nil, err
	}
	if _, err := isolated("read-tree", headSHA); err != nil {
		return nil, nil, err
	}
	diff := func(format ...string) (string, error) {
		args := []string{"diff", "-O", os.DevNull, "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--find-renames", "--ignore-submodules=none", "--submodule=short"}
		args = append(args, format...)
		return isolated(append(args, baseSHA, headSHA, "--")...)
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
	c.Patch, err = diff("--patch", "--full-index", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/")
	if err != nil {
		return nil, nil, err
	}
	// Read blob identities from binary headers, including a rename's old blob.
	// Only attribute-marked text needs a forced text diff; real binary stays binary.
	sections := changeSections.Split(c.Patch, -1)
	var textSections []string
	for i, section := range sections {
		if !strings.Contains(section, "\nBinary files ") {
			continue
		}
		text := true
		for _, line := range strings.Split(section, "\n") {
			if !strings.HasPrefix(line, "index ") {
				continue
			}
			for _, oid := range strings.Split(strings.Fields(line)[1], "..") {
				if strings.Trim(oid, "0") == "" {
					continue
				}
				blob, err := git("cat-file", "blob", oid)
				if err != nil {
					return nil, nil, err
				}
				if strings.ContainsRune(blob, '\x00') {
					text = false
				}
			}
		}
		if !text {
			continue
		}
		if textSections == nil {
			patch, err := diff("--text", "--patch", "--full-index", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/")
			if err != nil {
				return nil, nil, err
			}
			textSections = changeSections.Split(patch, -1)
		}
		name, _, _ := strings.Cut(section, "\n")
		for _, candidate := range textSections {
			if strings.HasPrefix(candidate, name+"\n") {
				sections[i] = candidate
				break
			}
		}
	}
	c.Patch = strings.Join(sections, "diff --git ")
	hunks, err := c.parsePatch()
	return c, hunks, err
}

// changeOrigin extracts repository identity without contacting the remote.
func changeOrigin(origin string) (string, *string) {
	if origin == "" {
		return "", nil
	}
	u, err := url.Parse(origin)
	if err == nil && u.Host != "" {
		name := strings.TrimSuffix(path.Base(strings.TrimRight(u.Path, "/")), ".git")
		if u.Scheme == "http" || u.Scheme == "https" {
			u.Scheme, u.User, u.RawQuery, u.Fragment = "https", nil, "", ""
			u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), ".git")
			u.RawPath = ""
			forge := u.String()
			return name, &forge
		}
		return name, nil
	}
	remotePath := origin
	if host, p, ok := strings.Cut(origin, ":"); ok && !strings.Contains(host, "/") {
		remotePath = p
		if _, h, ok := strings.Cut(host, "@"); ok {
			host = h
		}
		if host == "github.com" || host == "gitlab.com" {
			forge := "https://" + host + "/" + strings.TrimSuffix(strings.Trim(p, "/"), ".git")
			return strings.TrimSuffix(path.Base(strings.TrimRight(p, "/")), ".git"), &forge
		}
	}
	return strings.TrimSuffix(path.Base(strings.TrimRight(remotePath, "/")), ".git"), nil
}

var changeHunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// ValidateChange checks every story reference and counts coverage from stops only.
// Flags direct attention but do not remove hunks from Remaining.
func ValidateChange(c *Change, hunks []ChangeHunk) ChangeReport {
	report := ChangeReport{Valid: true, Uncovered: []ChangeHunk{}, Errors: []string{}}
	files := map[string]int{}
	for i, f := range c.Files {
		files[f.Path] = i
		c.Files[i].Remaining = []ChangeHunk{}
	}
	bad := func(s string) { report.Errors = append(report.Errors, s) }
	check := func(label string, r ChangeRange) {
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
		for _, h := range hunks {
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
		if strings.IndexFunc(c.Story.Title, unicode.IsControl) >= 0 {
			bad("title: control characters are not allowed")
		}
		ids := map[string]bool{}
		for i, flag := range c.Story.Flags {
			check(fmt.Sprintf("flags[%d]", i), flag.ChangeRange)
		}
		for i, chapter := range c.Story.Chapters {
			if ids[chapter.ID] {
				bad(fmt.Sprintf("chapters[%d]: duplicate id %q", i, chapter.ID))
			}
			ids[chapter.ID] = true
			for j, stop := range chapter.Stops {
				c.Story.Chapters[i].Stops[j].Hunks = []ChangeHunk{}
				for _, h := range hunks {
					if h.File == stop.File {
						c.Story.Chapters[i].Stops[j].Hunks = append(c.Story.Chapters[i].Stops[j].Hunks, h.excerpts(stop.ChangeRange)...)
					}
				}
				label := fmt.Sprintf("chapters[%d].stops[%d]", i, j)
				switch stop.Importance {
				case "critical", "important", "supporting", "context":
				default:
					bad(fmt.Sprintf("%s: invalid importance %q", label, stop.Importance))
				}
				check(label, stop.ChangeRange)
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
	for _, h := range hunks {
		shown := make([]bool, len(h.rows))
		for i, row := range h.rows {
			if row.text[0] != '+' && row.text[0] != '-' {
				continue
			}
			report.Total++
			if c.Story != nil {
				for _, chapter := range c.Story.Chapters {
					for _, stop := range chapter.Stops {
						if stop.File == h.File && stop.includes(row) {
							shown[i] = true
						}
					}
				}
			}
			if shown[i] {
				report.Covered++
			}
		}
		remaining := h.remaining(shown)
		fi := files[h.File]
		c.Files[fi].Remaining = append(c.Files[fi].Remaining, remaining...)
		report.Uncovered = append(report.Uncovered, remaining...)
	}
	report.Valid = len(report.Errors) == 0
	return report
}
