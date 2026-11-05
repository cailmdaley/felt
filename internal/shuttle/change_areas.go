package shuttle

import (
	"path"
	"strings"
)

// Area patterns use path globs, with ** matching any number of directories.
func areaMatch(pattern, file string) bool {
	parts, names := strings.Split(pattern, "/"), strings.Split(file, "/")
	var match func([]string, []string) bool
	match = func(p, n []string) bool {
		if len(p) == 0 {
			return len(n) == 0
		}
		if p[0] == "**" {
			for i := 0; i <= len(n); i++ {
				if match(p[1:], n[i:]) {
					return true
				}
			}
			return false
		}
		if len(n) == 0 {
			return false
		}
		ok, _ := path.Match(p[0], n[0])
		return ok && match(p[1:], n[1:])
	}
	return match(parts, names)
}

func resolveChangeAreas(c *Change) []ChangeArea {
	areas := []ChangeArea{}
	var authored []ChangeArea
	if c.Story != nil {
		authored = c.Story.Areas
	}
	for _, a := range authored {
		a.Files = []string{}
		a.Lines = 0
		areas = append(areas, a)
	}
	roles := map[string]int{}
	labels := map[string]string{"test": "Tests", "generated": "Generated", "docs": "Docs", "config": "Config", "implementation": "Other"}
	for _, file := range c.Files {
		index := -1
		for i, a := range authored {
			for _, pattern := range a.Files {
				if areaMatch(pattern, file.Path) {
					index = i
					break
				}
			}
			if index >= 0 {
				break
			}
		}
		if index < 0 {
			var ok bool
			index, ok = roles[file.Role]
			if !ok {
				index = len(areas)
				roles[file.Role] = index
				areas = append(areas, ChangeArea{Name: labels[file.Role], Role: file.Role, Files: []string{}})
			}
		}
		areas[index].Files = append(areas[index].Files, file.Path)
		areas[index].Lines += file.Additions + file.Deletions
	}
	result := []ChangeArea{}
	for _, a := range areas {
		if len(a.Files) > 0 {
			result = append(result, a)
		}
	}
	return result
}
