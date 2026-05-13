package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

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
	Short: "Show details of a felt",
	Long: `Displays details of a felt at the requested detail level.

Detail levels control progressive disclosure:
  name     Name and tags only
  compact  Metadata, outcome, and additional YAML field keys
  summary  Compact + lede paragraph + citations/consumers
  full     Everything (default)

Targeted views:
  --body            return the body plus its start line for editing
  --citations       return indexed narrative back-references only
  --consumers       return indexed reverse data-flow consumers only
  --field <name>    return one frontmatter field by raw YAML key, formatted
                    for shell consumers (scalars on one line, sequences of
                    scalars one-per-line, structured values as YAML)`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
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

		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)

		// Targeted views: full single-file read, optionally structured output.
		if selectorCount > 0 || jsonOutput {
			f, err := storage.FindInScope(scopeID, args[0])
			if err != nil {
				return err
			}

			if showBodyOnly {
				return outputShowBody(storage, f)
			}
			if showCitations {
				citations, err := showCitationsFor(storage, f.ID)
				if err != nil {
					return err
				}
				return outputShowSelection(citations)
			}
			if showConsumers {
				consumers, err := showConsumersFor(storage, f.ID)
				if err != nil {
					return err
				}
				return outputShowSelection(consumers)
			}
			if showField != "" {
				return outputShowField(storage, f, showField)
			}
			if jsonOutput {
				return outputJSON(f)
			}
		}

		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}
		target, err := felt.FindByScope(felts, scopeID, args[0])
		if err != nil {
			return err
		}
		graph := felt.BuildGraph(felts)

		f := target
		if detail == DepthSummary || detail == DepthFull {
			f, err = storage.Read(target.ID)
			if err != nil {
				return err
			}
			graph.Nodes[f.ID] = f
		}

		var citations []felt.Citation
		var consumers []felt.DataFlowConsumer
		var recentEditorial string
		var recentMechanical []felt.Event
		if detail == DepthSummary || detail == DepthFull {
			// Ordinary show is a continuity/read path, so keep it responsive
			// even when the search/link index is stale. Explicit
			// --citations/--consumers remain the synchronized index-backed
			// views for callers that require fresh relationship data.
			idx, idxErr := storage.OpenIndexNoSync()
			if idxErr != nil && !errors.Is(idxErr, felt.ErrIndexBusy) {
				return idxErr
			}
			if errors.Is(idxErr, felt.ErrIndexBusy) {
				fmt.Fprintf(os.Stderr, "warning: index busy — citations, consumers, and history unavailable\n")
			} else {
				defer idx.Close()

				citations, err = idx.Citations(f.ID)
				if err != nil {
					return err
				}
				consumers, err = idx.Consumers(f.ID)
				if err != nil {
					return err
				}

				editorialEvents, err := idx.QueryEvents(felt.EventFilter{
					FiberID:    f.ID,
					Types:      []string{felt.EventEditorial},
					Limit:      1,
					Descending: true,
				})
				if err != nil {
					return err
				}
				recentEditorial = renderRecentEditorial(editorialEvents)

				if detail == DepthFull {
					mech, err := idx.QueryEvents(felt.EventFilter{
						FiberID: f.ID,
						Types: []string{
							felt.EventAdd,
							felt.EventEdit,
							felt.EventExternalEdit,
						},
						Limit:      5,
						Descending: true,
					})
					if err != nil {
						return err
					}
					recentMechanical = mech
				}
			}
		}

		fmt.Print(renderFeltWithHistory(
			f, graph, detail, citations, consumers,
			recentEditorial, recentMechanical,
		))
		return nil
	},
}

func showCitationsFor(storage *felt.Storage, targetID string) ([]felt.Citation, error) {
	if !storage.IndexExists() {
		return storage.ScanCitations(targetID)
	}
	idx, err := storage.OpenIndexNoSync()
	if err != nil {
		if errors.Is(err, felt.ErrIndexBusy) {
			fmt.Fprintf(os.Stderr, "warning: index busy — scanning markdown for citations\n")
			return storage.ScanCitations(targetID)
		}
		return nil, err
	}
	defer idx.Close()
	return idx.Citations(targetID)
}

