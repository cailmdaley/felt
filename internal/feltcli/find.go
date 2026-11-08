package feltcli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// findOuterCap is how many collapsed outer entries print before the remainder
// line takes over. A loom holds thousands of fibers; a query that matches
// hundreds of them is a query to refine, not a wall to scroll.
const findOuterCap = 20

func (a *app) findCmd() *cobra.Command {
	var q FindQuery
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

Plain queries search bodies by default, placing name/slug hits before metadata
hits and marking body-dependent hits; --no-body restores the metadata-only scope.

--json is one array with a "store" field on each fiber, every match and status
included; --limit caps it only when given.

shuttle find runs this same search and adds session transcripts.`,
		Example: `  felt find covariance
  felt find -t rule: -r "data|vector"`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				q.Query = args[0]
			}
			q.Changed(cmd)
			result, err := Find(a.env, a.dir, q, a.json)
			if err != nil {
				return err
			}
			if a.json {
				return a.outputJSON(result.Hits())
			}
			result.Write(a.env.Stdout)
			return nil
		},
	}
	command.GroupID = groupSearch
	AddFindFlags(command, &q)
	return command
}

// FindQuery is one fiber search over a whole store, as felt find takes it.
// shuttle find binds the same flags with AddFindFlags and runs the same Find.
type FindQuery struct {
	Query          string
	Status         string
	StatusExplicit bool
	Tags           []string
	HasFields      []string
	Body           bool
	NoBody         bool
	Exact          bool
	Regex          bool
	Verbose        bool
	Limit          int
	LimitExplicit  bool
}

// AddFindFlags binds find's fiber-search flags to q.
func AddFindFlags(command *cobra.Command, q *FindQuery) {
	flags := command.Flags()
	flags.StringVarP(&q.Status, "status", "s", "", "Filter by status (open, active, closed, all)")
	flags.StringArrayVarP(&q.Tags, "tag", "t", nil, "Filter by tag (repeatable, AND; a trailing colon matches a prefix)")
	flags.BoolVar(&q.Body, "body", false, "With --json, include bodies in results; body search is the default")
	flags.BoolVar(&q.NoBody, "no-body", false, "Search only names and metadata")
	flags.BoolVarP(&q.Exact, "exact", "e", false, "Only exact matches: name, id, or id basename, ignoring case")
	flags.BoolVarP(&q.Regex, "regex", "r", false, "Treat the query as a case-insensitive regular expression")
	flags.StringArrayVar(&q.HasFields, "has-field", nil, "Only fibers that have this top-level field (repeatable or comma-separated)")
	flags.BoolVarP(&q.Verbose, "verbose", "v", false, "List every match flat, without collapsing matches under a matching ancestor")
	// Long-only on purpose: ls's -n is --recent, and one letter meaning two
	// different things across two sibling search verbs is a trap.
	flags.IntVar(&q.Limit, "limit", findOuterCap, "Cap on entries printed from the enclosing store (0 = no cap)")
}

// Changed records which of q's flags the caller set explicitly.
func (q *FindQuery) Changed(command *cobra.Command) {
	q.StatusExplicit = command.Flags().Changed("status")
	q.LimitExplicit = command.Flags().Changed("limit")
}

// FindResult is a completed fiber search: the local view's matches, then the
// enclosing store's.
type FindResult struct {
	query            string
	jsonMode         bool
	limit            int
	limitExplicit    bool
	local            findBlock
	outer            findBlock
	closedSuppressed int
}

type findBlock struct {
	shown     []*felt.Felt
	collapsed map[string]int
	bodyOnly  map[string]bool
	store     string
}

// Find runs q against the store that dir resolves to. jsonMode keeps every
// status and match, the wire form; otherwise closed matches are counted.
func Find(env *sysenv.Env, dir string, q FindQuery, jsonMode bool) (*FindResult, error) {
	storage, _, err := felt.RequireStore(env, dir)
	if err != nil {
		return nil, err
	}
	query := ""
	if q.Query != "" {
		query = plainQuery(q.Query, q.Regex)
	}
	hasFields := splitListFlag(q.HasFields)
	if len(q.Tags) == 0 && len(hasFields) == 0 && query == "" {
		return nil, fmt.Errorf("find needs something to search for: a query, -t, or --has-field (felt ls lists this view)")
	}
	search, err := compileSearch(query, q.Status, !q.StatusExplicit, q.Tags, hasFields, nil, q.Exact, q.Regex, !q.NoBody, q.Verbose)
	if err != nil {
		return nil, err
	}
	// --json is a wire: it carries every status the filter asked for and
	// every match found, so machine consumers never have to guess what a
	// human-facing trim removed.
	suppressClosed := !q.StatusExplicit && !jsonMode

	bodiesLoaded := search.readsBodies()
	felts, err := listForSearch(storage, nil, jsonMode, search)
	if err != nil {
		return nil, err
	}
	shown, collapsed, bodyOnly, closedSuppressed, err := search.run(storage, felts, suppressClosed, bodiesLoaded)
	if err != nil {
		return nil, err
	}
	if jsonMode && q.Body && !bodiesLoaded {
		if shown, err = hydrateBodies(storage, shown); err != nil {
			return nil, err
		}
	}
	outerShown, outerCollapsed, outerBodyOnly, outerRoot, outerClosed, err := findOuterHits(storage, search, suppressClosed, jsonMode, q.Body)
	if err != nil {
		return nil, err
	}
	result := &FindResult{
		query:            query,
		jsonMode:         jsonMode,
		limit:            q.Limit,
		limitExplicit:    q.LimitExplicit,
		local:            findBlock{shown, collapsed, bodyOnly, storage.Root()},
		outer:            findBlock{outerShown, outerCollapsed, outerBodyOnly, outerRoot},
		closedSuppressed: closedSuppressed + outerClosed,
	}
	// Bodies participate in matching by default, but are an output opt-in.
	if jsonMode && !q.Body {
		for _, block := range []findBlock{result.local, result.outer} {
			for _, f := range block.shown {
				f.Body = ""
			}
		}
	}
	return result, nil
}

// Hits is the --json answer: local hits, then the enclosing store's, each
// carrying the store that holds it.
func (r *FindResult) Hits() []FindHit {
	outer := limitOuter(r.outer.shown, r.limit, r.limitExplicit)
	hits := make([]FindHit, 0, len(r.local.shown)+len(outer))
	for _, f := range r.local.shown {
		hits = append(hits, FindHit{Felt: f, Store: r.local.store})
	}
	for _, f := range outer {
		hits = append(hits, FindHit{Felt: f, Store: r.outer.store})
	}
	return hits
}

// Write prints the human form.
func (r *FindResult) Write(w io.Writer) {
	shown, outerShown := r.local.shown, r.outer.shown
	if len(shown) == 0 && len(outerShown) == 0 {
		if r.query != "" {
			fmt.Fprintf(w, "No fibers matching %q\n", r.query)
		} else {
			fmt.Fprintln(w, "No fibers found")
		}
	}
	for _, f := range shown {
		fmt.Fprint(w, formatFeltTwoLine(f, r.local.collapsed[f.ID], r.local.bodyOnly[f.ID]))
	}
	if len(outerShown) > 0 {
		if len(shown) > 0 {
			fmt.Fprintln(w)
			fmt.Fprintf(w, "── elsewhere in %s ──\n", r.outer.store)
		} else {
			// With no local hits the block introduces nothing, so it names
			// the store plainly rather than pointing "elsewhere" from nowhere.
			fmt.Fprintf(w, "── in %s ──\n", r.outer.store)
		}
		printed := limitOuter(outerShown, r.limit, true)
		for _, f := range printed {
			fmt.Fprint(w, formatFeltTwoLine(f, r.outer.collapsed[f.ID], r.outer.bodyOnly[f.ID]))
		}
		if remainder := len(outerShown) - len(printed); remainder > 0 {
			fmt.Fprintf(w, "… %d more — refine the query or pass --limit 0\n", remainder)
		}
	}
	if r.closedSuppressed > 0 {
		fmt.Fprintf(w, "\n(+%d closed — add -s closed)\n", r.closedSuppressed)
	}
}

// FindHit is one fiber in --json, carrying the store that holds it alongside
// the fiber's own fields. A merged array of these is the whole answer: local
// hits under their local ids, outer hits under their full outer ids, and
// `store` saying which coordinates each is in.
type FindHit struct {
	*felt.Felt
	Store string
}

// MarshalJSON splices `store` into the fiber's own JSON. Felt marshals itself
// (field order, omitempty, the shuttle facet), so embedding alone would let
// that method swallow the wrapper and drop the field entirely.
func (h FindHit) MarshalJSON() ([]byte, error) {
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
func findOuterHits(storage *felt.Storage, search lsSearch, suppressClosed, jsonMode, includeBody bool) ([]*felt.Felt, map[string]int, map[string]bool, string, int, error) {
	external := storage.ExternalRefs()
	if external == nil {
		return nil, nil, nil, "", 0, nil
	}
	outerStorage := felt.NewStorage(external.ProjectDir())
	bodiesLoaded := search.readsBodies()
	felts, err := listForSearch(outerStorage, nil, jsonMode, search)
	if err != nil {
		return nil, nil, nil, "", 0, err
	}

	prefix := external.Prefix()
	outside := make([]*felt.Felt, 0, len(felts))
	for _, f := range felts {
		if f.ID == prefix || strings.HasPrefix(f.ID, prefix+"/") {
			continue
		}
		outside = append(outside, f)
	}

	shown, collapsed, bodyOnly, closed, err := search.run(outerStorage, outside, suppressClosed, bodiesLoaded)
	if err != nil {
		return nil, nil, nil, "", 0, err
	}
	if jsonMode && includeBody && !bodiesLoaded {
		shown, err = hydrateBodies(outerStorage, shown)
		if err != nil {
			return nil, nil, nil, "", 0, err
		}
	}
	return shown, collapsed, bodyOnly, external.Root(), closed, nil
}
