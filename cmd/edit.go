package cmd

import (
	"fmt"
	"os"
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

	editDecision        string
	editLabel           string
	editRationale       string
	editDefault         string
	editOptions         []string
	editOptionIDs       []string
	editOptionLabels    []string
	editOptionExcluded  []string
	editOptionReasons   []string
	editInputs          []string
	editInsights        []string
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
  felt edit abc123 --input 'catalog:data:build-mocks.galaxy-catalog:Mock galaxy catalog'
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
			cmd.Flags().Changed("option-id") ||
			cmd.Flags().Changed("option-label") ||
			cmd.Flags().Changed("option-excluded") ||
			cmd.Flags().Changed("option-reason") ||
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

		// Collect the list of fields the user actually changed, for the
		// mechanical event payload.
		fieldsChanged := collectChangedEditFields(cmd)
		if data, err := os.ReadFile(storage.Path(f.ID)); err == nil {
			recordMechanical(storage, f.ID, felt.EventEdit, fieldsChanged, data)
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

// collectChangedEditFields lists which top-level edit flags the user
// actually flipped, so the mechanical event payload reflects intent.
func collectChangedEditFields(cmd *cobra.Command) []string {
	candidates := []string{
		"name", "status", "due", "tag", "untag", "body", "outcome",
		"decision", "label", "rationale", "default", "option",
		"option-id", "option-label", "option-excluded", "option-reason",
		"input", "insight",
	}
	var out []string
	for _, name := range candidates {
		if cmd.Flags().Changed(name) {
			out = append(out, name)
		}
	}
	return out
}

func init() {
	rootCmd.AddCommand(editCmd)
	initEditFlags()
}

// initEditFlags registers (or re-registers) edit's flag set. Exposed so tests
// can ResetFlags() between invocations to clear Changed state.
func initEditFlags() {
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
	editCmd.Flags().StringArrayVar(&editOptions, "option", nil, "Add/update a decision option: id:label[:excluded[:reason]] (repeatable, requires --decision). Use \\: for a literal colon and \\\\ for a literal backslash inside any field. For labels with many special characters, prefer --option-id/--option-label/--option-excluded/--option-reason.")
	editCmd.Flags().StringArrayVar(&editOptionIDs, "option-id", nil, "Structured form: decision option ID (repeatable; position-correlated with --option-label/--option-excluded/--option-reason, requires --decision)")
	editCmd.Flags().StringArrayVar(&editOptionLabels, "option-label", nil, "Structured form: decision option label (repeatable; must match --option-id count)")
	editCmd.Flags().StringArrayVar(&editOptionExcluded, "option-excluded", nil, "Structured form: excluded flag per option (true/false/yes/no/included/excluded; repeatable, optional)")
	editCmd.Flags().StringArrayVar(&editOptionReasons, "option-reason", nil, "Structured form: excluded reason per option (repeatable, optional)")
	editCmd.Flags().StringArrayVar(&editInputs, "input", nil, "Add/update an input: id[:type[:from[:description]]] (repeatable)")
	editCmd.Flags().StringArrayVar(&editInsights, "insight", nil, "Add/update an insight: id:claim (repeatable)")
}

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" -> ["claim", "tapestry:foo"]
func applyStructuredEditFlags(cmd *cobra.Command, f *felt.Felt) error {
	structuredOptionChanged := cmd.Flags().Changed("option-id") ||
		cmd.Flags().Changed("option-label") ||
		cmd.Flags().Changed("option-excluded") ||
		cmd.Flags().Changed("option-reason")
	if cmd.Flags().Changed("label") || cmd.Flags().Changed("rationale") || cmd.Flags().Changed("default") || cmd.Flags().Changed("option") || structuredOptionChanged {
		if !cmd.Flags().Changed("decision") {
			return fmt.Errorf("--label, --rationale, --default, --option, and --option-* require --decision")
		}
	}

	if cmd.Flags().Changed("option") && structuredOptionChanged {
		return fmt.Errorf("mix of --option and --option-id/--option-label/--option-excluded/--option-reason: pick one form (compact --option with \\: escapes, or the structured --option-* flags)")
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
		if structuredOptionChanged {
			if decision.Options == nil {
				decision.Options = map[string]felt.ASTRADecisionOption{}
			}
			ids, options, err := parseStructuredDecisionOptions(editOptionIDs, editOptionLabels, editOptionExcluded, editOptionReasons)
			if err != nil {
				return err
			}
			for i, id := range ids {
				decision.Options[id] = options[i]
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
	parts, err := splitEscapedColon(raw, 4)
	if err != nil {
		return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: %w", raw, err)
	}
	if len(parts) < 2 {
		return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: want id:label[:excluded[:reason]] (use \\: for a literal colon)", raw)
	}

	id := strings.TrimSpace(parts[0])
	label := strings.TrimSpace(parts[1])
	if id == "" || label == "" {
		return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: id and label are required", raw)
	}

	option := felt.ASTRADecisionOption{Label: label}
	if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
		excluded, err := parseExcludedFlag(parts[2])
		if err != nil {
			return "", felt.ASTRADecisionOption{}, fmt.Errorf("invalid --option %q: %w", raw, err)
		}
		option.Excluded = excluded
	}
	if len(parts) == 4 {
		option.ExcludedReason = strings.TrimSpace(parts[3])
	}
	if option.ExcludedReason != "" {
		option.Excluded = true
	}
	return id, option, nil
}

// splitEscapedColon splits s on unescaped ':' up to `max` parts (matching
// strings.SplitN semantics), then unescapes `\:` → `:` and `\\` → `\` in each
// resulting field. A trailing lone `\` is rejected.
func splitEscapedColon(s string, max int) ([]string, error) {
	var parts []string
	var cur strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' {
			if i+1 >= len(s) {
				return nil, fmt.Errorf("trailing backslash has no escaped character")
			}
			next := s[i+1]
			switch next {
			case ':', '\\':
				cur.WriteByte(next)
				i++
			default:
				// Preserve unknown escape sequences literally (forward-compatible).
				cur.WriteByte(c)
				cur.WriteByte(next)
				i++
			}
			continue
		}
		if c == ':' && (max <= 0 || len(parts)+1 < max) {
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	parts = append(parts, cur.String())
	return parts, nil
}

// parseExcludedFlag interprets the user-facing excluded indicator.
func parseExcludedFlag(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "included", "false", "no":
		return false, nil
	case "excluded", "true", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("excluded field must be excluded/true/yes or included/false/no, got %q", raw)
	}
}

// parseStructuredDecisionOptions correlates the parallel --option-* flag
// arrays by position. ids and labels are required and must match in length;
// excluded and reasons, when provided, must not exceed len(ids).
func parseStructuredDecisionOptions(ids, labels, excluded, reasons []string) ([]string, []felt.ASTRADecisionOption, error) {
	if len(ids) == 0 {
		return nil, nil, fmt.Errorf("--option-id is required when using the structured option form")
	}
	if len(labels) != len(ids) {
		return nil, nil, fmt.Errorf("--option-label count (%d) must match --option-id count (%d)", len(labels), len(ids))
	}
	if len(excluded) > len(ids) {
		return nil, nil, fmt.Errorf("--option-excluded count (%d) exceeds --option-id count (%d)", len(excluded), len(ids))
	}
	if len(reasons) > len(ids) {
		return nil, nil, fmt.Errorf("--option-reason count (%d) exceeds --option-id count (%d)", len(reasons), len(ids))
	}

	outIDs := make([]string, len(ids))
	opts := make([]felt.ASTRADecisionOption, len(ids))
	for i := range ids {
		id := strings.TrimSpace(ids[i])
		label := strings.TrimSpace(labels[i])
		if id == "" || label == "" {
			return nil, nil, fmt.Errorf("--option-id and --option-label must be non-empty (position %d)", i)
		}
		opt := felt.ASTRADecisionOption{Label: label}
		if i < len(excluded) {
			flag, err := parseExcludedFlag(excluded[i])
			if err != nil {
				return nil, nil, fmt.Errorf("--option-excluded[%d]: %w", i, err)
			}
			opt.Excluded = flag
		}
		if i < len(reasons) {
			opt.ExcludedReason = strings.TrimSpace(reasons[i])
		}
		if opt.ExcludedReason != "" {
			opt.Excluded = true
		}
		outIDs[i] = id
		opts[i] = opt
	}
	return outIDs, opts, nil
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
