package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// TestCLIReferenceNamesEveryCommand keeps docs/reference/cli.md complete: every
// visible shuttle command path appears there, in a table cell or a code block.
func TestCLIReferenceNamesEveryCommand(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "reference", "cli.md"))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(data)
	var walk func(*cobra.Command, string)
	walk = func(parent *cobra.Command, prefix string) {
		for _, cmd := range parent.Commands() {
			if cmd.Hidden || cmd.Name() == "help" || cmd.Name() == "completion" {
				continue
			}
			path := prefix + " " + cmd.Name()
			if !strings.Contains(doc, "`"+path) && !strings.Contains(doc, "\n"+path) {
				t.Errorf("docs/reference/cli.md does not name %q", path)
			}
			walk(cmd, path)
		}
	}
	walk(NewRootCmd(sysenv.New(t.TempDir(), nil)), "shuttle")
}
