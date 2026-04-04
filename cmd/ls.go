package cmd

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	lsStatus  string
	lsTags    []string
	lsRecent  int
	lsBody    bool
	lsExact   bool
	lsRegex   bool
	lsReady   bool
	treeUp    bool
	treeDown  bool
	treeCheck bool
)

var lsCmd = &cobra.Command{
	Use:   "ls [query]",
	Short: "List and search felts",
	Long: `Lists felts, showing open and active by default.

When any filter is active (-t, query, -n), all statuses are shown
automatically. Use -s to override: open, active, closed, or all.

Use -t to filter by tag (AND logic, prefix matching with trailing colon):
  -t rule:                    matches any rule:* tag
  -t rule:cosebis_data_vector exact tag match

Optional query searches title, outcome, and ASTRA frontmatter:
  felt ls cosebis             substring search
  felt ls -r "rule:.*data"    regex search
  felt ls -e "exact title"    exact title match

Use --body with query to include body search, and with --json to emit body text.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		query := ""
		if len(args) == 1 {
			query = args[0]
		}

		// Compile regex if needed
		var re *regexp.Regexp
		if lsRegex && query != "" {
			re, err = regexp.Compile("(?i)" + query)
			if err != nil {
				return fmt.Errorf("invalid regex: %w", err)
			}
		}

		queryLower := strings.ToLower(query)
		var felts []*felt.Felt
		if jsonOutput {
			felts, err = storage.ListMetadataWithModTime()
		} else {
			felts, err = storage.ListMetadata()
		}
		if err != nil {
			return err
		}

		// If any filter is active (tags, query, recent) and -s wasn't explicitly set,
		// widen to all statuses. Bare `felt ls` stays open+active (actionable view).
		statusExplicit := cmd.Flags().Changed("status")
		hasFilters := len(lsTags) > 0 || query != "" || lsRecent > 0
		effectiveStatus := lsStatus
		if !statusExplicit && hasFilters {
			effectiveStatus = "all"
		}

		var readyIDs map[string]bool
		if lsReady {
			readyIDs = map[string]bool{}
			for _, f := range felt.BuildGraph(felts).Ready() {
				readyIDs[f.ID] = true
			}
		}

		// Filter
		var exactMatches []*felt.Felt
		var filtered []*felt.Felt
		var bodyCandidates []*felt.Felt
		for _, f := range felts {
			if lsReady && !readyIDs[f.ID] {
				continue
			}

			// Status gate
			if lsReady {
				// Ready already constrains the result set.
			} else if effectiveStatus == "all" {
				// No filtering, include everything
			} else if effectiveStatus != "" {
				// Specific status: must match
				if f.Status != effectiveStatus {
					continue
				}
			} else {
				// Default: open+active, must have status
				if !f.HasStatus() {
					continue
				}
				if f.Status != felt.StatusOpen && f.Status != felt.StatusActive {
					continue
				}
			}

			// Tag filter: must have ALL specified tags (AND logic, prefix supported)
			if len(lsTags) > 0 {
				hasAll := true
				for _, tag := range lsTags {
					if !f.HasTag(tag) {
						hasAll = false
						break
					}
				}
				if !hasAll {
					continue
				}
			}

			// Text search (if query provided)
			if query != "" {
				titleLower := strings.ToLower(f.Title)

				// Exact title match (sorted first)
				if !lsRegex && titleLower == queryLower {
					exactMatches = append(exactMatches, f)
					continue
				}

				// If --exact, skip partial matches
				if lsExact {
					continue
				}

				// Regex or substring match
				var matches bool
				searchText := f.SearchText()
				if lsRegex {
					matches = re.MatchString(f.Title) || re.MatchString(searchText)
				} else {
					matches = strings.Contains(titleLower, queryLower) ||
						strings.Contains(strings.ToLower(searchText), queryLower)
				}

				if matches {
					filtered = append(filtered, f)
					continue
				}

				if lsBody {
					bodyCandidates = append(bodyCandidates, f)
					continue
				}

				if !matches {
					continue
				}
			}

			filtered = append(filtered, f)
		}

		if query != "" && !lsExact && lsBody && len(bodyCandidates) > 0 {
			filtered, err = appendBodyMatches(storage, filtered, bodyCandidates, lsRegex, re, queryLower)
			if err != nil {
				return err
			}
		}

		// Exact title matches first, then the rest
		filtered = append(exactMatches, filtered...)

		// Sort: --recent sorts by recency, otherwise by priority then creation
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
			// Limit to N
			if len(filtered) > lsRecent {
				filtered = filtered[:lsRecent]
			}
		} else if query == "" {
			// Default: sort by creation time (skip for search results to preserve relevance)
			sort.Slice(filtered, func(i, j int) bool {
				return filtered[i].CreatedAt.Before(filtered[j].CreatedAt)
			})
		}

		// Output
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
			return outputJSON(filtered)
		}

		if len(filtered) == 0 {
			if query != "" {
				fmt.Printf("No felts matching %q\n", query)
			} else {
				fmt.Println("No felts found")
			}
		} else {
			for _, f := range filtered {
				fmt.Print(formatFeltTwoLine(f))
			}
		}

		// Show count of hidden fibers when the default filter is active
		if !statusExplicit && !hasFilters && !lsReady {
			hidden := len(felts) - len(filtered)
			if hidden > 0 {
				fmt.Printf("\n(%d more — use -s all to see everything)\n", hidden)
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
	lsCmd.Flags().BoolVarP(&lsExact, "exact", "e", false, "Exact title match only (with query)")
	lsCmd.Flags().BoolVarP(&lsRegex, "regex", "r", false, "Treat query as regular expression")
	lsCmd.Flags().BoolVar(&lsReady, "ready", false, "Filter to open felts whose dependencies are all closed")
}

func appendBodyMatches(storage *felt.Storage, filtered, candidates []*felt.Felt, useRegex bool, re *regexp.Regexp, queryLower string) ([]*felt.Felt, error) {
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

// TreeNode represents a felt with its children for JSON output.
type TreeNode struct {
	*felt.Felt
	Children []*TreeNode `json:"children,omitempty"`
}

// tree command - hierarchical view
var treeCmd = &cobra.Command{
	Use:   "tree [id]",
	Short: "Show dependency tree",
	Long:  `Shows the dependency tree for a felt, or the whole graph if no ID is given.`,
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		var felts []*felt.Felt
		if jsonOutput {
			felts, err = storage.ListMetadataWithModTime()
		} else {
			felts, err = storage.ListMetadata()
		}
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)

		if treeCheck {
			var errors []string
			errors = append(errors, g.ValidateDependencies()...)
			errors = append(errors, g.FindCycles()...)

			if len(errors) == 0 {
				fmt.Println("Graph OK")
				return nil
			}

			for _, e := range errors {
				fmt.Printf("ERROR: %s\n", e)
			}
			return fmt.Errorf("found %d issues", len(errors))
		}

		if treeUp || treeDown {
			if len(args) != 1 {
				return fmt.Errorf("tree traversal requires an id")
			}
			depth := 1
			if traversalAll {
				depth = 0
			}
			cfg := traversalConfig{
				getRelated: func(g *felt.Graph, id string) []string { return g.GetUpstreamN(id, depth) },
				edgeLabel:  func(g *felt.Graph, fiberID, relatedID string) string { return edgeLabelInGraph(g, relatedID, fiberID) },
				emptyMsg:   "No dependencies",
			}
			if treeDown {
				cfg = traversalConfig{
					getRelated: func(g *felt.Graph, id string) []string { return g.GetDownstreamN(id, depth) },
					edgeLabel:  func(g *felt.Graph, fiberID, relatedID string) string { return edgeLabelInGraph(g, fiberID, relatedID) },
					emptyMsg:   "Nothing depends on this",
				}
			}
			return runTraversal(args[0], cfg)
		}

		if graphFormat != "" && graphFormat != "text" {
			switch graphFormat {
			case "mermaid":
				fmt.Print(g.ToMermaid())
			case "dot":
				fmt.Print(g.ToDot())
			default:
				return fmt.Errorf("unknown format: %s (use mermaid, dot, or text)", graphFormat)
			}
			return nil
		}

		if jsonOutput {
			var trees []*TreeNode
			visited := make(map[string]bool)

			if len(args) == 1 {
				f, err := felt.FindByPrefix(felts, args[0])
				if err != nil {
					return err
				}
				trees = append(trees, buildTreeNode(g, f.ID, visited))
			} else {
				var roots []*felt.Felt
				for _, f := range felts {
					if len(f.DependsOn) == 0 {
						roots = append(roots, f)
					}
				}
				sort.Slice(roots, func(i, j int) bool {
					return roots[i].CreatedAt.Before(roots[j].CreatedAt)
				})
				for _, f := range roots {
					trees = append(trees, buildTreeNode(g, f.ID, visited))
				}
			}
			return outputJSON(trees)
		}

		if len(args) == 1 {
			// Show tree for specific felt
			f, err := felt.FindByPrefix(felts, args[0])
			if err != nil {
				return err
			}
			printTree(g, f.ID, "", true)
		} else {
			// Show all root nodes (no upstream deps)
			var roots []*felt.Felt
			for _, f := range felts {
				if len(f.DependsOn) == 0 {
					roots = append(roots, f)
				}
			}
			sort.Slice(roots, func(i, j int) bool {
				return roots[i].CreatedAt.Before(roots[j].CreatedAt)
			})
			// Share visited map across roots to handle nodes reachable from multiple roots
			visited := make(map[string]bool)
			for i, f := range roots {
				printTreeWithVisited(g, f.ID, "", i == len(roots)-1, visited)
			}
		}

		return nil
	},
}

func buildTreeNode(g *felt.Graph, id string, visited map[string]bool) *TreeNode {
	if visited[id] {
		return nil
	}
	visited[id] = true

	f := g.Nodes[id]
	if f == nil {
		return nil
	}

	node := &TreeNode{Felt: f}
	children := g.Downstream[id]
	sort.Slice(children, func(i, j int) bool { return children[i].ID < children[j].ID })

	for _, child := range children {
		if childNode := buildTreeNode(g, child.ID, visited); childNode != nil {
			node.Children = append(node.Children, childNode)
		}
	}
	return node
}

// printTreeWithVisited prints a node and its children, tracking visited nodes to avoid duplicates.
func printTreeWithVisited(g *felt.Graph, id string, prefix string, last bool, visited map[string]bool) {
	f, ok := g.Nodes[id]
	if !ok {
		return
	}

	// Print this node
	connector := "├── "
	if last {
		connector = "└── "
	}
	if prefix == "" {
		connector = ""
	}

	// Check if already printed
	if visited[id] {
		fmt.Printf("%s%s%s %s  %s (see above)\n", prefix, connector, felt.StatusIcon(f.Status), felt.ShortID(id), f.Title)
		return
	}
	visited[id] = true

	fmt.Printf("%s%s%s %s  %s\n", prefix, connector, felt.StatusIcon(f.Status), felt.ShortID(id), f.Title)

	// Get children (downstream)
	children := g.Downstream[id]
	sort.Slice(children, func(i, j int) bool { return children[i].ID < children[j].ID })

	// Update prefix for children
	var childPrefix string
	if prefix == "" {
		// Starting from root node - children need indentation
		childPrefix = "    "
	} else if last {
		childPrefix = prefix + "    "
	} else {
		childPrefix = prefix + "│   "
	}

	for i, child := range children {
		printTreeWithVisited(g, child.ID, childPrefix, i == len(children)-1, visited)
	}
}

func printTree(g *felt.Graph, id string, prefix string, last bool) {
	visited := make(map[string]bool)
	printTreeWithVisited(g, id, prefix, last, visited)
}

func init() {
	rootCmd.AddCommand(treeCmd)
	treeCmd.Flags().BoolVar(&treeUp, "up", false, "Show upstream dependencies for one felt")
	treeCmd.Flags().BoolVar(&treeDown, "down", false, "Show downstream dependents for one felt")
	treeCmd.Flags().BoolVar(&treeCheck, "check", false, "Validate graph integrity")
	treeCmd.Flags().StringVarP(&graphFormat, "format", "f", "text", "Output format (text, mermaid, dot)")
	treeCmd.Flags().StringVarP(&upDownDetail, "detail", "d", "", "Detail level per item (title, compact, summary, full)")
	treeCmd.Flags().BoolVar(&traversalAll, "all", false, "Traverse full transitive closure for --up/--down")
}
