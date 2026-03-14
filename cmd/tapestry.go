package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/tapestry"
	"github.com/spf13/cobra"
)

var (
	tapestryAllFibers bool
	tapestryForce     bool
	tapestryName      string
	tapestryOut       string
)

var tapestryCmd = &cobra.Command{
	Use:   "tapestry",
	Short: "Tapestry operations",
}

var tapestryExportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export tapestry DAG to static site",
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		name := tapestryName
		if name == "" {
			name = filepath.Base(projectRoot)
		}

		outDir := tapestryOut
		if outDir == "" {
			repoDir, err := defaultTapestriesRepo()
			if err != nil {
				return err
			}
			outDir = filepath.Join(repoDir, "data", name)
		}

		if err := tapestry.Export(projectRoot, outDir, tapestry.ExportOptions{
			AllFibers: tapestryAllFibers,
			Force:     tapestryForce,
			Name:      name,
		}); err != nil {
			return err
		}

		fmt.Printf("Exported tapestry to %s\n", outDir)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(tapestryCmd)
	tapestryCmd.AddCommand(tapestryExportCmd)

	tapestryExportCmd.Flags().BoolVar(&tapestryAllFibers, "all-fibers", false, "Include all fibers in output")
	tapestryExportCmd.Flags().BoolVar(&tapestryForce, "force", false, "Re-copy all artifacts even if they exist")
	tapestryExportCmd.Flags().StringVar(&tapestryName, "name", "", "Override tapestry name")
	tapestryExportCmd.Flags().StringVar(&tapestryOut, "out", "", "Override output directory")
}

func defaultTapestriesRepo() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}

	repoDir := filepath.Join(home, ".felt", "tapestries")
	if info, err := os.Stat(repoDir); err == nil && info.IsDir() {
		return repoDir, nil
	}

	return "", fmt.Errorf(
		"No tapestries repo found at %s/\nClone it: git clone git@github.com:cailmdaley/tapestries.git %s",
		repoDir, repoDir,
	)
}
