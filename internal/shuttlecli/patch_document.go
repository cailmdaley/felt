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
	_, err := felt.UpdateFiberFile(req.Path, idFromPath(req.Path), func(current *felt.Felt) error {
		data, err := os.ReadFile(req.Path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != req.BeforeSHA256 {
			return fmt.Errorf("document changed since the edit was prepared")
		}
		proposed, err := felt.Parse(current.ID, []byte(req.After))
		if err != nil {
			return err
		}
		*current = *proposed
		return nil
	})
	return err
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
