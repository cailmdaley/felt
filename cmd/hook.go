package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var hookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Commands for integration hooks",
	Long:  `Commands for integrating felt with external tools like Claude Code.`,
}

var hookSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Output workflow context for session start",
	Long: `Outputs felt workflow context for use in Claude Code SessionStart hooks.

Prints active fibers (currently being worked on) and ready fibers
(open with all dependencies closed) in a format suitable for AI context.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			// Not in a felt repository - output minimal context
			fmt.Print(minimalOutput())
			return nil
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		output := formatSessionOutput(felts, g)
		fmt.Print(output)
		return nil
	},
}

var primeCmd = &cobra.Command{
	Use:   "prime",
	Short: "Output full context for session recovery",
	Long: `Outputs comprehensive felt context for recovering context after
compaction, clear, or starting a new session.

Shows active fibers with their full bodies, ready fibers with descriptions,
and recently closed fibers for context.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			fmt.Println("*No felt repository in current directory.*")
			return nil
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		output := formatPrimeOutput(felts, g)
		fmt.Print(output)
		return nil
	},
}

var hookSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync TodoWrite items to felt fibers",
	Long: `Syncs Claude Code's TodoWrite tool output to felt fibers.

This hook reads TodoWrite JSON from stdin and:
- Creates new fibers for new todos (kind: todo)
- Updates fiber status when todo status changes
- Closes fibers when todos are completed
- Closes fibers with "Abandoned from TodoWrite" when todos disappear

Configure in ~/.claude/settings.json:
  "PostToolUse": [{
    "matcher": "TodoWrite",
    "hooks": [{"type": "command", "command": "felt hook sync"}]
  }]`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runHookSync(os.Stdin)
	},
}

func init() {
	rootCmd.AddCommand(hookCmd)
	rootCmd.AddCommand(primeCmd)
	hookCmd.AddCommand(hookSessionCmd)
	hookCmd.AddCommand(hookSyncCmd)
}

func minimalOutput() string {
	return `# Felt Workflow Context

> **Context Recovery**: Run ` + "`felt prime`" + ` after compaction, clear, or new session

*No felt repository in current directory.*

## Core Rules
- Track **work** that spans sessions, has dependencies, or emerges during work
- Track **decisions** — what was decided, why, and how decisions depend on each other
- Closing reason (` + "`-r`" + `) is the documentation: capture the outcome, the reasoning, what was learned
- TodoWrite is fine for simple single-session linear tasks
- When in doubt, prefer felt—persistence you don't need is better than lost context
`
}

func formatSessionOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Workflow Context\n\n")
	sb.WriteString("> **Context Recovery**: Run `felt prime` after compaction, clear, or new session\n\n")

	// Active fibers
	var active []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		}
	}

	// Sort by priority, then creation time
	sort.Slice(active, func(i, j int) bool {
		if active[i].Priority != active[j].Priority {
			return active[i].Priority < active[j].Priority
		}
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFiberEntry("◐", f))
		}
		sb.WriteString("\n")
	}

	// Ready fibers (open with all deps closed)
	ready := g.Ready()
	if len(ready) > 0 {
		sb.WriteString("## Ready Fibers (unblocked)\n\n")
		for _, f := range ready {
			sb.WriteString(formatFiberEntry("○", f))
		}
		sb.WriteString("\n")
	}

	// If nothing active or ready, note that
	if len(active) == 0 && len(ready) == 0 {
		sb.WriteString("*No active or ready fibers.*\n\n")
	}

	// Core rules
	sb.WriteString("## Core Rules\n")
	sb.WriteString("- Track **work** that spans sessions, has dependencies, or emerges during work\n")
	sb.WriteString("- Track **decisions** — what was decided, why, and how decisions depend on each other\n")
	sb.WriteString("- Closing reason (`-r`) is the documentation: capture the outcome, the reasoning, what was learned\n")
	sb.WriteString("- TodoWrite is fine for simple single-session linear tasks\n")
	sb.WriteString("- When in doubt, prefer felt—persistence you don't need is better than lost context\n")

	return sb.String()
}

