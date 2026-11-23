package felt

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
)

// EnclosingConfigKey is the git config key by which a repository whose store
// another store mounts names that enclosing store: its project directory or
// its `.felt`. It may be given more than once; `~` expands.
const EnclosingConfigKey = "felt.enclosing"

// configuredEnclosingStore finds the enclosing store of storeRoot, a store no
// link leads out of, from felt.enclosing in the repository that holds it. A
// configured store counts only if a symlink inside it (directly or through
// nested mounted repositories) resolves to this store; the first that does is
// the enclosing store and the link's logical position in it is the prefix.
// Configured paths that do not mount this store are skipped and returned as
// warnings for CLI callers to surface on stderr.
func configuredEnclosingStore(storeRoot string) (root, prefix string, ok bool, warnings []string) {
	real, err := filepath.EvalSymlinks(storeRoot)
	if err != nil {
		return "", "", false, nil
	}
	out, _ := exec.Command("git", "-C", real, "config", "--get-all", "--path", EnclosingConfigKey).Output()
	for _, value := range strings.Split(string(out), "\n") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if !filepath.IsAbs(value) {
			value = filepath.Join(filepath.Dir(real), value)
		}
		if root, prefix, found := mountIn(value, real); found {
			return root, prefix, true, warnings
		}
		warnings = append(warnings, fmt.Sprintf("%s %s does not mount %s by a symlink; ignoring it", EnclosingConfigKey, value, storeRoot))
	}
	return "", "", false, warnings
}

// mountIn looks inside the store at enclosing, a project directory or its
// `.felt`, for a symlink (directly or inside a nested mounted store) that
// resolves to storeReal, the resolved root of the mounted store. The walk
// tracks visited physical directories to prevent symlink cycles and skips
// `.git`; the enclosing store itself is never its own mount. root is reported
// as enclosingStore reports it, with its parent directory resolved.
func mountIn(enclosing, storeReal string) (root, prefix string, ok bool) {
	dir := filepath.Clean(enclosing)
	if filepath.Base(dir) != DirName {
		dir = filepath.Join(dir, DirName)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(dir))
	if err != nil {
		return "", "", false
	}
	root = filepath.Join(parent, DirName)
	walked, err := filepath.EvalSymlinks(root)
	if err != nil || walked == storeReal || !looksLikeStore(walked) {
		return "", "", false
	}
	visited := map[string]bool{walked: true}
	var walk func(dir, logicalPrefix string) (string, bool)
	walk = func(dir, logicalPrefix string) (string, bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return "", false
		}
		for _, entry := range entries {
			name := entry.Name()
			if name == ".git" {
				continue
			}
			child := filepath.Join(dir, name)
			logical := path.Join(logicalPrefix, name)
			if entry.Type()&fs.ModeSymlink != 0 {
				target, err := filepath.EvalSymlinks(child)
				if err != nil {
					continue
				}
				if target == storeReal {
					return logical, true
				}
				if info, err := os.Stat(target); err == nil && info.IsDir() && !visited[target] {
					visited[target] = true
					if found, ok := walk(target, logical); ok {
						return found, true
					}
				}
				continue
			}
			if entry.IsDir() {
				if found, ok := walk(child, logical); ok {
					return found, true
				}
			}
		}
		return "", false
	}
	prefix, ok = walk(walked, "")
	return root, prefix, ok
}
