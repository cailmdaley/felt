package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// Edit command flags
var (
	editName    string
	editStatus  string
	editDue     string
	editTags    []string
	editUntag   []string
	editBody    string
	editOutcome string

	editDecision  string
	editLabel     string
	editRationale string
	editDefault   string
	editOptions   []string
	editInputs    []string
	editInsights  []string
)

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's properties via flags",
	Long: `Modifies a felt's properties via flags.

Examples:
  felt edit abc123 --name "New name" -s active
  felt edit abc123 --tag decision --untag stale
  felt edit abc123 --body "Full replacement body text"  # overwrites body
  felt edit abc123 --decision covariance --label "Covariance method" --option 'glass:GLASS mocks' --option 'analytic:Analytic:excluded:underestimates tails'
  felt edit abc123 --input 'catalog:data:upstream.posterior:Posterior sample'
  felt edit abc123 --insight 'stability:Posterior is stable to jackknife choice'`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		target, err := storage.FindMetadataInScope(scopeID, args[0])
		if err != nil {
			return err
		}
		f, err := storage.Read(target.ID)
		if err != nil {
			return err
		}

		// Check if any modification flags were provided
		hasFlags := cmd.Flags().Changed("name") ||
			cmd.Flags().Changed("status") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("tag") ||
			cmd.Flags().Changed("untag") ||
			cmd.Flags().Changed("body") ||
			cmd.Flags().Changed("outcome") ||
			cmd.Flags().Changed("decision") ||
			cmd.Flags().Changed("label") ||
			cmd.Flags().Changed("rationale") ||
			cmd.Flags().Changed("default") ||
			cmd.Flags().Changed("option") ||
			cmd.Flags().Changed("input") ||
			cmd.Flags().Changed("insight")

		if !hasFlags {
			return fmt.Errorf("no changes requested: use edit flags (use --body only when you intend to overwrite the full body)")
		}

		bodyOverwritten := false
		bodyCleared := false

		// Apply flag modifications
		if cmd.Flags().Changed("name") {
			f.Name = editName
		}
		if cmd.Flags().Changed("status") {
			switch editStatus {
			case felt.StatusOpen, felt.StatusActive:
				// Reopen if closed
				if f.IsClosed() {
					f.ClosedAt = nil
				}
				f.Status = editStatus
			case felt.StatusClosed:
				if !f.IsClosed() {
					now := time.Now()
					f.Status = felt.StatusClosed
					f.ClosedAt = &now
				}
			case "":
				// Clear status (exit tracking)
				f.Status = ""
				f.ClosedAt = nil
			default:
				return fmt.Errorf("invalid status %q (valid: open, active, closed, or empty to clear)", editStatus)
			}
		}
		if cmd.Flags().Changed("body") {
			if f.Body != "" && editBody != f.Body && !f.HasScaffoldOnlyBody() {
				bodyOverwritten = true
			}
			if f.Body != "" && editBody == "" && !f.HasScaffoldOnlyBody() {
				bodyCleared = true
			}
			f.Body = editBody
		}
		if cmd.Flags().Changed("outcome") {
			f.Outcome = editOutcome
		}
		if cmd.Flags().Changed("due") {
			if editDue == "" {
				f.Due = nil
			} else {
				due, err := time.Parse("2006-01-02", editDue)
				if err != nil {
					return fmt.Errorf("invalid due date (use YYYY-MM-DD): %w", err)
				}
				f.Due = &due
			}
		}
		if cmd.Flags().Changed("tag") {
			for _, raw := range editTags {
				for _, tag := range splitTags(raw) {
					f.AddTag(tag)
				}
			}
		}
		if cmd.Flags().Changed("untag") {
			for _, raw := range editUntag {
				for _, tag := range splitTags(raw) {
					f.RemoveTag(tag)
				}
			}
		}
		if err := applyStructuredEditFlags(cmd, f); err != nil {
			return err
		}
		if err := storage.Write(f); err != nil {
			return err
		}

		switch {
		case bodyCleared:
			fmt.Printf("Updated %s (body cleared; previous content removed)\n", f.ID)
		case bodyOverwritten:
			fmt.Printf("Updated %s (body overwritten)\n", f.ID)
		default:
			fmt.Printf("Updated %s\n", f.ID)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(editCmd)

	// Edit command flags
	editCmd.Flags().StringVar(&editName, "name", "", "Set name")
	editCmd.Flags().StringVarP(&editStatus, "status", "s", "", "Set status (open, active, closed)")
	editCmd.Flags().StringArrayVarP(&editTags, "tag", "t", nil, "Add tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringArrayVar(&editUntag, "untag", nil, "Remove tag(s)")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Replace full body text (destructive overwrite)")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
	editCmd.Flags().StringVar(&editDecision, "decision", "", "Create or update one decision by ID")
	editCmd.Flags().StringVar(&editLabel, "label", "", "Set the label for --decision")
	editCmd.Flags().StringVar(&editRationale, "rationale", "", "Set the rationale for --decision")
	editCmd.Flags().StringVar(&editDefault, "default", "", "Set the selected option ID for --decision")
	editCmd.Flags().StringArrayVar(&editOptions, "option", nil, "Add/update a decision option: id:label[:excluded[:reason]] (repeatable, requires --decision)")
	editCmd.Flags().StringArrayVar(&editInputs, "input", nil, "Add/update an input: id[:type[:from[:description]]] (repeatable)")
	editCmd.Flags().StringArrayVar(&editInsights, "insight", nil, "Add/update an insight: id:claim (repeatable)")
}

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" -> ["claim", "tapestry:foo"]
func applyStructuredEditFlags(cmd *cobra.Command, f *felt.Felt) error {
	if cmd.Flags().Changed("label") || cmd.Flags().Changed("rationale") || cmd.Flags().Changed("default") || cmd.Flags().Changed("option") {
		if !cmd.Flags().Changed("decision") {
			return fmt.Errorf("--label, --rationale, --default, and --option require --decision")
		}
	}

	if cmd.Flags().Changed("decision") {
		decisionID := strings.TrimSpace(editDecision)
		if decisionID == "" {
			return fmt.Errorf("--decision requires a non-empty decision ID")
		}
		if f.Decisions == nil {
			f.Decisions = map[string]felt.ASTRADecision{}
		}
		decision := f.Decisions[decisionID]
		if cmd.Flags().Changed("label") {
			decision.Label = strings.TrimSpace(editLabel)
		}
		if cmd.Flags().Changed("rationale") {
			decision.Rationale = strings.TrimSpace(editRationale)
		}
		if cmd.Flags().Changed("default") {
			decision.Default = strings.TrimSpace(editDefault)
		}
		if cmd.Flags().Changed("option") {
			if decision.Options == nil {
				decision.Options = map[string]felt.ASTRADecisionOption{}
			}
			for _, raw := range editOptions {
				id, option, err := parseDecisionOption(raw)
				if err != nil {
					return err
				}
				decision.Options[id] = option
			}
		}
		f.Decisions[decisionID] = decision
	}

	if cmd.Flags().Changed("input") {
		for _, raw := range editInputs {
			input, err := parseInputSpec(raw)
			if err != nil {
				return err
			}
			f.Inputs = upsertInput(f.Inputs, input)
		}
	}

	if cmd.Flags().Changed("insight") {
		if f.Insights == nil {
			f.Insights = map[string]felt.ASTRAInsight{}
		}
		for _, raw := range editInsights {
			id, insight, err := parseInsightSpec(raw)
			if err != nil {
				return err
			}
			f.Insights[id] = insight
		}
	}

	return nil
}