// formatFiberEntry formats a single fiber for hook output.
// Two-line format: icon + ID, then indented title with metadata.
func formatFiberEntry(icon string, f *felt.Felt) string {
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

func formatPrimeOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Context Recovery\n\n")

	// Collect active, ready, and recently closed fibers
	var active []*felt.Felt
	var closed []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		} else if f.IsClosed() {
			closed = append(closed, f)
		}
	}

	// Sort active by priority, then creation time
	sort.Slice(active, func(i, j int) bool {
		if active[i].Priority != active[j].Priority {
			return active[i].Priority < active[j].Priority
		}
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	// Sort closed by closed time (most recent first)
	sort.Slice(closed, func(i, j int) bool {
		// Handle nil ClosedAt (shouldn't happen but be safe)
		if closed[i].ClosedAt == nil {
			return false
		}
		if closed[j].ClosedAt == nil {
			return true
		}
		return closed[i].ClosedAt.After(*closed[j].ClosedAt)
	})

	// Take only the 5 most recently closed
	if len(closed) > 5 {
		closed = closed[:5]
	}

	ready := g.Ready()

	// Active fibers with full details
	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFiberDetail(f))
		}
	}

	// Ready fibers with descriptions
	if len(ready) > 0 {
		sb.WriteString("## Ready Fibers\n\n")
		for _, f := range ready {
			sb.WriteString(formatFiberDetail(f))
		}
	}

	// If nothing active or ready
	if len(active) == 0 && len(ready) == 0 {
		sb.WriteString("*No active or ready fibers.*\n\n")
	}

	// Recently closed fibers for context
	if len(closed) > 0 {
		sb.WriteString("## Recently Closed\n\n")
		for _, f := range closed {
			sb.WriteString(formatClosedFiberSummary(f))
		}
	}

	return sb.String()
}

// formatFiberDetail formats a fiber with full details for prime output.
func formatFiberDetail(f *felt.Felt) string {
	var sb strings.Builder

	// Header line
	icon := "○"
	if f.IsActive() {
		icon = "◐"
	}
	kindStr := ""
	if f.Kind != felt.DefaultKind {
		kindStr = fmt.Sprintf(" [%s]", f.Kind)
	}
	sb.WriteString(fmt.Sprintf("### %s %s%s\n", icon, f.Title, kindStr))
	sb.WriteString(fmt.Sprintf("ID: `%s`\n", f.ID))

	// Dependencies
	if len(f.DependsOn) > 0 {
		sb.WriteString(fmt.Sprintf("Depends on: %s\n", strings.Join(f.DependsOn, ", ")))
	}

	// Body (truncated if very long)
	if f.Body != "" {
		body := f.Body
		if len(body) > 500 {
			body = body[:500] + "..."
		}
		sb.WriteString(fmt.Sprintf("\n%s\n", body))
	}

	sb.WriteString("\n")
	return sb.String()
}

// formatClosedFiberSummary formats a closed fiber with its close reason.
func formatClosedFiberSummary(f *felt.Felt) string {
	var sb strings.Builder

	kindStr := ""
	if f.Kind != felt.DefaultKind {
		kindStr = fmt.Sprintf(" [%s]", f.Kind)
	}
	sb.WriteString(fmt.Sprintf("### ● %s%s\n", f.Title, kindStr))
	sb.WriteString(fmt.Sprintf("ID: `%s`\n", f.ID))

	if f.CloseReason != "" {
		reason := f.CloseReason
		if len(reason) > 200 {
			reason = reason[:200] + "..."
		}
		sb.WriteString(fmt.Sprintf("Closed: %s\n", reason))
	}

	sb.WriteString("\n")
	return sb.String()
}

// =============================================================================
// TodoWrite Sync Hook
// =============================================================================

const (
	todoKind        = "todo"
	mappingFileName = "todo-mapping.json"
)

// hookEnvelope is the structure Claude Code sends to PostToolUse hooks.
type hookEnvelope struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// todoWriteInput is the structure of TodoWrite's tool_input.
type todoWriteInput struct {
	Todos []todoItem `json:"todos"`
}

// todoItem represents a single TodoWrite item.
type todoItem struct {
	Content    string `json:"content"`
	Status     string `json:"status"`
	ActiveForm string `json:"activeForm,omitempty"`
}

// todoMapping maps todo content strings to fiber IDs.
type todoMapping map[string]string

