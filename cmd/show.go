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
	showInputs    bool
	showInsights  bool
	showCitations bool
	showConsumers bool
	showDecision  string
	showDecisions bool
	showField     string
)

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show details of a felt",
	Long: `Displays details of a felt at the requested detail level.

Detail levels control progressive disclosure:
  name     Name and tags only
  compact  Metadata, outcome, and frontmatter counts
  summary  Compact + lede paragraph + concise frontmatter summary
  full     Everything (default)

Targeted views:
  --body            return the body plus its start line for editing
  --citations       return indexed narrative back-references only
  --consumers       return indexed reverse data-flow consumers only
  --decisions       return all decisions only
  --decision <id>   return one decision only
  --field <name>    return one frontmatter field by raw YAML key, formatted
                    for shell consumers (scalars on one line, sequences of
                    scalars one-per-line, structured values as YAML)
  --inputs          return inputs only
  --insights        return insights only`,
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
			showInputs,
			showInsights,
			showDecisions,
			showDecision != "",
			showField != "",
		} {
			if active {
				selectorCount++
			}
		}
		if selectorCount > 1 {
			return fmt.Errorf("show selectors are mutually exclusive: choose only one of --body, --citations, --consumers, --decisions, --decision, --field, --inputs, or --insights")
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
				idx, err := storage.OpenIndex()
				if err != nil {
					if errors.Is(err, felt.ErrIndexBusy) {
						fmt.Fprintf(os.Stderr, "warning: index busy, citations unavailable\n")
						return outputShowSelection([]felt.Citation{})
					}
					return err
				}
				defer idx.Close()
				citations, err := idx.Citations(f.ID)
				if err != nil {
					return err
				}
				return outputShowSelection(citations)
			}
			if showConsumers {
				idx, err := storage.OpenIndex()
				if err != nil {
					if errors.Is(err, felt.ErrIndexBusy) {
						fmt.Fprintf(os.Stderr, "warning: index busy, consumers unavailable\n")
						return outputShowSelection([]felt.DataFlowConsumer{})
					}
					return err
				}
				defer idx.Close()
				consumers, err := idx.Consumers(f.ID)
				if err != nil {
					return err
				}
				return outputShowSelection(consumers)
			}
			if showDecisions {
				return outputShowSelection(f.Decisions)
			}
			if showDecision != "" {
				decision, ok := f.Decisions[showDecision]
				if !ok {
					return fmt.Errorf("decision %q not found in %s", showDecision, f.ID)
				}
				return outputShowSelection(map[string]felt.Decision{showDecision: decision})
			}
			if showInputs {
				return outputShowSelection(f.Inputs)
			}
			if showInsights {
				return outputShowSelection(f.Insights)
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
			idx, idxErr := storage.OpenIndex()
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

				// Most recent editorial event surfaces inside the metadata
				// block; mechanical activity at -d full goes after the body.
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
							felt.EventRm,
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
	// Split on the first blank line that separates header from body.
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
	showCmd.Flags().BoolVar(&showDecisions, "decisions", false, "Output decisions only")
	showCmd.Flags().StringVar(&showDecision, "decision", "", "Output one decision by ID")
	showCmd.Flags().BoolVar(&showInputs, "inputs", false, "Output inputs only")
	showCmd.Flags().BoolVar(&showInsights, "insights", false, "Output insights only")
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
// raw YAML key, in a shape shell consumers can rely on:
//
//   - missing key       → empty stdout, exit 0 (let `[[ -z "$(...)" ]]` work)
//   - scalar (string,
//     int, bool, ts)    → value + "\n", with the original YAML scalar text
//                         preserved (no Go-side reformatting / requoting)
//   - sequence of
//     scalars           → one scalar per line
//   - mapping or
//     sequence of maps  → YAML-serialized (matches --decisions / --inputs
//                         shape so structured fields stay machine-readable)
//
// Reads raw frontmatter rather than parsed Felt fields, so portolan-side
// keys felt doesn't model — `tempered`, `depends-on`, anything custom —
// are addressable by the same flag. Designed for shell defence-in-depth
// gates that previously had to grep pretty `felt show` output (and
// false-positived on prose echoing the keyword they were checking; see
// the kanban worker's status-grep gotcha).
//
// `--field name` returns the raw frontmatter `name`, not the canonical
// post-legacy name; for fibers migrated from `title:` the raw key may
// differ. v0 trade-off: simpler, predictable, easy to verify.
func outputShowField(storage *felt.Storage, f *felt.Felt, key string) error {
	if jsonOutput {
		// JSON mode bails out — the unstructured shape this flag emits is the
		// whole point. If you need the parsed field as JSON, drop the flag and
		// pipe `--json` instead.
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
		return nil // empty frontmatter; treat as missing key
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
	return nil // key not present; empty output, exit 0
}

// emitFieldNode writes a yaml.Node to stdout in --field's contract:
// scalars unquoted on one line, sequences-of-scalars line-per-element,
// everything else as YAML. The fall-through path uses yaml.Marshal so
// any structure (mapping, sequence-of-mappings, mixed sequences) round-
// trips through a regular YAML serializer rather than something we
// invent inline.
func emitFieldNode(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		// `Value` preserves the source text for plain/quoted scalars *and*
		// the unwrapped content for block-scalar (`|`/`>`) outcomes —
		// exactly what shell consumers want for both `status` and
		// `outcome`. Single trailing newline; `printf %s` would too.
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
