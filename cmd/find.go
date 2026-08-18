package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	findStatus    string
	findTags      []string
	findBody      bool
	findExact     bool
	findRegex     bool
	findHasFields []string
	findVerbose   bool
	findLimit     int
)

// findOuterCap is how many collapsed outer entries print before the remainder
// line takes over. A loom holds thousands of fibers; a query that matches
// hundreds of them is a query to refine, not a wall to scroll.
const findOuterCap = 20

var findCmd = &cobra.Command{
	Use:   "find [query]",
	Short: "Search the whole store, across the view boundary",
	Long: `Searches every fiber in the store, not just this view.

felt ls lists the view; felt find searches the store. When this project's
.felt is mounted inside a larger store (a loom), find searches both: local
hits print first under their local ids, then the rest of the store under a
separator naming it, each by its full id there. Those outer ids work as
arguments here — felt show, edit, rm, shuttle all act on the fiber where it
lives. In a top-level store find is simply a search of that store.

Matching is ls's: name, outcome, additional YAML field text, and fiber id.

  felt find kanban            substring search
  felt find -r "rule:.*data"  regex search
  felt find -e exact-slug     exact name or id match
  felt find -t bug            tag filter (AND logic, trailing colon for prefix)
  felt find --body leakage    also search fiber bodies

A filter widens the search to every status except closed; closed matches are
counted in a trailing hint instead of printed. Use -s to override: open,
active, closed, or all.

Matches collapse by containment — a hit whose ancestor also matched is folded
into that ancestor, which carries a count of what it swallowed; -v lists every
match flat. The outer block is capped at 20 entries, with an exact count of
the remainder; -n sets another cap, or 0 for all of them.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}
		storage := felt.NewStorage(root)

		query := ""
		if len(args) == 1 {
			query = args[0]
		}
		hasFields := splitListFlag(findHasFields)
		statusExplicit := cmd.Flags().Changed("status")
		hasFilters := len(findTags) > 0 || len(hasFields) > 0 || query != ""
		if !hasFilters {
			return fmt.Errorf("find needs something to search for: a query, -t, or --has-field (felt ls lists this view)")
		}

		search, err := compileSearch(query, findStatus, !statusExplicit && hasFilters,
			findTags, hasFields, findExact, findRegex, findBody, findVerbose)
		if err != nil {
			return err
		}
		suppressClosed := !statusExplicit

		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}
		shown, collapsed, closedSuppressed, err := search.run(storage, felts, suppressClosed)
		if err != nil {
			return err
		}

		outerShown, outerCollapsed, outerRoot, outerClosed, err := findOuterHits(storage, search, suppressClosed)
		if err != nil {
			return err
		}
		closedSuppressed += outerClosed

		if len(shown) == 0 && len(outerShown) == 0 {
			if query != "" {
				fmt.Printf("No felts matching %q\n", query)
			} else {
				fmt.Println("No felts found")
			}
		}
		for _, f := range shown {
			fmt.Print(formatFeltTwoLine(f, collapsed[f.ID]))
		}

		if len(outerShown) > 0 {
			if len(shown) > 0 {
				fmt.Println()
			}
			fmt.Printf("── elsewhere in %s ──\n", outerRoot)
			limit := findLimit
			printed := outerShown
			if limit > 0 && len(printed) > limit {
				printed = printed[:limit]
			}
			for _, f := range printed {
				fmt.Print(formatFeltTwoLine(f, outerCollapsed[f.ID]))
			}
			if remainder := len(outerShown) - len(printed); remainder > 0 {
				fmt.Printf("… %d more — refine the query or pass -n 0\n", remainder)
			}
		}

		if closedSuppressed > 0 {
			fmt.Printf("\n(+%d closed — add -s closed)\n", closedSuppressed)
		}
		return nil
	},
}

// findOuterHits runs the same predicate against the enclosing store, minus
// this store's own subtree — those fibers are already in the local block, and
// printing them twice under two different ids is worse than not printing them
// at all. A top-level store has no enclosing one and returns nothing.
func findOuterHits(storage *felt.Storage, search lsSearch, suppressClosed bool) ([]*felt.Felt, map[string]int, string, int, error) {
	external := storage.ExternalRefs()
	if external == nil {
		return nil, nil, "", 0, nil
	}
	outerStorage := felt.NewStorage(external.ProjectDir())
	felts, err := outerStorage.ListMetadata()
	if err != nil {
		return nil, nil, "", 0, err
	}

	prefix := external.Prefix()
	outside := make([]*felt.Felt, 0, len(felts))
	for _, f := range felts {
		if f.ID == prefix || strings.HasPrefix(f.ID, prefix+"/") {
			continue
		}
		outside = append(outside, f)
	}

	shown, collapsed, closed, err := search.run(outerStorage, outside, suppressClosed)
	if err != nil {
		return nil, nil, "", 0, err
	}
	return shown, collapsed, external.Root(), closed, nil
}

func init() {
	rootCmd.AddCommand(findCmd)
	findCmd.Flags().StringVarP(&findStatus, "status", "s", "", "Filter by status (open, active, closed, all)")
	findCmd.Flags().StringArrayVarP(&findTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic; trailing colon for prefix match)")
	findCmd.Flags().BoolVar(&findBody, "body", false, "Include fiber bodies in the search")
	findCmd.Flags().BoolVarP(&findExact, "exact", "e", false, "Exact name or id match only")
	findCmd.Flags().BoolVarP(&findRegex, "regex", "r", false, "Treat query as regular expression")
	findCmd.Flags().StringArrayVar(&findHasFields, "has-field", nil, "Filter to fibers with this top-level frontmatter field (repeatable or comma-separated)")
	findCmd.Flags().BoolVarP(&findVerbose, "verbose", "v", false, "List every match flat, without collapsing matches under a matching ancestor")
	findCmd.Flags().IntVarP(&findLimit, "limit", "n", findOuterCap, "Cap on entries printed from the enclosing store (0 = no cap)")
}
