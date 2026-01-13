package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	lsStatus   string
	lsKind     string
	lsTags     []string
	readyTags  []string
)

var lsCmd = &cobra.Command{
	Use:   "ls",
	Short: "List felts",
	Long:  `Lists all felts, optionally filtered by status or kind.`,
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

		// Filter
		var filtered []*felt.Felt
		for _, f := range felts {
			if lsStatus != "" && f.Status != lsStatus {
				continue
			}
			if lsKind != "" && f.Kind != lsKind {
				continue
			}
			// Tag filter: must have ALL specified tags (AND logic)
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
			filtered = append(filtered, f)
		}

		// Sort by priority, then creation time
		sort.Slice(filtered, func(i, j int) bool {
			if filtered[i].Priority != filtered[j].Priority {
				return filtered[i].Priority < filtered[j].Priority
			}
			return filtered[i].CreatedAt.Before(filtered[j].CreatedAt)
		})

		// Output
		if jsonOutput {
			return outputJSON(filtered)
		}

		if len(filtered) == 0 {
			fmt.Println("No felts found")
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

	// Line 2: indented title with metadata (kind, deps)
	var meta []string
	if f.Kind != felt.DefaultKind {
		meta = append(meta, f.Kind)
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
	lsCmd.Flags().StringVarP(&lsStatus, "status", "s", "", "Filter by status (open, active, closed)")
	lsCmd.Flags().StringVarP(&lsKind, "kind", "k", "", "Filter by kind")
	lsCmd.Flags().StringArrayVarP(&lsTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic)")
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
	sort.Strings(children)

	for _, childID := range children {
		if child := buildTreeNode(g, childID, visited); child != nil {
			node.Children = append(node.Children, child)
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
	sort.Strings(children)

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

	for i, childID := range children {
		printTreeWithVisited(g, childID, childPrefix, i == len(children)-1, visited)
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
