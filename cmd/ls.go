package cmd

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	lsStatus     string
	lsTags       []string
	lsRecent     int
	lsBody       bool
	lsExact      bool
	lsRegex      bool
	lsHasFields  []string
	lsJSONFields []string
	lsVerbose    bool
	treeDepth    int
)

// listForOutput lists fibers the way the active output mode needs them: --json
// carries mod times, and a --has filter that only names frontmatter keys is
// pushed into the walk so unrelated fibers skip a full YAML parse.
func listForOutput(storage *felt.Storage, hasFields []string) ([]*felt.Felt, error) {
	frontmatterFields, canPrefilter := frontmatterPrefilterFields(hasFields)
	prefilter := canPrefilter && len(frontmatterFields) > 0
	if jsonOutput {
		if prefilter {
			return storage.ListMetadataWithModTimeHavingFrontmatterFields(frontmatterFields)
		}
		return storage.ListMetadataWithModTime()
	}
	if prefilter {
		return storage.ListMetadataHavingFrontmatterFields(frontmatterFields)
	}
	return storage.ListMetadata()
}

var lsCmd = &cobra.Command{
	Use:   "ls [query]",
	Short: "List and search felts",
	Long: `Lists felts in THIS view, showing open and active by default.

felt ls lists the view; felt find searches the store. In a project store
mounted inside a larger one, ls never leaves the view — every flag below
filters this store's own listing, and stays fast. Use felt find to search the
whole enclosing store.

A filter (-t, query, --has-field) widens the search to every status except
closed; closed matches are counted in a trailing hint instead of printed.
-n shows all statuses, closed included — it ranks by closed-at. Use -s to
override: open, active, closed, or all.

Use -t to filter by tag (AND logic, prefix matching with trailing colon):
  -t rule:                    matches any rule:* tag
  -t rule:cosebis_data_vector exact tag match

Optional query searches name, outcome, additional YAML field text, and fiber id (slug):
  felt ls cosebis             substring search (name, outcome, frontmatter, and id)
  felt ls dj-rico             matches fibers whose id contains "dj-rico"
  felt ls -r "rule:.*data"    regex search (also applied to fiber id)
  felt ls -e "exact-slug"     exact name or exact id match

Use --body with query to include body search, and with --json to emit body text.

Query results collapse by containment: a match whose ancestor also matches is
folded into that ancestor, which carries a count of what it swallowed. Use -v to
list every match flat. --json is always uncollapsed.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := requireStore()
		if err != nil {
			return err
		}
		query := ""
		if len(args) == 1 {
			query = args[0]
		}
		hasFields := splitListFlag(lsHasFields)
		jsonFields := splitListFlag(lsJSONFields)
		if len(jsonFields) > 0 && !jsonOutput {
			return fmt.Errorf("--json-field requires --json")
		}

		felts, err := listForOutput(storage, hasFields)
		if err != nil {
			return err
		}

		// If any filter is active (tags, query, recent) and -s wasn't explicitly set,
		// widen to all statuses. Bare `felt ls` stays open+active (actionable view).
		statusExplicit := cmd.Flags().Changed("status")
		hasFilters := len(lsTags) > 0 || len(hasFields) > 0 || query != "" || lsRecent > 0

		// A search widens past open+active so untracked fibers can match, but a
		// store accumulates far more closed work than live work and the closed
		// matches bury the live ones. They're counted and offered instead of
		// printed. -n is exempt: it sorts by closed-at precisely to surface
		// what was recently finished.
		suppressClosed := !statusExplicit && lsRecent == 0 &&
			(query != "" || len(lsTags) > 0 || len(hasFields) > 0)

		search, err := compileSearch(query, lsStatus, !statusExplicit && hasFilters,
			lsTags, hasFields, lsExact, lsRegex, lsBody, lsVerbose)
		if err != nil {
			return err
		}
		exactMatches, rest, err := search.match(storage, felts)
		if err != nil {
			return err
		}
		filtered := append(exactMatches, rest...)

		if lsRecent > 0 {
			// Sort by most recent activity (closed-at for closed, created-at otherwise)
			sort.Slice(filtered, func(i, j int) bool {
				ti := filtered[i].CreatedAt
				if filtered[i].ClosedAt != nil {
					ti = *filtered[i].ClosedAt
				}
				tj := filtered[j].CreatedAt
				if filtered[j].ClosedAt != nil {
					tj = *filtered[j].ClosedAt
				}
				return ti.After(tj) // Most recent first
			})
			if len(filtered) > lsRecent {
				filtered = filtered[:lsRecent]
			}
		} else if query == "" {
			// Default: sort by creation time (skip for search results to preserve relevance)
			sort.Slice(filtered, func(i, j int) bool {
				return filtered[i].CreatedAt.Before(filtered[j].CreatedAt)
			})
		}

		if jsonOutput {
			if lsBody {
				filtered, err = hydrateBodies(storage, filtered)
				if err != nil {
					return err
				}
			} else {
				for _, f := range filtered {
					f.Body = ""
				}
			}
			// Resolve the shuttle: facet on any fiber that carries one, so the
			// daemon's poll (felt ls --json --json-field shuttle) gets the
			// resolved agent record + next_due alongside the flat block.
			if err := attachShuttleResolution(filtered...); err != nil {
				return err
			}
			if len(jsonFields) > 0 {
				projected, err := projectFeltsJSON(filtered, jsonFields)
				if err != nil {
					return err
				}
				return outputJSON(projected)
			}
			return outputJSON(filtered)
		}

		// Closed suppression is a human-output concern only: --json is the wire
		// the daemon poll, the hook, and the board read, and they expect every
		// status they asked for. Dropping closed happens after the JSON branch
		// has already returned, and before the collapse — so a collapsed
		// ancestor's descendant count counts only lines that would have printed.
		//
		// Containment collapse: a query that matches a directory fiber also
		// matches every descendant by slug, which buries the one hit worth
		// seeing under its whole subtree. Show the ancestor with a count.
		shown, filtered, collapsed, closedSuppressed := finish(filtered, exactMatches, suppressClosed, query != "" && !lsVerbose)

		if len(shown) == 0 {
			if query != "" {
				fmt.Printf("No felts matching %q\n", query)
			} else {
				fmt.Println("No felts found")
			}
		} else {
			for _, f := range shown {
				fmt.Print(formatFeltTwoLine(f, collapsed[f.ID]))
			}
		}

		if closedSuppressed > 0 {
			fmt.Printf("\n(+%d closed — add -s closed)\n", closedSuppressed)
		}

		// Show count of hidden fibers when the default filter is active
		if !statusExplicit && !hasFilters {
			hidden := len(felts) - len(filtered)
			if hidden > 0 {
				fmt.Printf("\n(%d more — use -s all to see everything)\n", hidden)
			}
		}

		// A filtered ls in a substore answers a narrower question than the one
		// that was probably asked: this view's fibers, not the store's. Say so
		// once, and name the verb that does search the store. A bare listing
		// is the question it looks like and needs no note. The check is one
		// memoized symlink-eval and an ancestor walk — no outer ids are read.
		if (hasFilters || statusExplicit) && !jsonOutput {
			if outerRoot, _, ok := storage.EnclosingStore(); ok {
				fmt.Printf("\n(view-local — `felt find` searches the whole store at %s)\n", outerRoot)
			}
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(lsCmd)
	lsCmd.Flags().StringVarP(&lsStatus, "status", "s", "", "Filter by status (open, active, closed, all)")
	lsCmd.Flags().StringArrayVarP(&lsTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic; trailing colon for prefix match)")
	lsCmd.Flags().IntVarP(&lsRecent, "recent", "n", 0, "Show N most recent (by closed-at or created-at)")
	lsCmd.Flags().BoolVar(&lsBody, "body", false, "Include body search for queries and body field in JSON output")
	lsCmd.Flags().BoolVarP(&lsExact, "exact", "e", false, "Exact name match only (with query)")
	lsCmd.Flags().BoolVarP(&lsRegex, "regex", "r", false, "Treat query as regular expression")
	lsCmd.Flags().StringArrayVar(&lsHasFields, "has-field", nil, "Filter to fibers with this top-level frontmatter/JSON field (repeatable or comma-separated)")
	lsCmd.Flags().StringArrayVar(&lsJSONFields, "json-field", nil, "With --json, emit only this top-level field (repeatable or comma-separated)")
	lsCmd.Flags().BoolVarP(&lsVerbose, "verbose", "v", false, "List every match flat, without collapsing matches under a matching ancestor")
}

// lsSearch is one compiled query: the flags and the regex, applied by apply()
// to a slice of fibers. It exists so the same predicate runs over this store's
// fibers (`felt ls`) and over the enclosing store's (`felt find`).
type lsSearch struct {
	query           string
	queryLower      string
	re              *regexp.Regexp
	effectiveStatus string
	hasFields       []string
	tags            []string
	exact           bool
	regex           bool
	body            bool
	verbose         bool
}

// compile builds the predicate from one invocation's flag values. Both ls and
// find call it, so the two verbs cannot drift in what a query means.
// widen asks for the every-status-but-closed reading a filter implies; the
// caller decides, because ls counts -n as a filter and find has no -n.
func compileSearch(query string, status string, widen bool, tags, hasFields []string, exact, regex, body, verbose bool) (lsSearch, error) {
	var re *regexp.Regexp
	if regex && query != "" {
		compiled, err := regexp.Compile("(?i)" + query)
		if err != nil {
			return lsSearch{}, fmt.Errorf("invalid regex: %w", err)
		}
		re = compiled
	}
	effectiveStatus := status
	if widen {
		effectiveStatus = "all"
	}
	return lsSearch{
		query:           query,
		queryLower:      strings.ToLower(query),
		re:              re,
		effectiveStatus: effectiveStatus,
		hasFields:       hasFields,
		tags:            tags,
		exact:           exact,
		regex:           regex,
		body:            body,
		verbose:         verbose,
	}, nil
}

// run applies the search to one store's fibers and returns what to print:
// exact matches first, containment-collapsed, with the closed matches
// partitioned out when the caller asks. It is the whole body of a search over
// a store, so ls and find print the same shape from the same code.
func (search lsSearch) run(storage *felt.Storage, felts []*felt.Felt, suppressClosed bool) (shown []*felt.Felt, collapsedCounts map[string]int, closed int, err error) {
	exactMatches, filtered, err := search.match(storage, felts)
	if err != nil {
		return nil, nil, 0, err
	}
	shown, _, collapsedCounts, closed = finish(append(exactMatches, filtered...), exactMatches, suppressClosed, !search.verbose)
	return shown, collapsedCounts, closed, nil
}

// match splits one store's fibers into the exact name matches (printed first)
// and the rest, reading bodies when --body asked for a body search.
func (search lsSearch) match(storage *felt.Storage, felts []*felt.Felt) (exact, rest []*felt.Felt, err error) {
	exact, rest, bodyCandidates := search.apply(felts)
	if search.query != "" && !search.exact && search.body && len(bodyCandidates) > 0 {
		rest, err = scanBodyMatches(storage, rest, bodyCandidates, search.re, search.queryLower, search.regex)
		if err != nil {
			return nil, nil, err
		}
	}
	return exact, rest, nil
}

// finish turns the matches into what prints: the closed ones partitioned out
// when the caller asks, then containment-collapsed. ls and find gate the
// collapse differently - a bare `-t` listing is never collapsed - so it is a
// parameter, not a property of the search.
func finish(matches, exact []*felt.Felt, suppressClosed, collapse bool) (shown, kept []*felt.Felt, collapsedCounts map[string]int, closed int) {
	if suppressClosed {
		matches, closed = partitionOutClosed(matches)
		exact, _ = partitionOutClosed(exact)
	}
	shown = matches
	if collapse {
		shown, collapsedCounts = collapseByContainment(matches, exact)
	}
	return shown, matches, collapsedCounts, closed
}

// apply splits felts into exact matches (printed first), ordinary matches,
// and — with --body — the fibers whose body still has to be read.
func (search lsSearch) apply(felts []*felt.Felt) (exactMatches, filtered, bodyCandidates []*felt.Felt) {
	query, queryLower, re, effectiveStatus, hasFields := search.query, search.queryLower, search.re, search.effectiveStatus, search.hasFields
	tags, exact, regex, body := search.tags, search.exact, search.regex, search.body
	for _, f := range felts {
		if effectiveStatus != "all" && effectiveStatus != "" {
			if f.Status != effectiveStatus {
				continue
			}
		} else if effectiveStatus == "" {
			// Default: open+active, must have status
			if !f.HasStatus() {
				continue
			}
			if f.Status != felt.StatusOpen && f.Status != felt.StatusActive {
				continue
			}
		}

		// AND logic across tags, prefix match supported.
		if len(tags) > 0 {
			hasAll := true
			for _, tag := range tags {
				if !f.HasTag(tag) {
					hasAll = false
					break
				}
			}
			if !hasAll {
				continue
			}
		}

		if len(hasFields) > 0 {
			hasAll := true
			for _, field := range hasFields {
				if !feltHasField(f, field) {
					hasAll = false
					break
				}
			}
			if !hasAll {
				continue
			}
		}

		if query != "" {
			nameLower := strings.ToLower(f.DisplayName())
			idLower := strings.ToLower(f.ID)

			// Exact match: name, full id, or id basename (sorted first; regex excluded)
			basenameLower := strings.ToLower(path.Base(f.ID))
			if !regex && (nameLower == queryLower || idLower == queryLower || basenameLower == queryLower) {
				exactMatches = append(exactMatches, f)
				continue
			}

			if exact {
				continue
			}

			if matchesQuery(f, queryLower, re, regex) {
				filtered = append(filtered, f)
				continue
			}

			if body {
				bodyCandidates = append(bodyCandidates, f)
				continue
			}

			continue // no match
		}

		filtered = append(filtered, f)
	}
	return exactMatches, filtered, bodyCandidates
}

// collapseByContainment folds matches that live under another match into their
// shallowest matching ancestor. Because `felt ls` searches the slug, a query
// naming a directory fiber matches its entire subtree; without this a one-fiber
// question comes back as a hundred lines. Returns the fibers to print (in the
// order given) and a per-ancestor count of what it swallowed.
//
// Exact matches are never suppressed — they're the most likely target of the
// query, and they sort first for exactly that reason.
func collapseByContainment(matches []*felt.Felt, exact []*felt.Felt) ([]*felt.Felt, map[string]int) {
	matched := make(map[string]bool, len(matches))
	for _, f := range matches {
		matched[f.ID] = true
	}
	pinned := make(map[string]bool, len(exact))
	for _, f := range exact {
		pinned[f.ID] = true
	}

	// shallowestMatchingAncestor is the fiber a suppressed match is counted
	// against: the topmost match on its ancestor chain, which by construction
	// has no match above it and so is itself shown.
	shallowest := func(id string) string {
		found := ""
		for parent := felt.ParentPath(id); parent != ""; parent = felt.ParentPath(parent) {
			if matched[parent] {
				found = parent
			}
		}
		return found
	}

	shown := make([]*felt.Felt, 0, len(matches))
	collapsed := make(map[string]int)
	for _, f := range matches {
		if pinned[f.ID] {
			shown = append(shown, f)
			continue
		}
		if ancestor := shallowest(f.ID); ancestor != "" {
			collapsed[ancestor]++
			continue
		}
		shown = append(shown, f)
	}
	return shown, collapsed
}

// partitionOutClosed returns the non-closed matches (order preserved) and the
// number of closed ones dropped.
func partitionOutClosed(matches []*felt.Felt) ([]*felt.Felt, int) {
	kept := make([]*felt.Felt, 0, len(matches))
	dropped := 0
	for _, f := range matches {
		if f.Status == felt.StatusClosed {
			dropped++
			continue
		}
		kept = append(kept, f)
	}
	return kept, dropped
}

func splitListFlag(values []string) []string {
	var out []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// nativeFieldSpec describes one native top-level field as addressed by the
// --has-field / --json-field selectors. accessor returns the JSON value and
// whether the field is present; the same predicate drives feltHasField.
//
// prefilterable=false means the field cannot be answered from the lightweight
// frontmatter prefilter (it needs a full read or is derived), so any --has-field
// query touching it disables the prefilter. prefilterKey is the frontmatter key
// to gate on when prefilterable=true and the key differs from the canonical
// field name (empty prefilterKey with prefilterable=true means "no gate needed",
// e.g. id, which every discovered fiber has).
type nativeFieldSpec struct {
	accessor      func(f *felt.Felt) (any, bool)
	prefilterKey  string
	prefilterable bool
}

// nativeFields is the single source of truth for the --has-field / --json-field
// field-name aliases. feltHasField, feltJSONField, and frontmatterPrefilterFields
// are thin adapters over it.
var nativeFields = map[string]nativeFieldSpec{
	"id": {accessor: func(f *felt.Felt) (any, bool) { return f.ID, true }, prefilterable: true}, // slug, always present for a discovered fiber

	"uid":            {accessor: feltUIDValue, prefilterKey: "id", prefilterable: true},
	"ulid":           {accessor: feltUIDValue, prefilterKey: "id", prefilterable: true},
	"frontmatter_id": {accessor: feltUIDValue, prefilterKey: "id", prefilterable: true},
	"frontmatter-id": {accessor: feltUIDValue, prefilterKey: "id", prefilterable: true},
	"name":           {accessor: func(f *felt.Felt) (any, bool) { return f.Name, f.Name != "" }, prefilterKey: "name", prefilterable: true},
	"status":         {accessor: func(f *felt.Felt) (any, bool) { return f.Status, f.Status != "" }, prefilterKey: "status", prefilterable: true},
	"tags":           {accessor: func(f *felt.Felt) (any, bool) { return f.Tags, len(f.Tags) > 0 }, prefilterKey: "tags", prefilterable: true},
	"created_at":     {accessor: feltCreatedAtValue, prefilterKey: "created-at", prefilterable: true},
	"created-at":     {accessor: feltCreatedAtValue, prefilterKey: "created-at", prefilterable: true},
	"closed_at":      {accessor: feltClosedAtValue, prefilterKey: "closed-at", prefilterable: true},
	"closed-at":      {accessor: feltClosedAtValue, prefilterKey: "closed-at", prefilterable: true},
	"outcome":        {accessor: func(f *felt.Felt) (any, bool) { return f.Outcome, f.Outcome != "" }, prefilterKey: "outcome", prefilterable: true},
	"due":            {accessor: func(f *felt.Felt) (any, bool) { return f.Due, f.Due != nil }, prefilterKey: "due", prefilterable: true},
	"description":    {accessor: func(f *felt.Felt) (any, bool) { return f.Description, f.Description != "" }, prefilterKey: "description", prefilterable: true},
	"body":           {accessor: func(f *felt.Felt) (any, bool) { return f.Body, f.Body != "" }, prefilterable: false},
	"modified_at":    {accessor: feltModifiedAtValue, prefilterable: false},
	"modified-at":    {accessor: feltModifiedAtValue, prefilterable: false},
	"path":           {accessor: func(f *felt.Felt) (any, bool) { return f.Path, f.Path != "" }, prefilterable: false},
	"report_path":    {accessor: func(f *felt.Felt) (any, bool) { return f.ReportPath, f.ReportPath != "" }, prefilterable: false},
	"report-path":    {accessor: func(f *felt.Felt) (any, bool) { return f.ReportPath, f.ReportPath != "" }, prefilterable: false},
	"entry_point":    {accessor: func(f *felt.Felt) (any, bool) { return f.EntryPoint, f.EntryPoint }, prefilterable: false},
	"entry-point":    {accessor: func(f *felt.Felt) (any, bool) { return f.EntryPoint, f.EntryPoint }, prefilterable: false},
}

func feltUIDValue(f *felt.Felt) (any, bool)        { return f.UID, f.UID != "" }
func feltCreatedAtValue(f *felt.Felt) (any, bool)  { return f.CreatedAt, !f.CreatedAt.IsZero() }
func feltClosedAtValue(f *felt.Felt) (any, bool)   { return f.ClosedAt, f.ClosedAt != nil }
func feltModifiedAtValue(f *felt.Felt) (any, bool) { return f.ModifiedAt, !f.ModifiedAt.IsZero() }

func feltHasField(f *felt.Felt, field string) bool {
	if spec, ok := nativeFields[field]; ok {
		_, present := spec.accessor(f)
		return present
	}
	_, ok := f.ExtraFields[field]
	return ok
}

func frontmatterPrefilterFields(fields []string) ([]string, bool) {
	var frontmatterFields []string
	for _, field := range fields {
		spec, ok := nativeFields[field]
		if !ok {
			// Non-native field: gate on the key as given.
			frontmatterFields = append(frontmatterFields, field)
			continue
		}
		if !spec.prefilterable {
			return nil, false
		}
		if spec.prefilterKey != "" {
			frontmatterFields = append(frontmatterFields, spec.prefilterKey)
		}
		// prefilterable with empty prefilterKey (id): every discovered fiber
		// has it; no frontmatter gate needed.
	}
	return frontmatterFields, true
}

func projectFeltsJSON(felts []*felt.Felt, fields []string) ([]map[string]interface{}, error) {
	projected := make([]map[string]interface{}, 0, len(felts))
	for _, f := range felts {
		item := make(map[string]interface{}, len(fields))
		for _, field := range fields {
			value, ok, err := feltJSONField(f, field)
			if err != nil {
				return nil, err
			}
			if ok {
				item[field] = value
			}
		}
		projected = append(projected, item)
	}
	return projected, nil
}

func feltJSONField(f *felt.Felt, field string) (interface{}, bool, error) {
	if spec, ok := nativeFields[field]; ok {
		value, present := spec.accessor(f)
		return value, present, nil
	}
	node, ok := f.ExtraFields[field]
	if !ok || node == nil {
		return nil, false, nil
	}
	// The shuttle: facet emits its resolved view (flat block + a `resolved`
	// sub-key) when resolution has been attached; raw decode otherwise.
	if field == felt.ShuttleFacetKey {
		if resolved, ok := f.ResolvedShuttle(); ok {
			return resolved, true, nil
		}
	}
	var value interface{}
	if err := node.Decode(&value); err != nil {
		return nil, false, fmt.Errorf("decode extra field %q: %w", field, err)
	}
	return value, true, nil
}

// matchesQuery reports whether f matches the query by substring or regex.
// It checks the fiber's display name, SearchText, and full id (slug).
// queryLower must be strings.ToLower(query); re is the compiled regexp (non-nil iff useRegex).
func matchesQuery(f *felt.Felt, queryLower string, re *regexp.Regexp, useRegex bool) bool {
	if useRegex {
		return re.MatchString(f.DisplayName()) ||
			re.MatchString(f.ID) ||
			re.MatchString(f.SearchText())
	}
	return strings.Contains(strings.ToLower(f.DisplayName()), queryLower) ||
		strings.Contains(strings.ToLower(f.ID), queryLower) ||
		strings.Contains(strings.ToLower(f.SearchText()), queryLower)
}

// scanBodyMatches folds candidates whose body matches the query into filtered by
// hydrating and scanning the markdown source of truth. Regex queries match by
// pattern; plain queries match by lowercased substring (so partial words match).
func scanBodyMatches(storage *felt.Storage, filtered, candidates []*felt.Felt, re *regexp.Regexp, queryLower string, useRegex bool) ([]*felt.Felt, error) {
	fullCandidates, err := hydrateBodies(storage, candidates)
	if err != nil {
		return nil, err
	}

	for _, f := range fullCandidates {
		var matches bool
		if useRegex {
			matches = re.MatchString(f.Body)
		} else {
			matches = strings.Contains(strings.ToLower(f.Body), queryLower)
		}
		if matches {
			filtered = append(filtered, f)
		}
	}

	return filtered, nil
}

func hydrateBodies(storage *felt.Storage, felts []*felt.Felt) ([]*felt.Felt, error) {
	hydrated := make([]*felt.Felt, 0, len(felts))
	for _, f := range felts {
		full, err := storage.Read(f.ID)
		if err != nil {
			return nil, err
		}
		full.ModifiedAt = f.ModifiedAt
		hydrated = append(hydrated, full)
	}
	return hydrated, nil
}

// ContainmentNode represents a fiber in the containment tree (from filesystem nesting).
type ContainmentNode struct {
	*felt.Felt
	Children []*ContainmentNode `json:"children,omitempty"`
}

// tree command - containment hierarchy
var treeCmd = &cobra.Command{
	Use:   "tree [id]",
	Short: "Show containment tree",
	Long: `Shows the containment tree (filesystem nesting) for fibers.

Use -L/--depth to cap how deep the tree is drawn; elided branches are marked
with the count of what lies below them. --json is always the full tree.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := requireStore()
		if err != nil {
			return err
		}

		// Resolve the argument before listing anything: an id that names a
		// fiber in the enclosing store draws THAT store's tree — the fiber is
		// real, it just is not in this view — so the ref decides which store
		// gets walked, and the walk happens exactly once either way.
		target := fiberRef{storage: storage}
		if len(args) == 1 {
			target, err = resolveFiberRef(storage, "", args[0])
			if err != nil {
				return err
			}
		}

		felts, err := listForOutput(target.storage, nil)
		if err != nil {
			return err
		}

		roots := buildContainmentTree(felts)
		if len(args) == 1 {
			node := findContainmentNode(roots, target.id)
			if node == nil {
				return fmt.Errorf("fiber %s not found in tree", target.id)
			}
			roots = []*ContainmentNode{node}
		}

		if jsonOutput {
			return outputJSON(roots)
		}

		for i, root := range roots {
			printContainmentNode(root, "", i == len(roots)-1, 0)
		}

		return nil
	},
}

