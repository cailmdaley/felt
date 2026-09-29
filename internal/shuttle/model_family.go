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
// release of that family the host's CLI lists — "gpt-6.1-sol" today, whatever
// ships next without a registry edit. Codex agents read the Codex CLI's model
// catalog ($CODEX_HOME/models_cache.json); Pi agents read Pi's per-provider
// catalog ($PI_CODING_AGENT_DIR/models-store.json). The highest version in the
// family wins. With no catalog, or no release of the family in it, the family
// name passes through unchanged.
var bareFamily = regexp.MustCompile(`^gpt-([a-z]+)$`)
var familyRelease = regexp.MustCompile(`^gpt-(\d+(?:\.\d+)*)-([a-z]+)$`)

func resolveModelFamily(rec AgentRecord) string {
	m := bareFamily.FindStringSubmatch(rec.Model)
	if m == nil {
		return rec.Model
	}
	var slugs []string
	switch rec.CLI {
	case "codex":
		slugs = codexCatalog()
	case "pi":
		slugs = piCatalog(rec.Provider)
	}
	if best := newestRelease(m[1], slugs); best != "" {
		return best
	}
	return rec.Model
}

func homeDir(env, rel string) string {
	if d := os.Getenv(env); d != "" {
		return d
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(h, rel)
}

func codexCatalog() []string {
	data, err := os.ReadFile(filepath.Join(homeDir("CODEX_HOME", ".codex"), "models_cache.json"))
	if err != nil {
		return nil
	}
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &cache) != nil {
		return nil
	}
	var out []string
	for _, m := range cache.Models {
		if m.Visibility == "list" {
			out = append(out, m.Slug)
		}
	}
	return out
}

func piCatalog(provider string) []string {
	data, err := os.ReadFile(filepath.Join(homeDir("PI_CODING_AGENT_DIR", ".pi/agent"), "models-store.json"))
	if err != nil {
		return nil
	}
	var store map[string]struct {
		Models []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &store) != nil {
		return nil
	}
	var out []string
	for _, m := range store[provider].Models {
		out = append(out, m.ID)
	}
	return out
}

func newestRelease(family string, slugs []string) string {
	best, bestVer := "", []int(nil)
	for _, slug := range slugs {
		r := familyRelease.FindStringSubmatch(slug)
		if r == nil || r[2] != family {
			continue
		}
		var ver []int
		for _, p := range strings.Split(r[1], ".") {
			n, _ := strconv.Atoi(p)
			ver = append(ver, n)
		}
		if best == "" || versionLess(bestVer, ver) {
			best, bestVer = slug, ver
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
