package tapestry

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	markdownLinkRe = regexp.MustCompile(`\[[^\]]+\]\(([^)]+)\)`)
	inlineCodeRe   = regexp.MustCompile("`((?:\\.{1,2}/)?[\\w./-]+/[\\w.-]+\\.[A-Za-z]{1,10}(?::L?\\d+(?:-\\d+)?)?)`")
	codeRewriteRe  = regexp.MustCompile("`((?:\\.{1,2}/)?[\\w./-]+/[\\w.-]+\\.[A-Za-z]{1,10})((?::L?\\d+(?:-\\d+)?)?)`")
)

func findLinkedFiles(text string) []string {
	seen := map[string]struct{}{}
	files := []string{}
	add := func(raw string) {
		path, ok := normalizeLinkedFile(raw)
		if !ok {
			return
		}
		if _, exists := seen[path]; exists {
			return
		}
		seen[path] = struct{}{}
		files = append(files, path)
	}

	for _, match := range markdownLinkRe.FindAllStringSubmatch(text, -1) {
		add(match[1])
	}
	for _, match := range inlineCodeRe.FindAllStringSubmatch(text, -1) {
		add(match[1])
	}

	return files
}

func flatName(path string) string {
	clean := path
	for {
		switch {
		case strings.HasPrefix(clean, "./"):
			clean = strings.TrimPrefix(clean, "./")
		case strings.HasPrefix(clean, "../"):
			clean = strings.TrimPrefix(clean, "../")
		default:
			return strings.ReplaceAll(clean, "/", "_")
		}
	}
}

func copyLinkedFiles(projectRoot, outDir string, nodes []Node, fibers []Fiber, force bool) error {
	if err := os.MkdirAll(filepath.Join(outDir, "files"), 0755); err != nil {
		return fmt.Errorf("create linked files dir: %w", err)
	}

	rewriteMap := map[string]string{}
	collect := func(text string) error {
		for _, path := range findLinkedFiles(text) {
			if _, exists := rewriteMap[path]; exists {
				continue
			}

			src := filepath.Join(projectRoot, filepath.FromSlash(path))
			if _, err := os.Stat(src); err != nil {
				if !os.IsNotExist(err) {
					return fmt.Errorf("stat linked file %s: %w", path, err)
				}
				continue
			}

			name := flatName(path)
			dst := filepath.Join(outDir, "files", name)
			if force {
				if err := copyFile(src, dst); err != nil {
					return fmt.Errorf("copy linked file %s: %w", path, err)
				}
			} else {
				if _, err := os.Stat(dst); os.IsNotExist(err) {
					if err := copyFile(src, dst); err != nil {
						return fmt.Errorf("copy linked file %s: %w", path, err)
					}
				} else if err != nil {
					return fmt.Errorf("stat exported linked file %s: %w", path, err)
				}
			}
			rewriteMap[path] = filepath.ToSlash(filepath.Join("files", name))
		}
		return nil
	}

	for i := range nodes {
		if err := collect(nodes[i].Body); err != nil {
			return err
		}
		if err := collect(nodes[i].Outcome); err != nil {
			return err
		}
		nodes[i].Body = rewriteFileLinks(nodes[i].Body, rewriteMap)
		nodes[i].Outcome = rewriteFileLinks(nodes[i].Outcome, rewriteMap)
	}
	for i := range fibers {
		if err := collect(fibers[i].Body); err != nil {
			return err
		}
		if err := collect(fibers[i].Outcome); err != nil {
			return err
		}
		fibers[i].Body = rewriteFileLinks(fibers[i].Body, rewriteMap)
		fibers[i].Outcome = rewriteFileLinks(fibers[i].Outcome, rewriteMap)
	}

	return nil
}

func rewriteFileLinks(text string, rewriteMap map[string]string) string {
	rewritten := markdownLinkRe.ReplaceAllStringFunc(text, func(match string) string {
		parts := markdownLinkRe.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		filePath, lineSuffix, ok := splitLineRef(parts[1])
		if !ok {
			return match
		}
		target, exists := rewriteMap[filePath]
		if !exists {
			return match
		}
		return strings.Replace(match, parts[1], target+lineSuffix, 1)
	})

	return codeRewriteRe.ReplaceAllStringFunc(rewritten, func(match string) string {
		parts := codeRewriteRe.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		target, exists := rewriteMap[parts[1]]
		if !exists {
			return match
		}
		return "`" + target + parts[2] + "`"
	})
}

func normalizeLinkedFile(raw string) (string, bool) {
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return "", false
	}
	path, _, ok := splitLineRef(raw)
	if !ok {
		return "", false
	}
	return path, true
}

func splitLineRef(raw string) (string, string, bool) {
	path := raw
	lineSuffix := ""
	if idx := strings.LastIndex(raw, ":"); idx >= 0 {
		suffix := raw[idx:]
		if lineRefRe.MatchString(suffix) {
			path = raw[:idx]
			lineSuffix = suffix
		}
	}
	if !isLinkedFilePath(path) {
		return "", "", false
	}
	return path, lineSuffix, true
}

var lineRefRe = regexp.MustCompile(`^:L?\d+(?:-\d+)?$`)

func isLinkedFilePath(path string) bool {
	if !strings.Contains(path, "/") {
		return false
	}
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	if len(ext) < 2 || len(ext) > 11 {
		return false
	}
	for _, r := range ext[1:] {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}