// buildContainmentTree constructs a tree from fiber IDs based on path nesting.
// A fiber with ID "a/b" is a child of "a". Fibers without a parent in the set are roots.
func buildContainmentTree(felts []*felt.Felt) []*ContainmentNode {
	byID := make(map[string]*ContainmentNode, len(felts))
	for _, f := range felts {
		byID[f.ID] = &ContainmentNode{Felt: f}
	}

	var roots []*ContainmentNode
	for _, f := range felts {
		node := byID[f.ID]
		parentID := felt.ParentPath(f.ID)
		if parentID != "" {
			if parent, ok := byID[parentID]; ok {
				parent.Children = append(parent.Children, node)
				continue
			}
		}
		roots = append(roots, node)
	}

	sortContainmentNodes(roots)
	return roots
}

func sortContainmentNodes(nodes []*ContainmentNode) {
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	for _, n := range nodes {
		sortContainmentNodes(n.Children)
	}
}

func findContainmentNode(roots []*ContainmentNode, id string) *ContainmentNode {
	for _, r := range roots {
		if r.ID == id {
			return r
		}
		if found := findContainmentNode(r.Children, id); found != nil {
			return found
		}
	}
	return nil
}

// treeIDMaxLen is the length past which treeDisplayID collapses a nested ID to
// its leaf segment.
const treeIDMaxLen = 24

