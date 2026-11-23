package feltcli

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

func (a *app) renameCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "rename <id> <new-slug>",
		Short: "Change a fiber's basename, carrying descendants and links",
		Long: `Renames the directory and its fiber document, preserving the intrinsic id.
References are rewritten as with nest, including across the enclosing store:
the store this one is linked into, or, in a repository a larger store links
in, the store named by git config felt.enclosing.
The new slug is one path segment following the slug convention: lowercase
letters and digits joined by single hyphens; any other is refused with its
conforming form. The fiber being renamed may have any slug. Guessed ids and
existing destinations are refused. Project-specific frontmatter is preserved without interpretation.

Remaining occurrences of the old path are listed for manual review, not changed.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug := args[1]
			storage, root, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			if handled, err := a.retryMove(storage, args, true); handled {
				return err
			}
			if err := felt.CheckSlug(slug); err != nil {
				return err
			}
			ref, err := felt.ResolveExactRef(storage, felt.CommandScope(a.env, root, a.dir), args[0])
			if err != nil {
				return err
			}
			oldID, _, where := liftPair(storage, ref, ref)
			// The enclosing namespace also resolves repository-local spellings
			// in a linked repository, even from a view below its root.
			if ext := storage.ExternalRefs(); ext != nil && !ref.Elsewhere {
				oldID = path.Join(ext.Prefix(), oldID)
				where = felt.Ref{Storage: felt.NamespaceStorage(storage), Elsewhere: true, EnclosingRoot: ext.Root()}
			}
			target := path.Join(felt.ParentPath(oldID), slug)
			if err := where.Storage.CheckAvailableID(target); err != nil {
				return err
			}
			result, err := where.Storage.MoveSubtree(oldID, target)
			if err != nil {
				if result != nil {
					a.printRewrittenRefs(where.Storage, result)
				}
				return err
			}
			fmt.Fprintf(a.env.Stdout, "Renamed %s to %s%s\n", oldID, target, where.Location())
			a.printEnclosingWarnings(storage)
			a.printRewrittenRefs(where.Storage, result)
			return a.printRemainingPaths(where.Storage, oldID)
		},
	}
	command.GroupID = groupFibers
	return command
}

func (a *app) finishRename(storage *felt.Storage, oldID, newID string) error {
	fmt.Fprintf(a.env.Stdout, "Renamed %s to %s\n", oldID, newID)
	return a.printRemainingPaths(storage, oldID)
}

func (a *app) printRemainingPaths(storage *felt.Storage, oldID string) error {
	// Search the same enclosing namespace that participated in link rewriting.
	fullOld := oldID
	if ext := storage.ExternalRefs(); ext != nil {
		storage = felt.NewStorage(filepath.Dir(ext.Root()))
		fullOld = path.Join(ext.Prefix(), oldID)
	}
	spellings := []string{oldID}
	// A repository linked into this store also writes ids in its own namespace.
	parts := strings.Split(oldID, "/")
	for i := 1; i < len(parts); i++ {
		prefix := filepath.Join(storage.Root(), filepath.FromSlash(strings.Join(parts[:i], "/")))
		if info, err := os.Lstat(prefix); err == nil && info.Mode()&os.ModeSymlink != 0 {
			spellings = append(spellings, strings.Join(parts[i:], "/"))
		}
	}
	patterns := make([]*regexp.Regexp, 0, len(spellings))
	for _, spelling := range spellings {
		patterns = append(patterns, remainingPathPattern(spelling))
	}
	fibers, err := storage.List()
	if err != nil {
		return err
	}
	for _, f := range fibers {
		data, err := os.ReadFile(f.Path)
		if err != nil {
			return err
		}
		matches := slices.ContainsFunc(patterns, func(p *regexp.Regexp) bool { return p.Match(data) })
		// A path relative to the fiber's own document, ../x from a sibling,
		// names the old directory too.
		if rel, err := filepath.Rel(felt.DocumentDir(f), fullOld); !matches && err == nil && strings.HasPrefix(filepath.ToSlash(rel), "../") {
			matches = remainingPathPattern(filepath.ToSlash(rel)).Match(data)
		}
		if matches {
			fmt.Fprintf(a.env.Stdout, "Old path remains in %s (manual review)\n", f.ID)
		}
	}
	return nil
}

// remainingPathPattern matches spelling where it stands as a whole path: not
// inside a longer name, nor after another path's segment, though a relative
// ./ or ../ before it, as in a markdown link, still counts.
func remainingPathPattern(spelling string) *regexp.Regexp {
	return regexp.MustCompile(`(?:^|[^\p{L}\p{N}_/-])(?:\.\.?/)*` + regexp.QuoteMeta(spelling) + `(?:$|[^\p{L}\p{N}_-])`)
}
