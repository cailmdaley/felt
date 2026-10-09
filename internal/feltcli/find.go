package feltcli

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// findOuterCap is how many collapsed outer entries print before the remainder
// line takes over. A loom holds thousands of fibers; a query that matches
// hundreds of them is a query to refine, not a wall to scroll.
const findOuterCap = 20

func (a *app) findCmd() *cobra.Command {
	var findStatus string
	var findTags []string
	var findBody bool
	var findExact bool
	var findRegex bool
	var findHasFields []string
	var findVerbose bool
	var findLimit int
	command := &cobra.Command{
		Use:   "find [query]",
		Short: "Search the whole store, beyond this view",
		Long: `find runs ls's matching over the whole store. When this .felt is mounted
inside a larger store, local hits print first under their local ids, then the
rest of the store under a separator, each by its full id there; those ids work
as arguments to show, edit, nest, rm, and tree. In a top-level store find is a
plain search.

A query, -t, or --has-field is required. Every status is searched; closed
matches are counted rather than printed unless -s asks for them. Matches under
a matching ancestor fold into it (-v lists them flat), and --limit caps the
enclosing store's block.

--json is one array with a "store" field on each fiber, every match and status
included; --limit caps it only when given.`,
		Example: `  felt find covariance
  felt find -t rule: -r "data|vector"`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, _, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}

			query := ""
			if len(args) == 1 {
				query = plainQuery(args[0], findRegex)
			}
			hasFields := splitListFlag(findHasFields)
			statusExplicit := cmd.Flags().Changed("status")
			hasFilters := len(findTags) > 0 || len(hasFields) > 0 || query != ""
			if !hasFilters {
				return fmt.Errorf("find needs something to search for: a query, -t, or --has-field (felt ls lists this view)")
			}

			search, err := compileSearch(query, findStatus, !statusExplicit && hasFilters,
				findTags, hasFields, nil, findExact, findRegex, findBody, findVerbose)
			if err != nil {
				return err
			}
			// --json is a wire: it carries every status the filter asked for and
			// every match found, so machine consumers never have to guess what a
			// human-facing trim removed.
			suppressClosed := !statusExplicit && !a.json

			felts, err := listForOutput(storage, nil, a.json)
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

			if a.json {
				outer := limitOuter(outerShown, findLimit, cmd.Flags().Changed("limit"))
				hits := make([]findHit, 0, len(shown)+len(outer))
				for _, f := range shown {
					hits = append(hits, findHit{Felt: f, Store: storage.Root()})
				}
				for _, f := range outer {
					hits = append(hits, findHit{Felt: f, Store: outerRoot})
				}
				// --body hydrates only the fibers it had to read to match, so
				// without it the bodies present are an accident of the search.
				// Emit all of them or none.
				if !findBody {
					for _, hit := range hits {
						hit.Body = ""
					}
				}
				return a.outputJSON(hits)
			}

			if len(shown) == 0 && len(outerShown) == 0 {
				if query != "" {
					fmt.Fprintf(a.env.Stdout, "No fibers matching %q\n", query)
				} else {
					fmt.Fprintln(a.env.Stdout, "No fibers found")
				}
			}
			for _, f := range shown {
				fmt.Fprint(a.env.Stdout, formatFeltTwoLine(f, collapsed[f.ID]))
			}

			if len(outerShown) > 0 {
				if len(shown) > 0 {
					fmt.Fprintln(a.env.Stdout)
				}
				// With no local hits the block introduces nothing, so it names
				// the store plainly rather than pointing "elsewhere" from nowhere.
				if len(shown) > 0 {
					fmt.Fprintf(a.env.Stdout, "── elsewhere in %s ──\n", outerRoot)
				} else {
					fmt.Fprintf(a.env.Stdout, "── in %s ──\n", outerRoot)
				}
				printed := limitOuter(outerShown, findLimit, true)
				for _, f := range printed {
					fmt.Fprint(a.env.Stdout, formatFeltTwoLine(f, outerCollapsed[f.ID]))
				}
				if remainder := len(outerShown) - len(printed); remainder > 0 {
					fmt.Fprintf(a.env.Stdout, "… %d more — refine the query or pass --limit 0\n", remainder)
				}
			}

			if closedSuppressed > 0 {
				fmt.Fprintf(a.env.Stdout, "\n(+%d closed — add -s closed)\n", closedSuppressed)
			}
			return nil
		},
	}
	command.GroupID = groupSearch
	command.Flags().StringVarP(&findStatus, "status", "s", "", "Filter by status (open, active, closed, all)")
	command.Flags().StringArrayVarP(&findTags, "tag", "t", nil, "Filter by tag (repeatable, AND; a trailing colon matches a prefix)")
	command.Flags().BoolVar(&findBody, "body", false, "Also search bodies")
	command.Flags().BoolVarP(&findExact, "exact", "e", false, "Only exact matches: name, id, or id basename, ignoring case")
	command.Flags().BoolVarP(&findRegex, "regex", "r", false, "Treat the query as a case-insensitive regular expression")
	command.Flags().StringArrayVar(&findHasFields, "has-field", nil, "Only fibers that have this top-level field (repeatable or comma-separated)")
	command.Flags().BoolVarP(&findVerbose, "verbose", "v", false, "List every match flat, without collapsing matches under a matching ancestor")
	// Long-only on purpose: ls's -n is --recent, and one letter meaning two
	// different things across two sibling search verbs is a trap.
	command.Flags().IntVar(&findLimit, "limit", findOuterCap, "Cap on entries printed from the enclosing store (0 = no cap)")
	return command
}

// findHit is one fiber in --json, carrying the store that holds it alongside
// the fiber's own fields. A merged array of these is the whole answer: local
// hits under their local ids, outer hits under their full outer ids, and
// `store` saying which coordinates each is in.
type findHit struct {
	*felt.Felt
	Store string
}

// MarshalJSON splices `store` into the fiber's own JSON. Felt marshals itself
// (field order, omitempty, the shuttle facet), so embedding alone would let
// that method swallow the wrapper and drop the field entirely.
func (h findHit) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(h.Felt)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	store, err := json.Marshal(h.Store)
	if err != nil {
		return nil, err
	}
	fields["store"] = store
	return json.Marshal(fields)
}

// limitOuter trims the outer block to limit (--limit). apply is false for a wire that
// was not explicitly capped: a human reads the first screen, a machine wants
// the whole answer.
func limitOuter(outer []*felt.Felt, limit int, apply bool) []*felt.Felt {
	if !apply || limit <= 0 || len(outer) <= limit {
		return outer
	}
	return outer[:limit]
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