// runHookSync processes TodoWrite output and syncs to felt fibers.
func runHookSync(r io.Reader) error {
	// Read stdin
	input, err := io.ReadAll(r)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	if len(input) == 0 {
		return nil // Empty input, nothing to do
	}

	// Parse envelope
	var envelope hookEnvelope
	if err := json.Unmarshal(input, &envelope); err != nil {
		return nil // Invalid JSON, silently ignore (not our hook)
	}

	// Only process TodoWrite
	if envelope.ToolName != "TodoWrite" {
		return nil
	}

	// Parse TodoWrite input
	var todoInput todoWriteInput
	if err := json.Unmarshal(envelope.ToolInput, &todoInput); err != nil {
		return nil // Invalid TodoWrite input, silently ignore
	}

	// Find or create felt repository
	root, err := felt.FindProjectRoot()
	if err != nil {
		// No felt repo - try to initialize in current directory
		root, err = os.Getwd()
		if err != nil {
			return nil // Can't determine directory, silently ignore
		}
	}

	storage := felt.NewStorage(root)
	if !storage.Exists() {
		if err := storage.Init(); err != nil {
			return nil // Can't init, silently ignore
		}
	}

	// Load mapping
	mapping, err := loadTodoMapping(root)
	if err != nil {
		mapping = make(todoMapping)
	}

	// Track which todos we've seen (for abandoned detection)
	seen := make(map[string]bool)

	// Process each todo
	for _, todo := range todoInput.Todos {
		if todo.Content == "" {
			continue
		}
		seen[todo.Content] = true

		switch todo.Status {
		case "completed":
			// Close the fiber if it exists
			if fiberID, ok := mapping[todo.Content]; ok {
				if f, err := storage.Read(fiberID); err == nil && !f.IsClosed() {
					now := time.Now()
					f.Status = felt.StatusClosed
					f.ClosedAt = &now
					f.CloseReason = "Completed via TodoWrite"
					_ = storage.Write(f)
				}
				delete(mapping, todo.Content)
			}

		case "in_progress":
			if fiberID, ok := mapping[todo.Content]; ok {
				// Update existing fiber to active
				if f, err := storage.Read(fiberID); err == nil && !f.IsClosed() {
					if f.Status != felt.StatusActive {
						f.Status = felt.StatusActive
						_ = storage.Write(f)
					}
				}
			} else {
				// Create new fiber
				f, err := felt.New(todo.Content)
				if err != nil {
					continue
				}
				f.Kind = todoKind
				f.Status = felt.StatusActive
				if todo.ActiveForm != "" && todo.ActiveForm != todo.Content {
					f.Body = todo.ActiveForm
				}
				if err := storage.Write(f); err == nil {
					mapping[todo.Content] = f.ID
				}
			}

		case "pending":
			if fiberID, ok := mapping[todo.Content]; ok {
				// Update existing fiber to open
				if f, err := storage.Read(fiberID); err == nil && !f.IsClosed() {
					if f.Status != felt.StatusOpen {
						f.Status = felt.StatusOpen
						_ = storage.Write(f)
					}
				}
			} else {
				// Create new fiber
				f, err := felt.New(todo.Content)
				if err != nil {
					continue
				}
				f.Kind = todoKind
				f.Status = felt.StatusOpen
				if todo.ActiveForm != "" && todo.ActiveForm != todo.Content {
					f.Body = todo.ActiveForm
				}
				if err := storage.Write(f); err == nil {
					mapping[todo.Content] = f.ID
				}
			}
		}
	}

	// Close abandoned fibers (in mapping but not in current todos)
	for content, fiberID := range mapping {
		if !seen[content] {
			if f, err := storage.Read(fiberID); err == nil && !f.IsClosed() {
				now := time.Now()
				f.Status = felt.StatusClosed
				f.ClosedAt = &now
				f.CloseReason = "Abandoned from TodoWrite"
				_ = storage.Write(f)
			}
			delete(mapping, content)
		}
	}

	// Save mapping
	_ = saveTodoMapping(root, mapping)

	return nil
}

// mappingPath returns the path to the todo mapping file.
func mappingPath(root string) string {
	return root + string(os.PathSeparator) + felt.DirName + string(os.PathSeparator) + mappingFileName
}

// loadTodoMapping loads the todo-to-fiber mapping from disk.
func loadTodoMapping(root string) (todoMapping, error) {
	data, err := os.ReadFile(mappingPath(root))
	if err != nil {
		return nil, err
	}

	var mapping todoMapping
	if err := json.Unmarshal(data, &mapping); err != nil {
		return nil, err
	}

	return mapping, nil
}

// saveTodoMapping saves the todo-to-fiber mapping to disk.
func saveTodoMapping(root string, mapping todoMapping) error {
	data, err := json.MarshalIndent(mapping, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(mappingPath(root), data, 0644)
}