func showConsumersFor(storage *felt.Storage, targetID string) ([]felt.DataFlowConsumer, error) {
	if !storage.IndexExists() {
		return storage.ScanConsumers(targetID)
	}
	idx, err := storage.OpenIndexNoSync()
	if err != nil {
		if errors.Is(err, felt.ErrIndexBusy) {
			fmt.Fprintf(os.Stderr, "warning: index busy — scanning markdown for consumers\n")
			return storage.ScanConsumers(targetID)
		}
		return nil, err
	}
	defer idx.Close()
	return idx.Consumers(targetID)
}

// renderFeltWithHistory wraps renderFelt and splices in the Recent
// editorial line (between the metadata block and the body) plus an
// optional mechanical-events trailer at -d full.
func renderFeltWithHistory(
	f *felt.Felt,
	g *felt.Graph,
	detail string,
	citations []felt.Citation,
	consumers []felt.DataFlowConsumer,
	recentEditorial string,
	recentMechanical []felt.Event,
) string {
	out := renderFelt(f, g, detail, citations, consumers)
	if recentEditorial != "" {
		out = spliceRecentEditorial(out, recentEditorial)
	}
	if len(recentMechanical) > 0 {
		out += "\nRecent mechanical events:\n"
		for _, e := range recentMechanical {
			out += "  " + formatMechanicalLine(e) + "\n"
		}
	}
	return out
}

// spliceRecentEditorial inserts the Recent block right after the
// metadata header (before the blank line that precedes the body), so
// the most recent session summary is visible in the same eye-pass as
// status / outcome.
func spliceRecentEditorial(rendered, recent string) string {
	idx := indexOfBlankLine(rendered)
	if idx < 0 {
		return rendered + recent
	}
	return rendered[:idx] + recent + rendered[idx:]
}

func indexOfBlankLine(s string) int {
	for i := 0; i < len(s)-1; i++ {
		if s[i] == '\n' && s[i+1] == '\n' {
			return i + 1
		}
	}
	return -1
}

func formatMechanicalLine(e felt.Event) string {
	line := e.OccurredAt.Local().Format("2006-01-02 15:04:05") +
		" [" + e.Type + " " + e.Actor + "] hash=" + shortHash(e.ContentHash)
	if lines := intField(e.Payload, "size_lines"); lines > 0 {
		line += " (" + intToShortStr(lines) + " lines)"
	}
	if fields := stringSliceField(e.Payload, "fields_changed"); len(fields) > 0 {
		line += " — " + strings.Join(fields, ",")
	}
	return line
}

func intToShortStr(n int) string {
	return fmt.Sprintf("%d", n)
}

func init() {
	rootCmd.AddCommand(showCmd)
	showCmd.Flags().BoolVarP(&showBodyOnly, "body", "b", false, "Output the body plus its start line")
	showCmd.Flags().StringVarP(&showDetail, "detail", "d", "", "Detail level (name, compact, summary, full)")
	showCmd.Flags().BoolVar(&showCitations, "citations", false, "Output indexed narrative back-references only")
	showCmd.Flags().BoolVar(&showConsumers, "consumers", false, "Output indexed reverse data-flow consumers only")
	showCmd.Flags().StringVar(&showField, "field", "", "Output one frontmatter field by raw YAML key (shell-friendly formatting)")
}

type showBodyOutput struct {
	Body          string `json:"body" yaml:"body"`
	BodyStartLine int    `json:"body_start_line" yaml:"body_start_line"`
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

func outputShowSelection(v interface{}) error {
	if jsonOutput {
		return outputJSON(v)
	}
	data, err := yaml.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal show selection: %w", err)
	}
	fmt.Print(string(data))
	return nil
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
	case yaml.MappingNode, yaml.AliasNode, yaml.DocumentNode:
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