func parseDecisionOption(raw string) (string, felt.ASTRADecisionOption, error) {
	parts := strings.SplitN(raw, ":", 4)
	if len(parts) < 2 {
		return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: want id:label[:excluded[:reason]]", raw)
	}

	id := strings.TrimSpace(parts[0])
	label := strings.TrimSpace(parts[1])
	if id == "" || label == "" {
		return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: id and label are required", raw)
	}

	option := felt.ASTRADecisionOption{Label: label}
	if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
		switch strings.ToLower(strings.TrimSpace(parts[2])) {
		case "excluded", "true", "yes":
			option.Excluded = true
		case "included", "false", "no":
			option.Excluded = false
		default:
			return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: third field must be excluded/true/yes or included/false/no", raw)
		}
	}
	if len(parts) == 4 {
		option.ExcludedReason = strings.TrimSpace(parts[3])
	}
	if option.ExcludedReason != "" {
		option.Excluded = true
	}
	return id, option, nil
}

func parseInputSpec(raw string) (felt.ASTRAInput, error) {
	parts := strings.SplitN(raw, ":", 4)
	id := strings.TrimSpace(parts[0])
	if id == "" {
		return felt.ASTRAInput{}, fmt.Errorf("invalid --input %q: id is required", raw)
	}

	input := felt.ASTRAInput{ID: id}
	if len(parts) >= 2 {
		input.Type = strings.TrimSpace(parts[1])
	}
	if len(parts) >= 3 {
		input.From = strings.TrimSpace(parts[2])
	}
	if len(parts) == 4 {
		input.Description = strings.TrimSpace(parts[3])
	}
	return input, nil
}

func parseInsightSpec(raw string) (string, felt.ASTRAInsight, error) {
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) != 2 {
		return "", felt.ASTRAInsight{}, fmt.Errorf("invalid --insight %q: want id:claim", raw)
	}

	id := strings.TrimSpace(parts[0])
	claim := strings.TrimSpace(parts[1])
	if id == "" || claim == "" {
		return "", felt.ASTRAInsight{}, fmt.Errorf("invalid --insight %q: id and claim are required", raw)
	}
	return id, felt.ASTRAInsight{Claim: claim}, nil
}

func upsertInput(inputs []felt.ASTRAInput, input felt.ASTRAInput) []felt.ASTRAInput {
	for i := range inputs {
		if inputs[i].ID == input.ID {
			inputs[i] = input
			return inputs
		}
	}
	return append(inputs, input)
}
