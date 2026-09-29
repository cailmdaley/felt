package shuttle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// A registry model written as a bare family ("gpt-sol") names the newest
// listed release of that family — "gpt-6.1-sol" today, whatever ships next
// without a registry edit. The Codex CLI keeps its catalog of listed models in
// $CODEX_HOME/models_cache.json; the highest version in the family wins. With
// no catalog, or no release of the family in it, the family name passes
// through unchanged.
var bareFamily = regexp.MustCompile(`^gpt-([a-z]+)$`)
var familyRelease = regexp.MustCompile(`^gpt-(\d+(?:\.\d+)*)-([a-z]+)$`)

func resolveModelFamily(rec AgentRecord) string {
	if rec.CLI != "codex" && rec.Provider != "openai-codex" {
		return rec.Model
	}
	m := bareFamily.FindStringSubmatch(rec.Model)
	if m == nil {
		return rec.Model
	}
	if best := newestRelease(m[1]); best != "" {
		return best
	}
	return rec.Model
}

func newestRelease(family string) string {
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = filepath.Join(h, ".codex")
	}
	data, err := os.ReadFile(filepath.Join(home, "models_cache.json"))
	if err != nil {
		return ""
	}
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &cache) != nil {
		return ""
	}
	best, bestVer := "", []int(nil)
	for _, mod := range cache.Models {
		r := familyRelease.FindStringSubmatch(mod.Slug)
		if r == nil || r[2] != family || mod.Visibility != "list" {
			continue
		}
		var ver []int
		for _, p := range strings.Split(r[1], ".") {
			n, _ := strconv.Atoi(p)
			ver = append(ver, n)
		}
		if best == "" || versionLess(bestVer, ver) {
			best, bestVer = mod.Slug, ver
		}
	}
	return best
}

func versionLess(a, b []int) bool {
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x < y
		}
	}
	return false
}
