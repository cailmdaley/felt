package feltcli

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// pi loads felt as a package: a directory whose package.json lists the pi
// extension and the shared skills. Each promoted generation is that
// directory, so pi installs ~/.felt/plugin-runtime/current once and every
// later promotion swaps what it loads.

// piPackageFiles are what a generation copies from its source beside the
// shared plugin to make it a pi package.
var piPackageFiles = []string{"package.json", filepath.Join("extensions", "pi")}

// piInstallationState is felt's package in pi: its source as pi records it
// and the directory pi resolves it to, both empty when pi has none.
type piInstallationState struct {
	Source string `json:"source,omitempty"`
	Path   string `json:"path,omitempty"`
}

// spec is what `pi install` and `pi remove` take: a git source as recorded, a
// local package by its resolved directory.
func (s piInstallationState) spec() string {
	if strings.HasPrefix(s.Source, "git:") {
		return s.Source
	}
	return s.Path
}

func (a *app) setupPiCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "pi",
		Short: "Install the felt package for pi",
		Long: `Installs the felt package for pi (@earendil-works/pi-coding-agent): the felt
and shuttle skills and a pi extension that injects the session context,
enforces the skill-activation gate, and records harness activity for shuttle.

The source is chosen as for felt setup claude; felt promotes it to a local
generation, which the other harnesses carrying felt follow, and registers
that generation with pi install, replacing any other felt package pi has.
Later promotions update what pi loads without another pi install. Re-running
is safe. --uninstall removes the package.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if uninstall, _ := cmd.Flags().GetBool("uninstall"); uninstall {
				installed, err := a.piFeltPackage()
				if err != nil {
					return err
				}
				if installed.Source == "" {
					fmt.Fprintln(a.env.Stdout, "pi has no felt package")
					return nil
				}
				return a.runHarnessCLI("pi", "remove", installed.spec())
			}
			if _, err := a.env.LookPath("pi"); err != nil {
				return fmt.Errorf("pi not found in PATH; install pi first: %w", err)
			}
			source, _ := cmd.Flags().GetString("source")
			resolved, err := a.resolveSetupSource(source)
			if err != nil {
				return err
			}
			return a.setupFromGeneration(resolved, a.installPiPackage)
		},
	}
	command.Flags().Bool("uninstall", false, "Remove the felt pi package")
	command.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	return command
}

// piFeltPackage reads felt's package from `pi list`, which prints each
// package's source, then the directory it resolves to indented below it. A
// package is felt's when it is the felt GitHub repository, or a local
// directory whose package.json names felt.
func (a *app) piFeltPackage() (piInstallationState, error) {
	out, err := a.env.Command("pi", "list").Output()
	if err != nil {
		return piInstallationState{}, fmt.Errorf("pi list: %w", err)
	}
	var source string
	for _, line := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(line, "    ") && strings.TrimSpace(line) != "":
			path := strings.TrimSpace(line)
			repo := "git:github.com/" + marketplaceRepo
			if source == repo || strings.HasPrefix(source, repo+"@") || (!strings.Contains(source, ":") && isFeltPackageDir(path)) {
				return piInstallationState{Source: source, Path: path}, nil
			}
		case strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   "):
			source = strings.TrimSpace(line)
		}
	}
	return piInstallationState{}, nil
}

// isFeltPackageDir reports whether dir holds a package.json named felt.
func isFeltPackageDir(dir string) bool {
	pkg, err := readJSONFile[struct {
		Name string `json:"name"`
	}](filepath.Join(dir, "package.json"))
	return err == nil && pkg.Name == "felt"
}

// installPiPackage points pi at the generation promoted at current, removing
// any other felt package first so pi loads felt once.
func (a *app) installPiPackage(current string) error {
	installed, err := a.piFeltPackage()
	if err != nil {
		return err
	}
	if installed.Path != "" && samePath(installed.Path, current) {
		fmt.Fprintf(a.env.Stdout, "✓ pi loads felt from the promoted generation at %s\n", current)
		return nil
	}
	if installed.Source != "" {
		if err := a.runHarnessCLI("pi", "remove", installed.spec()); err != nil {
			return fmt.Errorf("removing %q before installing %q: %w", installed.spec(), current, err)
		}
	}
	if err := a.runHarnessCLI("pi", "install", current); err != nil {
		return err
	}
	fmt.Fprintln(a.env.Stdout)
	fmt.Fprintln(a.env.Stdout, "Restart any running pi sessions (or run /reload) so the skills and extension load.")
	return nil
}

func (a *app) collectPiBundle() []ReceiptBundle {
	if _, err := a.env.LookPath("pi"); err != nil {
		return nil
	}
	installed, err := a.piFeltPackage()
	if err != nil {
		return []ReceiptBundle{{Harness: "pi", Enabled: true, Inspection: inspectionUnknown, Evidence: "pi list unavailable", Status: receiptPartial, Repair: "repair `pi list`, then rerun `felt setup pi`"}}
	}
	if installed.Source == "" {
		return nil
	}
	b := ReceiptBundle{Name: "felt", Harness: "pi", Source: installed.Source, Path: installed.Path, Enabled: true, Inspection: inspectionConfirmed, Evidence: "pi list", Status: receiptHealthy}
	if !skillFilesCompatible(filepath.Join(installed.Path, "claude-plugin")) {
		b.Status, b.Repair = receiptMissing, "restore the felt and shuttle skill files with `felt setup pi`"
	}
	return []ReceiptBundle{b}
}

var piHarness = pluginHarness{
	name:    "pi",
	bundles: (*app).collectPiBundle,
	install: (*app).installPiPackage,
	hooks: func(root string) bool {
		return isRegularFile(filepath.Join(root, "extensions", "pi", "index.ts"))
	},
	verify: func(active pluginGenerationIdentity, bundle ReceiptBundle, current string) (pluginGenerationIdentity, error) {
		if !samePath(bundle.Path, current) {
			return active, fmt.Errorf("pi loads felt from %s, not the promoted generation at %s", bundle.Path, current)
		}
		return active, nil
	},
	capture: func(a *app, intent *pluginNativeIntent) error {
		if _, err := a.env.LookPath("pi"); err != nil {
			return nil
		}
		installed, err := a.piFeltPackage()
		if err != nil {
			return err
		}
		intent.Pi = &installed
		return nil
	},
	follow: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Pi == nil || intent.Pi.Source == "" || samePath(intent.Pi.Path, current) {
			return nil
		}
		return a.installPiPackage(current)
	},
	reconcile: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Pi == nil {
			return nil
		}
		now, err := a.piFeltPackage()
		if err != nil {
			return err
		}
		if now.spec() == intent.Pi.spec() {
			return nil
		}
		if now.Source != "" {
			if err := a.runHarnessCLI("pi", "remove", now.spec()); err != nil {
				return err
			}
		}
		if intent.Pi.Source == "" {
			return nil
		}
		return a.runHarnessCLI("pi", "install", intent.Pi.spec())
	},
}
