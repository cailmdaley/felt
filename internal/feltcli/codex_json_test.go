package feltcli

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexAddFailureReportsActualCause(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "codex")
	f.env.Set("FAKE_NATIVE_FAIL_ONCE", "1")
	err := f.a.installCodexPluginViaCLI(f.remote)
	if err == nil {
		t.Fatal("native failure accepted")
	}
	if strings.Contains(err.Error(), "is required") {
		t.Fatalf("unrelated install error became a version diagnosis: %v", err)
	}
	if !strings.Contains(err.Error(), "reported Codex plugin failure") {
		t.Fatalf("native error lost: %v", err)
	}
}

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
