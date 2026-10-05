package feltcli

import (
	"os/exec"
	"strings"
	"testing"
)

func TestFeltBinaryHasNoShuttleOrMessagingDependencies(t *testing.T) {
	t.Parallel()
	cmd := exec.Command("go", "list", "-deps", "./cmd/felt")
	cmd.Dir = repoRoot(t)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list dependencies: %v\n%s", err, output)
	}
	for _, forbidden := range []string{
		"github.com/cailmdaley/felt/internal/shuttle",
		"github.com/cailmdaley/felt/internal/messaging",
		"github.com/cailmdaley/felt/internal/shuttlecli",
	} {
		if strings.Contains(string(output), forbidden) {
			t.Errorf("Felt binary depends on %q", forbidden)
		}
	}
}
