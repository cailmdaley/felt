package feltcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) setupRefreshCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "refresh",
		Short: "Refresh felt integrations already installed in agent harnesses",
		Long: `Refreshes only harnesses that already carry felt. Claude Code and Codex
are installed from the local checkout; pi keeps its registered source and
refreshes its GitHub package when needed.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			source, _ := cmd.Flags().GetString("source")
			if strings.TrimSpace(source) == "" {
				return fmt.Errorf("setup refresh requires --source <felt checkout>")
			}
			return a.refreshInstalledHarnesses(source)
		},
	}
	command.Flags().String("source", "", "Path to the felt checkout to install (required)")
	return command
}

func (a *app) refreshInstalledHarnesses(source string) error {
	root, err := a.findMarketplaceRoot(source)
	if err != nil {
		return fmt.Errorf("locating felt checkout: %w", err)
	}
	checkout := root
	checkout, err = a.env.Abs(checkout)
	if err != nil {
		return fmt.Errorf("resolving felt checkout: %w", err)
	}
	head := a.gitResolvedCommit(checkout)
	if head == "" {
		return fmt.Errorf("cannot read HEAD in felt checkout %s", checkout)
	}
	receipt := a.collectRuntimeReceipt()
	if err := a.refreshReceiptBundles(receipt, checkout, head, a.runSetupFromSource, a.verifySetupReceipt); err != nil {
		return err
	}
	if _, err := a.env.LookPath("pi"); err == nil {
		if err := a.refreshPiHarness(checkout, head); err != nil {
			return err
		}
	}
	if len(receipt.Bundles) == 0 && a.piFeltPackageSource() == "" {
		fmt.Fprintln(a.env.Stdout, "No installed harness carries felt")
	}
	return nil
}

func (a *app) refreshReceiptBundles(receipt RuntimeReceipt, checkout, head string, setup func(string, string) error, verify func() error) error {
	var bundles []ReceiptBundle
	for _, bundle := range receipt.Bundles {
		if !bundle.Enabled {
			continue
		}
		switch bundle.Inspection {
		case inspectionConfirmed, inspectionConfigured:
			bundles = append(bundles, bundle)
		case inspectionUnknown:
			return fmt.Errorf("cannot tell whether %s carries felt: %s", bundle.Harness, fallbackRepair(bundle.Repair))
		default:
			return fmt.Errorf("the receipt gives %s no known inspection (%s); %s", bundle.Harness, bundle.Inspection, fallbackRepair(bundle.Repair))
		}
	}

	cleanSealed := receipt.Status == receiptHealthy && receipt.Generation.Active != nil &&
		receipt.Generation.Active.ResolvedCommit == head && !strings.Contains(receipt.Felt.Build, "-dirty")
	if len(bundles) > 0 {
		if cleanSealed {
			harnessNames := make([]string, len(bundles))
			for i, bundle := range bundles {
				harnessNames[i] = bundle.Harness
			}
			fmt.Fprintf(a.env.Stdout, "%s felt plugins already match %s\n", strings.Join(harnessNames, " and "), head[:7])
		} else {
			for _, bundle := range bundles {
				fmt.Fprintf(a.env.Stdout, "Refreshing %s plugin...\n", bundle.Harness)
				if err := setup(bundle.Harness, checkout); err != nil {
					return fmt.Errorf("felt setup %s failed: %w", bundle.Harness, err)
				}
			}
			if err := verify(); err != nil {
				return err
			}
		}
	}

	return nil
}

func fallbackRepair(repair string) string {
	if repair == "" {
		return "rerun felt setup receipt and repair the reported component"
	}
	return repair
}

func (a *app) runSetupFromSource(harness, source string) error {
	switch harness {
	case "claude":
		return a.installPluginViaCLI(source)
	case "codex":
		return a.installCodexPluginViaCLI(source)
	default:
		return fmt.Errorf("unsupported felt harness %q", harness)
	}
}

func (a *app) verifySetupReceipt() error {
	return verifyRuntimeReceipt(a.collectRuntimeReceipt())
}

func verifyRuntimeReceipt(receipt RuntimeReceipt) error {
	if receipt.Status == receiptHealthy {
		return nil
	}
	return fmt.Errorf("setup receipt still fails after felt setup: %s", receiptProblems(receipt))
}

func receiptProblems(receipt RuntimeReceipt) string {
	var problems []string
	appendProblem := func(name string, status receiptStatus, repair string) {
		if status == receiptHealthy {
			return
		}
		problem := fmt.Sprintf("%s %s", name, status)
		if repair != "" {
			problem += ": " + repair
		}
		problems = append(problems, problem)
	}
	appendProblem("felt", receipt.Felt.Status, receipt.Felt.Repair)
	for _, bundle := range receipt.Bundles {
		if bundle.Enabled {
			appendProblem(bundle.Harness+" plugin", bundle.Status, bundle.Repair)
		}
	}
	appendProblem("hooks", receipt.Hooks.Status, receipt.Hooks.Repair)
	appendProblem("generation", receipt.Generation.Status, receipt.Generation.Repair)
	if len(problems) == 0 {
		return fmt.Sprintf("runtime %s: %s", receipt.Status, fallbackRepair(receipt.Repair))
	}
	return strings.Join(problems, "; ")
}

type piPackageListing struct {
	source string
	path   string
}

func (a *app) refreshPiHarness(checkout, head string) error {
	listing, err := a.env.Command("pi", "list").CombinedOutput()
	if err != nil {
		return fmt.Errorf("pi list failed: %s", strings.TrimSpace(string(listing)))
	}
	packages := parsePiPackageListing(string(listing))
	var githubPackages []piPackageListing
	refreshGitHub := false
	found := false
	for _, pkg := range packages {
		if strings.HasPrefix(pkg.source, "git:github.com/"+marketplaceRepo) {
			found = true
			githubPackages = append(githubPackages, pkg)
			if pkg.path == "" {
				return fmt.Errorf("pi list did not report a path for felt package %q", pkg.source)
			}
			at := a.gitResolvedCommit(pkg.path)
			changed, err := a.gitTrackedChanges(pkg.path)
			if err != nil {
				return fmt.Errorf("cannot inspect pi's felt package %s: %w", pkg.path, err)
			}
			if changed {
				return fmt.Errorf("pi's felt package %s has local edits; commit or discard them before refresh", pkg.path)
			}
			if at == head {
				continue
			}
			refreshGitHub = true
			continue
		}
		if strings.Contains(pkg.source, ":") {
			continue
		}
		if pkg.path == "" {
			continue
		}
		if !a.isLocalFeltPackage(pkg.path) {
			continue
		}
		found = true
		if sameCanonicalPath(pkg.path, checkout) {
			continue
		}
		at := a.gitResolvedCommit(pkg.path)
		if at != head {
			return fmt.Errorf("pi loads felt from local package %s at %s, not %s; its source is retained", pkg.path, shortCommit(at), head[:7])
		}
		changed, err := a.gitTrackedChanges(pkg.path)
		if err != nil {
			return fmt.Errorf("cannot inspect pi's local felt package %s: %w", pkg.path, err)
		}
		if changed {
			return fmt.Errorf("pi's local felt package %s has edits; commit or discard them there", pkg.path)
		}
	}
	if refreshGitHub {
		for _, pkg := range githubPackages {
			if a.gitResolvedCommit(pkg.path) == head {
				continue
			}
			if err := a.pinPiGitHubPackage(pkg.path, head); err != nil {
				return fmt.Errorf("pinning pi's felt package %s to %s: %w", pkg.path, head, err)
			}
		}
		for _, pkg := range githubPackages {
			if at := a.gitResolvedCommit(pkg.path); at != head {
				return fmt.Errorf("pi's felt package is at %s after refresh, want exact commit %s", shortCommit(at), head)
			}
		}
	} else if found {
		fmt.Fprintf(a.env.Stdout, "pi felt package already matches %s\n", head[:7])
	}
	return nil
}

func (a *app) pinPiGitHubPackage(path, head string) error {
	changed, err := a.gitTrackedChanges(path)
	if err != nil {
		return fmt.Errorf("checking tracked files: %w", err)
	}
	if changed {
		return fmt.Errorf("package has local edits; commit or discard them before pinning")
	}
	if _, err := a.env.Command("git", "-C", path, "fetch", "origin", head).CombinedOutput(); err != nil {
		return fmt.Errorf("fetching exact commit %s from origin: %w", head, err)
	}
	out, err := a.env.Command("git", "-C", path, "checkout", "--detach", head).CombinedOutput()
	if err != nil {
		return fmt.Errorf("checking out exact commit %s: %w: %s", head, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func parsePiPackageListing(listing string) []piPackageListing {
	var packages []piPackageListing
	for _, line := range strings.Split(listing, "\n") {
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") {
			packages = append(packages, piPackageListing{source: strings.TrimSpace(line)})
			continue
		}
		if strings.HasPrefix(line, "    ") && len(packages) > 0 {
			packages[len(packages)-1].path = strings.TrimSpace(line)
		}
	}
	return packages
}

func shortCommit(commit string) string {
	if len(commit) > 7 {
		return commit[:7]
	}
	if commit == "" {
		return "no git commit"
	}
	return commit
}

func (a *app) gitTrackedChanges(path string) (bool, error) {
	out, err := a.env.Command("git", "-C", path, "status", "--porcelain", "--untracked-files=no").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("git status: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)) != "", nil
}

func (a *app) isLocalFeltPackage(path string) bool {
	if _, err := os.Stat(filepath.Join(path, ".git")); err == nil {
		out, err := a.env.Command("git", "-C", path, "show", "HEAD:package.json").Output()
		if err != nil {
			return false
		}
		var manifest map[string]any
		return json.Unmarshal(out, &manifest) == nil && manifest["name"] == "felt"
	}
	manifest, err := readJSONFile[map[string]any](filepath.Join(path, "package.json"))
	return err == nil && manifest["name"] == "felt"
}

func sameCanonicalPath(a, b string) bool {
	left, errLeft := filepath.EvalSymlinks(a)
	right, errRight := filepath.EvalSymlinks(b)
	return errLeft == nil && errRight == nil && filepath.Clean(left) == filepath.Clean(right)
}
