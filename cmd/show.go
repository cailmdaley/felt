package cmd

import (
	"fmt"
	"os"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var (
	showBodyOnly  bool
	showDetail    string
	showCitations bool
	showConsumers bool
	showField     string
)

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show a fiber",
	Long: `-d sets how much prints:
  name     name and tags
  compact  metadata, outcome, body size, extra frontmatter keys
  summary  compact plus body links, back-references in this view, and the
           lede paragraph
  full     everything, body included (the default)

--body, --citations, --consumers, and --field each print one thing instead of
the fiber, and only one may be given. --citations and --consumers search the
whole store, not just this view. --field prints a scalar on one line, a list of
scalars one per line, anything else as YAML, and nothing for a missing key.`,
	Example: `  felt show analysis/covariance -d summary
  felt show analysis/covariance --field status`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := felt.RequireStore(changeDir)
		if err != nil {
			return err
		}

		detail := showDetail
		if detail == "" {
			detail = DepthFull
		}
		if err := validateDepth(detail); err != nil {
			return err
		}

		selectorCount := 0
		for _, active := range []bool{
			showBodyOnly,
			showCitations,
			showConsumers,
			showField != "",
		} {
			if active {
				selectorCount++
			}
		}
		if selectorCount > 1 {
			return fmt.Errorf("show selectors are mutually exclusive: choose only one of --body, --citations, --consumers, or --field")
		}

		scopeID := felt.CommandScope(root, changeDir)

		// An id that names a fiber in the enclosing store is shown from
		// there: everything below runs against the store that holds it, with
		// the fiber addressed by its id in that store's coordinates.
		target, err := felt.ResolveRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}
		query := args[0]
		if target.Elsewhere {
			storage, scopeID, query = target.Storage, "", target.ID
		}

		if selectorCount == 0 && !jsonOutput && (detail == DepthName || detail == DepthCompact) {
			// Both levels skip the relationship scan and the body-ref graph.
			// Compact still reads the body — it reports the body's line count —
			// but that is one extra file read, not a walk.
			find := storage.FindMetadataInScope
			if detail == DepthCompact {
				find = storage.FindInScope
			}
			f, err := find(scopeID, query)
			if err != nil {
				return err
			}
			fmt.Print(renderFelt(f, nil, detail, nil, nil, storage.ExternalRefs()))
			return nil
		}

		// Targeted views: full single-file read, optionally structured output.
		if selectorCount > 0 || jsonOutput {
			f, err := storage.FindInScope(scopeID, query)
			if err != nil {
				return err
			}

			if showBodyOnly {
				return outputShowBody(storage, f)
			}
			if showCitations {
				citations, _, err := storage.ScanRelationshipsAcrossStore(f.ID)
				if err != nil {
					return err
				}
				if jsonOutput {
					return outputJSON(citations)
				}
				printCitations(f.ID, citations)
				return nil
			}
			if showConsumers {
				_, consumers, err := storage.ScanRelationshipsAcrossStore(f.ID)
				if err != nil {
					return err
				}
				if jsonOutput {
					return outputJSON(consumers)
				}
				printConsumers(f.ID, consumers)
				return nil
			}
			if showField != "" {
				return outputShowField(storage, f, showField)
			}
			if jsonOutput {
				return outputJSON(f)
			}
		}

		f, err := storage.FindInScope(scopeID, query)
		if err != nil {
			return err
		}

		graph := graphForBodyRefs(storage, f)

		var citations []felt.Citation
		var consumers []felt.DataFlowConsumer
		if detail == DepthSummary || detail == DepthFull {
			// Reverse-edge context is read straight from the markdown source of
			// truth in a single walk, so the block is always fresh.
			citations, consumers, err = storage.ScanRelationships(f.ID)
			if err != nil {
				return err
			}
		}

		fmt.Print(renderFelt(f, graph, detail, citations, consumers, storage.ExternalRefs()))
		return nil
	},
}

// Graph is a resolved set of felts keyed by ID, used to render body references
// with their display names.
type Graph struct {
	Nodes map[string]*felt.Felt
}

func graphForBodyRefs(storage *felt.Storage, f *felt.Felt) *Graph {
	refs := felt.ExtractBodyRefs(f.Body)
	if len(refs) == 0 {
		return nil
	}

	g := &Graph{Nodes: map[string]*felt.Felt{f.ID: f}}
	for _, ref := range refs {
		target, ok, err := storage.FindExistingMetadataInScope(f.ID, ref.Target)
		if err != nil || !ok {
			continue
		}
		g.Nodes[target.ID] = target
	}
	return g
}

