package felt

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// EnclosingConfigKey is the git config key by which a repository whose store
// another store mounts names that enclosing store: its project directory or
// its `.felt`. It may be given more than once; `~` expands.
const EnclosingConfigKey = "felt.enclosing"

// configuredEnclosingStore finds the enclosing store of storeRoot, a store no
// link leads out of, from felt.enclosing in the repository that holds it. A
// configured store counts only if a symlink inside it resolves to this store;
// the first that does is the enclosing store and the link's position in it is
// the prefix. A configured path that mounts nothing is reported and skipped,
// so a stale entry never makes an unrelated store this one's namespace.
func configuredEnclosingStore(storeRoot string) (root, prefix string, ok bool) {
	real, err := filepath.EvalSymlinks(storeRoot)
	if err != nil {
		return "", "", false
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
		if root, prefix, ok := mountIn(value, real); ok {
			return root, prefix, true
		}
		warnUnmounted(value, storeRoot)
	}
	return "", "", false
}

// mountIn looks inside the store at enclosing, a project directory or its
// `.felt`, for a symlink that resolves to storeReal, the resolved root of the
// mounted store. The walk follows no links and skips `.git`; the enclosing
// store itself is never its own mount. root is reported as enclosingStore
// reports it, with its parent directory resolved.
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
	_ = filepath.WalkDir(walked, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.Type()&fs.ModeSymlink == 0 {
			return nil
		}
		if target, err := filepath.EvalSymlinks(p); err == nil && target == storeReal {
			rel, _ := filepath.Rel(walked, p)
			prefix = filepath.ToSlash(rel)
			return fs.SkipAll
		}
		return nil
	})
	return root, prefix, prefix != ""
}

// unmountedWarned keeps each stale felt.enclosing warning to once a process,
// however many Storage values open the store.
var unmountedWarned sync.Map

func warnUnmounted(enclosing, storeRoot string) {
	if _, seen := unmountedWarned.LoadOrStore(enclosing+"\x00"+storeRoot, true); seen {
		return
	}
	fmt.Fprintf(os.Stderr, "warning: %s %s does not mount %s by a symlink; ignoring it\n", EnclosingConfigKey, enclosing, storeRoot)
}
