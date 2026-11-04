package shuttlecli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestDocumentSnapshotPatchRejectsACompletedConcurrentEdit(t *testing.T) {
	t.Parallel()
	st, req := seedStandingTransition(t)
	original, err := os.ReadFile(req.Path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	patch := patchDocumentRequest{Path: req.Path, BeforeSHA256: hex.EncodeToString(digest[:]), After: strings.Replace(string(original), "status: active", "status: closed", 1)}
	if _, err := st.Update("role", func(f *felt.Felt) error { f.Body = "A later worker result"; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := applyDocumentPatch(patch); err == nil {
		t.Fatal("stale source image replaced a completed edit")
	}
	got := mustRead(t, st, "role")
	if got.Body != "A later worker result" || got.Status != "active" {
		t.Fatalf("concurrent edit lost: %+v", got)
	}
}
