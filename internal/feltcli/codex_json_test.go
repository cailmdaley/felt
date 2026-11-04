package feltcli

import (
	"path/filepath"
	"testing"
)

func TestCodexStructuredOutputIgnoresStderrWarnings(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "codex")
	if err := f.a.installCodexPluginViaCLI(f.remote); err != nil {
		t.Fatal(err)
	}
	f.env.Set("FAKE_CODEX_JSON_WARNING", "1")
	if !f.a.codexPluginInstalled() {
		t.Fatal("stderr warning hid installed plugin")
	}
	if _, configured := f.a.codexMarketplaceState(); !configured {
		t.Fatal("stderr warning hid registered marketplace")
	}
	for _, name := range codexBundleNames {
		if err := f.a.verifyCodexLoadedBundle(filepath.Join(f.home, ".felt", pluginRuntimeDirName, pluginCurrentName), name); err != nil {
			t.Fatal(err)
		}
	}
}