// treeDisplayID renders long nested IDs by their leaf segment. In tree output,
// the parent path is already carried by the branch structure; the leaf is the
// part that distinguishes siblings during a scan.
func treeDisplayID(id string) string {
	if len(id) <= treeIDMaxLen {
		return id
	}
	idx := strings.LastIndex(id, "/")
	if idx < 0 {
		return id
	}
	return ".../" + id[idx+1:]
}

// countDescendants returns the total number of nodes below node.
func countDescendants(node *ContainmentNode) int {
	n := 0
	for _, child := range node.Children {
		n += 1 + countDescendants(child)
	}
	return n
}

func printContainmentNode(node *ContainmentNode, prefix string, last bool, depth int) {
	connector := "├── "
	if last {
		connector = "└── "
	}
	if prefix == "" {
		connector = ""
	}

	fmt.Printf("%s%s%s %s  %s\n", prefix, connector, felt.StatusIcon(node.Status), treeDisplayID(node.ID), node.Name)

	var childPrefix string
	if prefix == "" {
		childPrefix = "    "
	} else if last {
		childPrefix = prefix + "    "
	} else {
		childPrefix = prefix + "│   "
	}

	// At the depth limit the subtree is elided; say how much was left out so
	// the truncation is visible rather than silent.
	if treeDepth > 0 && depth+1 > treeDepth {
		if hidden := countDescendants(node); hidden > 0 {
			fmt.Printf("%s└── … (%d more below)\n", childPrefix, hidden)
		}
		return
	}

	for i, child := range node.Children {
		printContainmentNode(child, childPrefix, i == len(node.Children)-1, depth+1)
	}
}

func init() {
	rootCmd.AddCommand(treeCmd)
	treeCmd.Flags().IntVarP(&treeDepth, "depth", "L", 0, "Maximum nesting depth to display (1 = direct children only; 0 = unlimited)")
}
