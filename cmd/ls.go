package cmd

import (
	"errors"
	"fmt"
	"os"
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
	treeDepth int
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

Optional query searches name, outcome, and structured frontmatter:
  felt ls cosebis             substring search
  felt ls -r "rule:.*data"    regex search
  felt ls -e "exact name"     exact name match

Use --body with query to include body search, and with --json to emit body text.`,
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

		// Compile regex if needed
		var re *regexp.Regexp
		if lsRegex && query != "" {
			re, err = regexp.Compile("(?i)" + query)
			if err != nil {
				return fmt.Errorf("invalid regex: %w", err)
			}
		}

		queryLower := strings.ToLower(query)
		bodyMatchIDs := map[string]struct{}{}
		if query != "" && lsBody && !lsRegex {
			idx, err := storage.OpenIndex()
			if err != nil {
				if errors.Is(err, felt.ErrIndexBusy) {
					fmt.Fprintf(os.Stderr, "warning: index busy — full-text body search unavailable\n")
				} else {
					return err
				}
			} else {
				defer idx.Close()
				ids, err := idx.SearchBodyIDs(query)
				if err != nil {
					return err
				}
				for _, id := range ids {
					bodyMatchIDs[id] = struct{}{}
				}
			}
		}
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

		// Filter
		var exactMatches []*felt.Felt
		var filtered []*felt.Felt
		var bodyCandidates []*felt.Felt
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
				nameLower := strings.ToLower(f.DisplayName())

				// Exact name match (sorted first)
				if !lsRegex && nameLower == queryLower {
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
					matches = re.MatchString(f.DisplayName()) || re.MatchString(searchText)
				} else {
					matches = strings.Contains(nameLower, queryLower) ||
						strings.Contains(strings.ToLower(searchText), queryLower)
				}

				if matches {
					filtered = append(filtered, f)
					continue
				}

				if _, ok := bodyMatchIDs[f.ID]; ok {
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

		// Exact name matches first, then the rest
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
		if !statusExplicit && !hasFilters {
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
	lsCmd.Flags().BoolVarP(&lsExact, "exact", "e", false, "Exact name match only (with query)")
	lsCmd.Flags().BoolVarP(&lsRegex, "regex", "r", false, "Treat query as regular expression")
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

// ContainmentNode represents a fiber in the containment tree (from filesystem nesting).
type ContainmentNode struct {
	*felt.Felt
	Children []*ContainmentNode `json:"children,omitempty"`
}

// tree command - containment hierarchy
var treeCmd = &cobra.Command{
	Use:   "tree [id]",
	Short: "Show containment tree",
	Long:  `Shows the containment tree (filesystem nesting) for fibers.`,
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
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

		// Build containment tree from IDs
		roots := buildContainmentTree(felts)

		// If a specific ID given, find its subtree
		if len(args) == 1 {
			f, err := felt.FindByPrefix(felts, args[0])
			if err != nil {
				return err
			}
			node := findContainmentNode(roots, f.ID)
			if node == nil {
				return fmt.Errorf("fiber %s not found in tree", f.ID)
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
		parentID := parentPath(f.ID)
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

// parentPath returns the parent fiber ID, or "" for top-level fibers.
func parentPath(id string) string {
	idx := strings.LastIndex(id, "/")
	if idx < 0 {
		return ""
	}
	return id[:idx]
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

func printContainmentNode(node *ContainmentNode, prefix string, last bool, depth int) {
	if treeDepth > 0 && depth > treeDepth {
		return
	}

	connector := "├── "
	if last {
		connector = "└── "
	}
	if prefix == "" {
		connector = ""
	}

	fmt.Printf("%s%s%s %s  %s\n", prefix, connector, felt.StatusIcon(node.Status), felt.ShortID(node.ID), node.Name)

	var childPrefix string
	if prefix == "" {
		childPrefix = "    "
	} else if last {
		childPrefix = prefix + "    "
	} else {
		childPrefix = prefix + "│   "
	}

	for i, child := range node.Children {
		printContainmentNode(child, childPrefix, i == len(node.Children)-1, depth+1)
	}
}

// validateContainment checks for orphaned nested fibers (parent doesn't exist).
func validateContainment(felts []*felt.Felt) []string {
	ids := make(map[string]bool, len(felts))
	for _, f := range felts {
		ids[f.ID] = true
	}

	var errors []string
	for _, f := range felts {
		parent := parentPath(f.ID)
		if parent != "" && !ids[parent] {
			errors = append(errors, fmt.Sprintf("%s nested under non-existent %s", f.ID, parent))
		}
	}
	return errors
}

func init() {
	rootCmd.AddCommand(treeCmd)
	treeCmd.Flags().IntVar(&treeDepth, "depth", 0, "Maximum nesting depth to display (0 = unlimited)")
}