func init() {
	showCmd.GroupID = groupFibers
	rootCmd.AddCommand(showCmd)
	showCmd.Flags().BoolVarP(&showBodyOnly, "body", "b", false, "Print the body and the line it starts on")
	showCmd.Flags().StringVarP(&showDetail, "detail", "d", "", "Detail level (name, compact, summary, full)")
	showCmd.Flags().BoolVar(&showCitations, "citations", false, "Print the fibers that wikilink here")
	showCmd.Flags().BoolVar(&showConsumers, "consumers", false, "Print the fibers that name this one in inputs.from")
	showCmd.Flags().StringVar(&showField, "field", "", "Print one frontmatter field by its YAML key, formatted for the shell")
}

type showBodyOutput struct {
	Body          string `json:"body"`
	BodyStartLine int    `json:"body_start_line"`
}

func outputShowBody(storage *felt.Storage, f *felt.Felt) error {
	data, err := os.ReadFile(storage.Path(f.ID))
	if err != nil {
		return fmt.Errorf("reading file %s: %w", storage.Path(f.ID), err)
	}
	startLine, err := felt.BodyStartLine(data)
	if err != nil {
		return err
	}

	payload := showBodyOutput{
		Body:          f.Body,
		BodyStartLine: startLine,
	}
	if jsonOutput {
		return outputJSON(payload)
	}

	fmt.Printf("Body start line: %d\n", startLine)
	if f.Body != "" {
		fmt.Printf("\n%s", f.Body)
		if f.Body[len(f.Body)-1] != '\n' {
			fmt.Println()
		}
	}
	return nil
}

// printCitations lists the fibers that link to id, one per line, in the same
// shape as show's "Cited by:" line, then the citing fiber's name.
func printCitations(id string, citations []felt.Citation) {
	if len(citations) == 0 {
		fmt.Printf("No fibers link to %s\n", id)
		return
	}
	for _, c := range citations {
		ref := c.SourceID
		if c.Fragment != "" {
			ref += "#" + c.Fragment
		}
		fmt.Printf("%s  %s\n", ref, c.SourceName)
	}
}

// printConsumers lists the fibers that name id in inputs.from, one per line,
// in the same shape as show's "Consumed by:" line: the output consumed, the
// consuming fiber and its input id, then the consumer's name.
func printConsumers(id string, consumers []felt.DataFlowConsumer) {
	if len(consumers) == 0 {
		fmt.Printf("No fibers name %s in inputs.from\n", id)
		return
	}
	for _, c := range consumers {
		ref := c.SourceID
		if c.InputID != "" {
			ref += "#" + c.InputID
		}
		if c.OutputID != "" {
			ref = c.OutputID + " \u2192 " + ref
		}
		fmt.Printf("%s  %s\n", ref, c.SourceName)
	}
}

// outputShowField emits a single frontmatter field, identified by its
// raw YAML key, in a shape shell consumers can rely on.
func outputShowField(storage *felt.Storage, f *felt.Felt, key string) error {
	if jsonOutput {
		return fmt.Errorf("--field cannot combine with --json; use --json without --field for the structured view")
	}
	data, err := os.ReadFile(storage.Path(f.ID))
	if err != nil {
		return fmt.Errorf("reading file %s: %w", storage.Path(f.ID), err)
	}
	fmBytes, _, err := felt.SplitFrontmatter(data, false)
	if err != nil {
		return fmt.Errorf("splitting frontmatter for %s: %w", f.ID, err)
	}
	var node yaml.Node
	if err := yaml.Unmarshal(fmBytes, &node); err != nil {
		return fmt.Errorf("parsing frontmatter for %s: %w", f.ID, err)
	}
	if len(node.Content) == 0 {
		return nil
	}
	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return fmt.Errorf("frontmatter for %s is not a YAML mapping", f.ID)
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != key {
			continue
		}
		valueNode := mapping.Content[i+1]
		return emitFieldNode(valueNode)
	}
	return nil
}

func emitFieldNode(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		fmt.Println(n.Value)
		return nil
	case yaml.SequenceNode:
		if allScalar(n.Content) {
			for _, child := range n.Content {
				fmt.Println(child.Value)
			}
			return nil
		}
		fallthrough
	case yaml.MappingNode, yaml.AliasNode:
		out, err := yaml.Marshal(n)
		if err != nil {
			return fmt.Errorf("marshal field value: %w", err)
		}
		fmt.Print(string(out))
		return nil
	default:
		return nil
	}
}

func allScalar(nodes []*yaml.Node) bool {
	for _, n := range nodes {
		if n.Kind != yaml.ScalarNode {
			return false
		}
	}
	return true
}
