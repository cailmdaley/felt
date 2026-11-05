package shuttlecli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// A raw document editor must name the exact source image it transformed. The
// compare-and-swap check and patch share the same lock as field-level writers.
type patchDocumentRequest struct {
	Path         string `json:"path"`
	BeforeSHA256 string `json:"before_sha256"`
	After        string `json:"after"`
}

func applyDocumentPatch(req patchDocumentRequest) error {
	unlock, err := felt.LockFiberFile(req.Path)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := os.ReadFile(req.Path)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != req.BeforeSHA256 {
		return fmt.Errorf("document changed since the edit was prepared")
	}
	if _, err := felt.Parse(idFromPath(req.Path), []byte(req.After)); err != nil {
		return err
	}
	return felt.WriteFiberFile(req.Path, []byte(req.After))
}

func (a *app) patchDocumentCmd() *cobra.Command {
	return &cobra.Command{Use: "patch-document", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var request patchDocumentRequest
			if err := json.NewDecoder(a.env.Stdin).Decode(&request); err != nil {
				return err
			}
			return applyDocumentPatch(request)
		},
	}
}
