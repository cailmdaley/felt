package shuttle

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var changeSections = regexp.MustCompile(`(?m)^diff --git `)

type changeRow struct {
	text     string
	old, new int
}

// parsePatch resolves headers against the NUL-delimited inventory.
// File-type changes can have two sections for one inventory entry.
func (c *Change) parsePatch() ([]ChangeHunk, error) {
	for i := range c.Files {
		c.Files[i].Hunks = []ChangeHunk{}
	}
	for _, section := range changeSections.Split(c.Patch, -1) {
		if section == "" {
			continue
		}
		lines := strings.Split(strings.TrimSuffix("diff --git "+section, "\n"), "\n")
		first := len(lines)
		for i, line := range lines {
			if changeHunkHeader.MatchString(line) {
				first = i
				break
			}
		}
		header := strings.Join(lines[:first], "\n") + "\n"
		file := c.patchFile(lines[:first])
		if file == nil {
			return nil, fmt.Errorf("patch has no inventory entry: %s", header)
		}
		file.Header += header
		var current *ChangeHunk
		old, next := 0, 0
		for _, line := range lines[first:] {
			if match := changeHunkHeader.FindStringSubmatch(line); match != nil {
				count := func(s string) int {
					if s == "" {
						return 1
					}
					n, _ := strconv.Atoi(s)
					return n
				}
				old, _ = strconv.Atoi(match[1])
				next, _ = strconv.Atoi(match[3])
				file.Hunks = append(file.Hunks, ChangeHunk{File: file.Path, OldFrom: old, OldLines: count(match[2]), NewFrom: next, NewLines: count(match[4]), header: header})
				current = &file.Hunks[len(file.Hunks)-1]
			} else if current != nil && len(line) > 0 && strings.ContainsRune(" +-\\", rune(line[0])) {
				current.rows = append(current.rows, changeRow{line, old, next})
				if line[0] == ' ' || line[0] == '-' {
					old++
				}
				if line[0] == ' ' || line[0] == '+' {
					next++
				}
			}
		}
	}
	hunks := []ChangeHunk{}
	for i := range c.Files {
		f := &c.Files[i]
		if f.Hunks == nil {
			f.Hunks = []ChangeHunk{}
		}
		// Counts describe the captured text, including attribute-marked text.
		f.Additions, f.Deletions = 0, 0
		for j := range f.Hunks {
			h := &f.Hunks[j]
			h.Patch = h.render(h.rows)
			h.Windows = h.windows()
			for _, row := range h.rows {
				if row.text[0] == '+' {
					f.Additions++
				}
				if row.text[0] == '-' {
					f.Deletions++
				}
			}
			hunks = append(hunks, *h)
		}
	}
	return hunks, nil
}

func (h ChangeHunk) render(rows []changeRow) string {
	if len(rows) == 0 {
		return ""
	}
	oldLines, newLines := 0, 0
	var body strings.Builder
	for _, row := range rows {
		body.WriteString(row.text)
		body.WriteByte('\n')
		if row.text[0] == ' ' || row.text[0] == '-' {
			oldLines++
		}
		if row.text[0] == ' ' || row.text[0] == '+' {
			newLines++
		}
	}
	old, next := rows[0].old, rows[0].new
	// Zero-side starts denote the preceding line, not the cursor for the next row.
	if oldLines == 0 && h.OldLines != 0 {
		old--
	}
	if newLines == 0 && h.NewLines != 0 {
		next--
	}
	return fmt.Sprintf("%s@@ -%d,%d +%d,%d @@\n%s", h.header, old, oldLines, next, newLines, body.String())
}

func (h ChangeHunk) windows() []ChangeWindow {
	windows := []ChangeWindow{}
	for start := 0; start < len(h.rows); {
		end := min(start+120, len(h.rows))
		if end < len(h.rows) && h.rows[end].text[0] == '\\' {
			end++
		}
		rows := h.rows[start:end]
		slice := h.withRows(rows)
		windows = append(windows, ChangeWindow{OldFrom: slice.OldFrom, OldLines: slice.OldLines, NewFrom: slice.NewFrom, NewLines: slice.NewLines, Patch: slice.Patch, Rows: len(rows)})
		start = end
	}
	return windows
}

func (h ChangeHunk) withRows(rows []changeRow) ChangeHunk {
	out := h
	out.rows = rows
	out.OldFrom = rows[0].old
	out.NewFrom = rows[0].new
	out.OldLines = 0
	out.NewLines = 0
	for _, row := range rows {
		if row.text[0] == ' ' || row.text[0] == '-' {
			out.OldLines++
		}
		if row.text[0] == ' ' || row.text[0] == '+' {
			out.NewLines++
		}
	}
	out.Patch = h.render(rows)
	out.Windows = nil
	return out
}

func (h ChangeHunk) excerpt(r ChangeRange) (ChangeHunk, bool) {
	if r.From == 0 && r.To == 0 {
		return h, true
	}
	rows := []changeRow{}
	selected := false
	for _, row := range h.rows {
		if row.text[0] == '\\' {
			if selected {
				rows = append(rows, row)
			}
			continue
		}
		line := row.new
		if r.Side == "old" {
			line = row.old
		}
		selected = line >= r.From && line <= r.To
		if selected {
			rows = append(rows, row)
		}
	}
	if len(rows) == 0 {
		return ChangeHunk{}, false
	}
	out := h.withRows(rows)
	out.Windows = out.windows()
	return out, true
}

// shown requires one stop to show all changed lines, never a union of partial stops.
func (h ChangeHunk) shown(r ChangeRange) bool {
	if r.From == 0 && r.To == 0 {
		return true
	}
	kind := byte('+')
	if r.Side == "old" {
		kind = '-'
	}
	changes := 0
	for _, row := range h.rows {
		if row.text[0] != kind {
			continue
		}
		changes++
		line := row.new
		if r.Side == "old" {
			line = row.old
		}
		if line < r.From || line > r.To {
			return false
		}
	}
	return changes > 0
}
