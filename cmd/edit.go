package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
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
	editSet     []string
	editUnset   []string
)

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's native metadata via flags",
	Long: `Modifies a felt's native metadata via flags.

Examples:
  felt edit abc123 --name "New name" -s active
  felt edit abc123 --tag decision --untag stale
  felt edit abc123 --body "Full replacement body text"  # overwrites body
  felt edit abc123 --outcome "What landed"
  felt edit abc123 --set horizon=stashed --set cold=true  # opaque scalar frontmatter
  felt edit abc123 --unset horizon --unset cold

--set/--unset write top-level scalar frontmatter felt does not parse natively
(the value is read as a YAML scalar, so true/false/123 keep their type). Native
keys have dedicated flags; use those.`,
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

		hasFlags := cmd.Flags().Changed("name") ||
			cmd.Flags().Changed("status") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("tag") ||
			cmd.Flags().Changed("untag") ||
			cmd.Flags().Changed("body") ||
			cmd.Flags().Changed("outcome") ||
			cmd.Flags().Changed("set") ||
			cmd.Flags().Changed("unset")
		if !hasFlags {
			return fmt.Errorf("no changes requested: use edit flags (use --body only when you intend to overwrite the full body)")
		}

		bodyOverwritten := false
		bodyCleared := false

		if cmd.Flags().Changed("name") {
			f.Name = editName
		}
		if cmd.Flags().Changed("status") {
			switch editStatus {
			case felt.StatusOpen, felt.StatusActive:
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
		if cmd.Flags().Changed("unset") {
			for _, key := range editUnset {
				if err := unsetExtraField(f, key); err != nil {
					return err
				}
			}
		}
		if cmd.Flags().Changed("set") {
			for _, assignment := range editSet {
				if err := setExtraField(f, assignment); err != nil {
					return err
				}
			}
		}
		if err := storage.Write(f); err != nil {
			return err
		}

		fieldsChanged := collectChangedEditFields(cmd)
		if data, err := os.ReadFile(storage.Path(f.ID)); err == nil {
			recordMechanical(storage, f.ID, felt.EventEdit, fieldsChanged, data)
		}
		requestAsyncIndexSync(storage)

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

// collectChangedEditFields lists which top-level edit flags the user actually
// flipped, so the mechanical event payload reflects intent.
func collectChangedEditFields(cmd *cobra.Command) []string {
	candidates := []string{"name", "status", "due", "tag", "untag", "body", "outcome", "set", "unset"}
	var out []string
	for _, name := range candidates {
		if cmd.Flags().Changed(name) {
			out = append(out, name)
		}
	}
	return out
}

// setExtraField applies one `--set key=value` assignment: it installs a
// non-native top-level scalar frontmatter key. The value is read as a YAML
// scalar so booleans and numbers keep their type (`cold=true` → bool true, not
// the string "true"), which downstream consumers that branch on type rely on.
func setExtraField(f *felt.Felt, assignment string) error {
	key, rawValue, found := strings.Cut(assignment, "=")
	if !found {
		return fmt.Errorf("invalid --set %q: expected key=value", assignment)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("invalid --set %q: empty key", assignment)
	}
	if felt.IsNativeFrontmatterKey(key) {
		return fmt.Errorf("--set %q targets a native field; use its dedicated flag (e.g. --%s)", key, key)
	}
	if strings.TrimSpace(rawValue) == "" {
		return fmt.Errorf("--set %q has an empty value; use --unset %s to remove the key", key, key)
	}

	var value any
	if err := yaml.Unmarshal([]byte(rawValue), &value); err != nil {
		return fmt.Errorf("--set %q: value is not valid YAML: %w", key, err)
	}
	switch value.(type) {
	case map[string]any, []any:
		return fmt.Errorf("--set %q only writes scalar values, got a %s", key, "mapping/sequence")
	}
	// Refuse to scalar-clobber a key whose current value is structured
	// (e.g. the `shuttle:` block or an `inputs:` sequence). --set is for
	// scalar frontmatter; structured edits belong to their owning tool.
	if existing := f.ExtraFields[key]; existing != nil {
		switch existing.Kind {
		case yaml.MappingNode, yaml.SequenceNode:
			return fmt.Errorf("--set %q would overwrite a structured value; edit it via its owning tool", key)
		}
	}
	return f.SetExtraField(key, value)
}

// unsetExtraField applies one `--unset key`: it removes a non-native top-level
// frontmatter key. Native keys are refused — clear those with their own flags
// (e.g. `--due ""`).
func unsetExtraField(f *felt.Felt, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("invalid --unset: empty key")
	}
	if felt.IsNativeFrontmatterKey(key) {
		return fmt.Errorf("--unset %q targets a native field; clear it with its dedicated flag (e.g. --%s \"\")", key, key)
	}
	return f.SetExtraField(key, nil)
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
	editCmd.Flags().StringArrayVar(&editSet, "set", nil, "Set a non-native top-level scalar key (key=value; YAML-typed; repeatable)")
	editCmd.Flags().StringArrayVar(&editUnset, "unset", nil, "Remove a non-native top-level key (repeatable)")
}
