package feltcli

import (
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
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
	Short: "Change a fiber's native fields or scalar frontmatter",
	Long: `Each flag rewrites one field; updated-at is stamped on every edit. -s closed
stamps closed-at; -s open or -s active clears it. Status changes do not alter
project-owned frontmatter. For a change smaller than the whole body, edit the file.

--set writes a top-level scalar to frontmatter felt does not own, read as
YAML so true and 12 keep their types; native keys, empty values, and keys
holding a mapping or list are refused. --unset removes any key felt does not
own, structured ones included.`,
	Example: `  felt edit analysis/covariance -s closed -o "jackknife, 200 patches"
  felt edit analysis/covariance --set horizon=stashed`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := felt.RequireStore(sysenv.OS(), changeDir)
		if err != nil {
			return err
		}
		scopeID := felt.CommandScope(sysenv.OS(), root, changeDir)
		// A fiber in the enclosing store is edited where it lives.
		target, err := felt.ResolveRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}
		storage = target.Storage
		f, err := storage.Read(target.ID)
		if err != nil {
			return err
		}

		hasFlags := len(collectChangedEditFields(cmd)) > 0
		if !hasFlags {
			return fmt.Errorf("no changes requested: use edit flags (use --body only when you intend to overwrite the full body)")
		}

		bodyOverwritten := false
		bodyCleared := false

		if cmd.Flags().Changed("name") {
			f.Name = editName
		}
		if cmd.Flags().Changed("status") {
			if err := f.SetStatus(editStatus, time.Now()); err != nil {
				return err
			}
		}
		if cmd.Flags().Changed("body") {
			if f.Body != "" && editBody != f.Body && !f.HasEmptyBody() {
				bodyOverwritten = true
			}
			if f.Body != "" && editBody == "" && !f.HasEmptyBody() {
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
			for _, tag := range splitListFlag(editTags) {
				f.AddTag(tag)
			}
		}
		if cmd.Flags().Changed("untag") {
			for _, tag := range splitListFlag(editUntag) {
				f.RemoveTag(tag)
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
		// Bump the durable recency anchor: a felt edit is a content write felt
		// itself records, so updated-at travels in git and seeds a fresh
		// clone's recency at this moment rather than mtime. Stamped before
		// Write so it lands in the file the mechanical event then hashes.
		f.Touch(time.Now())

		if err := storage.Write(f); err != nil {
			return err
		}

		switch {
		case bodyCleared:
			fmt.Printf("Updated %s%s (body cleared; previous content removed)\n", f.ID, target.Location())
		case bodyOverwritten:
			fmt.Printf("Updated %s%s (body overwritten)\n", f.ID, target.Location())
		default:
			fmt.Printf("Updated %s%s\n", f.ID, target.Location())
		}
		return nil
	},
}

// editFlagNames is the canonical list of edit's top-level metadata flags, in
// the order they are reported. Drives both the "any change requested?" gate and
// the mechanical event's fields_changed payload.
var editFlagNames = []string{"name", "status", "due", "tag", "untag", "body", "outcome", "set", "unset"}

// collectChangedEditFields lists which top-level edit flags the user actually
// flipped, so the mechanical event payload reflects intent.
func collectChangedEditFields(cmd *cobra.Command) []string {
	var out []string
	for _, name := range editFlagNames {
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
	editCmd.GroupID = groupFibers
	rootCmd.AddCommand(editCmd)
	initEditFlags()
}

// initEditFlags registers edit's flag set.
func initEditFlags() {
	editCmd.Flags().StringVar(&editName, "name", "", "Set name")
	editCmd.Flags().StringVarP(&editStatus, "status", "s", "", "Set status (open, active, closed; empty clears)")
	editCmd.Flags().StringArrayVarP(&editTags, "tag", "t", nil, "Add tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringArrayVar(&editUntag, "untag", nil, "Remove tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Replace the whole body")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
	editCmd.Flags().StringArrayVar(&editSet, "set", nil, "Set a top-level scalar key felt does not own (key=value; repeatable)")
	editCmd.Flags().StringArrayVar(&editUnset, "unset", nil, "Remove a top-level key felt does not own (repeatable)")
}
