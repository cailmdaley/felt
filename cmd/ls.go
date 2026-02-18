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
	lsStatus string
	lsTags   []string
	lsRecent int
	lsBody   bool
	lsExact  bool
	lsRegex  bool
	readyTags []string
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

Optional query searches title, body, and outcome:
  felt ls cosebis             substring search
  felt ls -r "rule:.*data"    regex search
  felt ls -e "exact title"    exact title match`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

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

		// If any filter is active (tags, query, recent) and -s wasn't explicitly set,
		// widen to all statuses. Bare `felt ls` stays open+active (actionable view).
		statusExplicit := cmd.Flags().Changed("status")
		hasFilters := len(lsTags) > 0 || query != "" || lsRecent > 0
		effectiveStatus := lsStatus
		if !statusExplicit && hasFilters {
			effectiveStatus = "all"
		}

		// Filter
		var exactMatches []*felt.Felt
		var filtered []*felt.Felt
		for _, f := range felts {
			// Status gate
			if effectiveStatus == "all" {
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
				if lsRegex {
					matches = re.MatchString(f.Title) ||
						re.MatchString(f.Body) ||
						re.MatchString(f.Outcome)
				} else {
					matches = strings.Contains(titleLower, queryLower) ||
						strings.Contains(strings.ToLower(f.Body), queryLower) ||
						strings.Contains(strings.ToLower(f.Outcome), queryLower)
				}

				if !matches {
					continue
				}
			}

			filtered = append(filtered, f)
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
			// If --body flag not set, clear body field to exclude from JSON
			if !lsBody {
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
			return nil
		}

		for _, f := range filtered {
			printFeltTwoLine(f)
		}

		return nil
	},
}

func statusIcon(status string) string {
	switch status {
	case felt.StatusOpen:
		return "○"
	case felt.StatusActive:
		return "◐"
	case felt.StatusClosed:
		return "●"
	case "":
		return "·"
	default:
		return "?"
	}
}

// printFeltTwoLine prints a felt in two-line format for better scannability:
// Line 1: status icon + ID
// Line 2: indented title with metadata
func printFeltTwoLine(f *felt.Felt) {
	fmt.Print(formatFeltTwoLine(f))
}

// formatFeltTwoLine returns a felt in two-line format.
// Used by ls, ready, find, and hook commands for consistent output.
func formatFeltTwoLine(f *felt.Felt) string {
	icon := statusIcon(f.Status)

	// Line 1: status + ID
	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	// Line 2: indented title with metadata (tags, deps)
	var meta []string
	if len(f.Tags) > 0 {
		meta = append(meta, strings.Join(f.Tags, ", "))
	}
	if len(f.DependsOn) > 0 {
		meta = append(meta, fmt.Sprintf("%d deps", len(f.DependsOn)))
	}

	metaStr := ""
	if len(meta) > 0 {
		metaStr = fmt.Sprintf(" (%s)", strings.Join(meta, ", "))
	}

	line2 := fmt.Sprintf("    %s%s\n", f.Title, metaStr)

	return line1 + line2
}

func init() {
	rootCmd.AddCommand(lsCmd)
	lsCmd.Flags().StringVarP(&lsStatus, "status", "s", "", "Filter by status (open, active, closed, all)")
	lsCmd.Flags().StringArrayVarP(&lsTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic; trailing colon for prefix match)")
	lsCmd.Flags().IntVarP(&lsRecent, "recent", "n", 0, "Show N most recent (by closed-at or created-at)")
	lsCmd.Flags().BoolVar(&lsBody, "body", false, "Include body field in JSON output")
	lsCmd.Flags().BoolVarP(&lsExact, "exact", "e", false, "Exact title match only (with query)")
	lsCmd.Flags().BoolVarP(&lsRegex, "regex", "r", false, "Treat query as regular expression")
}

// ready command - open felts with all deps closed
var readyCmd = &cobra.Command{
	Use:   "ready",
	Short: "List felts ready to work on",
	Long:  `Lists open felts whose dependencies are all closed.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		ready := g.Ready()

		// Apply tag filter if specified
		if len(readyTags) > 0 {
			var filtered []*felt.Felt
			for _, f := range ready {
				hasAll := true
				for _, tag := range readyTags {
					if !f.HasTag(tag) {
						hasAll = false
						break
					}
				}
				if hasAll {
					filtered = append(filtered, f)
				}
			}
			ready = filtered
		}

		if jsonOutput {
			return outputJSON(ready)
		}

		if len(ready) == 0 {
			fmt.Println("No felts ready")
			return nil
		}

		for _, f := range ready {
			printFeltTwoLine(f)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(readyCmd)
	readyCmd.Flags().StringArrayVarP(&readyTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic)")
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
	Long:  `Shows the dependency tree for a felt, or all felts if no ID given.`,
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)

		if jsonOutput {
			var trees []*TreeNode
			visited := make(map[string]bool)

			if len(args) == 1 {
				f, err := storage.Find(args[0])
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
			f, err := storage.Find(args[0])
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
		fmt.Printf("%s%s%s %s  %s (see above)\n", prefix, connector, statusIcon(f.Status), shortID(id), f.Title)
		return
	}
	visited[id] = true

	fmt.Printf("%s%s%s %s  %s\n", prefix, connector, statusIcon(f.Status), shortID(id), f.Title)

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

func shortID(id string) string {
	// Show last 8 chars (the hex part) plus a bit of slug
	parts := strings.Split(id, "-")
	if len(parts) < 2 {
		return id
	}
	hex := parts[len(parts)-1]
	slug := strings.Join(parts[:len(parts)-1], "-")
	if len(slug) > 16 {
		slug = slug[:16] + "..."
	}
	return slug + "-" + hex
}

func init() {
	rootCmd.AddCommand(treeCmd)
}
