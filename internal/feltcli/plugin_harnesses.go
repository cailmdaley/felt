package feltcli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// pluginHarness is one harness that loads felt from the promoted plugin
// generation at ~/.felt/plugin-runtime/current. A setup promotes one
// generation and every harness that carries felt follows it; the receipt
// reports and verifies each harness from this table, and deploys set up
// whichever harnesses the receipt reports.
type pluginHarness struct {
	// name is the `felt setup` subcommand and the receipt's harness.
	name string
	// bundles reports felt's bundles in the harness, none where felt is not
	// installed.
	bundles func(a *app) []ReceiptBundle
	// hooks reports whether a bundle root carries felt's hooks.
	hooks func(root string) bool
	// verify checks a loaded bundle against the active generation promoted at
	// current, and returns the identity the bundle was checked against.
	verify func(active pluginGenerationIdentity, bundle ReceiptBundle, current string) (pluginGenerationIdentity, error)
	// install points the harness at the generation promoted at current.
	install func(a *app, current string) error
	// capture records felt's installation in the harness before a promotion.
	capture func(a *app, intent *pluginNativeIntent) error
	// follow moves a harness that carried felt before the promotion onto the
	// generation promoted at current.
	follow func(a *app, current string, intent *pluginNativeIntent) error
	// reconcile returns the harness to its captured installation, against
	// the restored current, after a failed or interrupted promotion.
	reconcile func(a *app, current string, intent *pluginNativeIntent) error
}

// pluginHarnesses is filled at init: each harness's functions reach back to
// the table through promotion recovery.
var pluginHarnesses []pluginHarness

func init() {
	pluginHarnesses = []pluginHarness{claudeHarness, codexHarness, piHarness, antigravityHarness}
}

func pluginHarnessNamed(name string) (pluginHarness, bool) {
	for _, h := range pluginHarnesses {
		if h.name == name {
			return h, true
		}
	}
	return pluginHarness{}, false
}

// setupFromGeneration promotes source and points one harness at it with
// install; the other harnesses that carry felt follow the new generation.
func (a *app) setupFromGeneration(source string, install func(current string) error) error {
	return a.withPluginPromotionLock(func() error {
		return a.withStagedPluginCandidateWithRestore(source, install, nil)
	})
}

// restoredSource is what a harness is reconciled against: the restored
// current generation, or the harness's own previous source when no current
// generation survived.
func restoredSource(current, previous string, configured bool) (string, error) {
	_, err := os.Stat(current)
	if os.IsNotExist(err) && configured {
		return previous, nil
	}
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("checking restored plugin source: %w", err)
	}
	return current, nil
}

var claudeHarness = pluginHarness{
	name:    "claude",
	bundles: (*app).collectClaudeBundle,
	install: (*app).installClaudePluginAtSource,
	hooks:   hookFilesCompatible,
	verify: func(active pluginGenerationIdentity, bundle ReceiptBundle, _ string) (pluginGenerationIdentity, error) {
		return active, verifyLoadedGeneration("claude", active, bundle.Path)
	},
	capture: func(a *app, intent *pluginNativeIntent) error {
		if _, err := a.env.LookPath("claude"); err != nil {
			return nil
		}
		state, err := a.captureClaudeInstallation()
		if err != nil {
			return err
		}
		intent.Claude = &state
		return nil
	},
	follow: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Claude == nil || !intent.Claude.Installed || a.verifyClaudeLoadedGeneration(current) == nil {
			return nil
		}
		return a.installClaudePluginAtSource(current)
	},
	reconcile: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Claude == nil {
			return nil
		}
		source, err := restoredSource(current, claudeMarketplaceSource(intent.Claude.Marketplace), intent.Claude.Configured)
		if err != nil {
			return err
		}
		return a.reconcileClaudeInstallation(*intent.Claude, source)
	},
}

var codexHarness = pluginHarness{
	name:    "codex",
	bundles: (*app).collectCodexBundle,
	install: (*app).installCodexPluginAtSource,
	hooks:   hookFilesCompatible,
	verify: func(active pluginGenerationIdentity, bundle ReceiptBundle, _ string) (pluginGenerationIdentity, error) {
		expected := active
		if active.CodexPayloadSHA256 != nil {
			name := bundle.Name
			if name == "" {
				name = "felt"
			}
			var err error
			if expected, err = codexBundleGeneration(active, name); err != nil {
				return expected, err
			}
		}
		return expected, verifyLoadedGeneration("codex", expected, bundle.Path)
	},
	capture: func(a *app, intent *pluginNativeIntent) error {
		if _, err := a.env.LookPath("codex"); err != nil {
			return nil
		}
		state, err := a.captureCodexInstallation()
		if err != nil {
			return err
		}
		intent.Codex = &state
		return nil
	},
	follow: func(a *app, current string, intent *pluginNativeIntent) error {
		codex := intent.Codex
		if codex == nil {
			return nil
		}
		for _, bundle := range []struct {
			name      string
			installed bool
		}{{"felt", codex.Installed}, {"felt-skills", codex.SkillsInstalled}} {
			if bundle.installed && a.verifyCodexLoadedBundle(current, bundle.name) != nil {
				if err := a.reconcileCodexInstallation(*codex, current); err != nil {
					return err
				}
				if err := a.verifyCodexLoadedBundle(current, bundle.name); err != nil {
					return err
				}
			}
		}
		return nil
	},
	reconcile: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Codex == nil {
			return nil
		}
		source, err := restoredSource(current, intent.Codex.Source, intent.Codex.Configured)
		if err != nil {
			return err
		}
		return a.reconcileCodexInstallation(*intent.Codex, source)
	},
}

// reconcileEach reconciles every harness, attempting all of them.
func (a *app) reconcileEach(current string, intent *pluginNativeIntent) error {
	var err error
	for _, h := range pluginHarnesses {
		err = errors.Join(err, h.reconcile(a, current, intent))
	}
	return err
}

// samePath reports whether two paths name the same directory, through
// symlinks.
func samePath(x, y string) bool {
	if rx, err := filepath.EvalSymlinks(x); err == nil {
		x = rx
	}
	if ry, err := filepath.EvalSymlinks(y); err == nil {
		y = ry
	}
	return filepath.Clean(x) == filepath.Clean(y)
}
