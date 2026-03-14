package cmd

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

const tapestriesTemplateURL = "https://github.com/cailmdaley/tapestries.git"

func defaultTapestriesRepo() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}

	repoDir := filepath.Join(home, ".felt", "tapestries")
	if info, err := os.Stat(repoDir); err == nil && info.IsDir() {
		return repoDir, nil
	}

	fmt.Printf("No tapestries repo found at %s/\n", repoDir)
	fmt.Printf("Clone the template viewer? [Y/n] ")
	reader := bufio.NewReader(os.Stdin)
	answer, _ := reader.ReadString('\n')
	answer = strings.TrimSpace(strings.ToLower(answer))
	if answer != "" && answer != "y" && answer != "yes" {
		return "", fmt.Errorf("aborted")
	}

	fmt.Printf("Cloning %s...\n", tapestriesTemplateURL)
	clone := exec.Command("git", "clone", "--depth", "1", tapestriesTemplateURL, repoDir)
	clone.Stdout = os.Stdout
	clone.Stderr = os.Stderr
	if err := clone.Run(); err != nil {
		return "", fmt.Errorf("clone failed: %w", err)
	}

	fmt.Printf("Tapestries viewer ready at %s\n", repoDir)
	fmt.Println("Serve locally: npx serve -s " + repoDir)
	return repoDir, nil
}
