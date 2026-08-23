package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCombineReceiptStatusRejectsFalseHealthy(t *testing.T) {
	tests := []struct {
		name   string
		felt   receiptStatus
		bundle []ReceiptBundle
		hooks  receiptStatus
		daemon receiptStatus
		want   receiptStatus
	}{
		{"healthy", receiptHealthy, []ReceiptBundle{{Status: receiptHealthy}}, receiptHealthy, receiptHealthy, receiptHealthy},
		{"missing", receiptMissing, nil, receiptMissing, receiptMissing, receiptMissing},
		{"partial", receiptHealthy, []ReceiptBundle{{Status: receiptHealthy}}, receiptHealthy, receiptMissing, receiptPartial},
		{"stale", receiptHealthy, []ReceiptBundle{{Status: receiptStale}}, receiptHealthy, receiptHealthy, receiptStale},
		{"mismatch", receiptHealthy, []ReceiptBundle{{Status: receiptHealthy}}, receiptMismatch, receiptHealthy, receiptMismatch},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := combineReceiptStatus(tt.felt, tt.bundle, tt.hooks, tt.daemon)
			if got != tt.want {
				t.Fatalf("status = %q, want %q", got, tt.want)
			}
			if tt.want != receiptHealthy && got == receiptHealthy {
				t.Fatal("incomplete runtime was reported healthy")
			}
		})
	}
}

func TestBundleFromManifestRejectsWrongAndStaleBundles(t *testing.T) {
	oldVersion := Version
	Version = "1.2.3"
	t.Cleanup(func() { Version = oldVersion })

	root := t.TempDir()
	manifest := filepath.Join(root, ".codex-plugin", "plugin.json")
	if err := os.MkdirAll(filepath.Dir(manifest), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, skill := range []string{"felt", "shuttle"} {
		if err := os.MkdirAll(filepath.Join(root, "skills", skill), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "skills", skill, "SKILL.md"), []byte("skill\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write := func(contents string) ReceiptBundle {
		t.Helper()
		if err := os.WriteFile(manifest, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		return bundleFromManifest("codex", manifest, "/source")
	}
	if got := write(`{"name":"felt","version":"1.2.3"}`); got.Status != receiptHealthy {
		t.Fatalf("matching bundle = %#v, want healthy", got)
	}
	if got := write(`{"name":"felt","version":"1.2.2"}`); got.Status != receiptStale {
		t.Fatalf("stale bundle = %#v, want stale", got)
	}
	if got := write(`{"name":"other","version":"1.2.3"}`); got.Status != receiptMismatch {
		t.Fatalf("wrong plugin = %#v, want mismatch", got)
	}
	if got := write(`not-json`); got.Status != receiptMismatch {
		t.Fatalf("malformed manifest = %#v, want mismatch", got)
	}
}

func TestCollectFeltReceiptUsesResolvedExecutable(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "felt")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf '9.8.7 (abc, built now)\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_BIN", bin)
	got := collectFeltReceipt()
	if got.Status != receiptHealthy || got.Path != bin || got.Version != "9.8.7" {
		t.Fatalf("resolved executable receipt = %#v", got)
	}
}

func TestCollectCodexBundleUsesActivePluginSourceNotCache(t *testing.T) {
	oldVersion := Version
	Version = "dev"
	t.Cleanup(func() { Version = oldVersion })
	home := t.TempDir()
	t.Setenv("HOME", home)
	source := filepath.Join(home, "source", "claude-plugin")
	if err := os.MkdirAll(filepath.Join(source, ".codex-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, skill := range []string{"felt", "shuttle"} {
		if err := os.MkdirAll(filepath.Join(source, "skills", skill), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, "skills", skill, "SKILL.md"), []byte("skill\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(source, ".codex-plugin", "plugin.json"), []byte(`{"name":"felt","version":"1.1.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(home, ".codex", "plugins", "cache", marketplaceName, "felt", "1.0.0", ".codex-plugin")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "plugin.json"), []byte(`{"name":"felt","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	list := filepath.Join(home, "plugin-list.json")
	listJSON := `{"installed":[{"pluginId":"felt@cailmdaley-felt","name":"felt","marketplaceName":"cailmdaley-felt","version":"1.1.0","installed":true,"enabled":true,"source":{"source":"local","path":"` + source + `"},"marketplaceSource":{"sourceType":"local","source":"` + filepath.Dir(filepath.Dir(source)) + `"}}]}`
	if err := os.WriteFile(list, []byte(listJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	codex := filepath.Join(binDir, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\ncat \"$RECEIPT_PLUGIN_LIST\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RECEIPT_PLUGIN_LIST", list)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	bundles := collectCodexBundle()
	if len(bundles) != 1 {
		t.Fatalf("bundles = %#v, want one active bundle", bundles)
	}
	if bundles[0].Path != source || bundles[0].Version != "1.1.0" {
		t.Fatalf("active bundle = %#v, cache path was incorrectly selected", bundles[0])
	}
}

func TestCollectCodexBundleOmitsIntentionalSingleHarnessInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	binDir := t.TempDir()
	codex := filepath.Join(binDir, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if bundles := collectCodexBundle(); len(bundles) != 0 {
		t.Fatalf("unconfigured Codex without Felt = %#v, want omitted", bundles)
	}
}

func TestCollectCodexBundleReportsConfiguredButAbsentInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	config := `[plugins."felt@cailmdaley-felt"]
enabled = true
`
	if err := os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	codex := filepath.Join(binDir, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	bundles := collectCodexBundle()
	if len(bundles) != 1 || bundles[0].Status != receiptMissing {
		t.Fatalf("configured but absent Codex Felt = %#v, want one missing bundle", bundles)
	}
}

func TestCollectDaemonReceiptRequiresMatchingContract(t *testing.T) {
	tests := []struct {
		name string
		body map[string]any
		want receiptStatus
	}{
		{"healthy", map[string]any{"contract": map[string]any{"expected": 2, "observed": 2, "ok": true}}, receiptHealthy},
		{"mismatch", map[string]any{"contract": map[string]any{"expected": 2, "observed": 1, "ok": false}}, receiptMismatch},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(tt.body)
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			got := collectDaemonReceipt()
			if got.Status != tt.want {
				t.Fatalf("daemon receipt = %#v, want status %q", got, tt.want)
			}
			if tt.want == receiptHealthy && !got.Contract {
				t.Fatal("matching daemon contract was not accepted")
			}
		})
	}
}

func TestHookFilesCompatibleRequiresBothBoundaryHooks(t *testing.T) {
	root := t.TempDir()
	hooks := filepath.Join(root, "hooks")
	if err := os.MkdirAll(hooks, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"session.sh", "remind.sh", "felt-bin.sh"} {
		if err := os.WriteFile(filepath.Join(hooks, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	manifest := `{"hooks":{"SessionStart":[{"hooks":[{"command":"${PLUGIN_ROOT}/hooks/session.sh"}]}],"PreToolUse":[{"hooks":[{"command":"${PLUGIN_ROOT}/hooks/remind.sh"}]}]}}`
	if err := os.WriteFile(filepath.Join(hooks, "hooks.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if !hookFilesCompatible(root) {
		t.Fatal("complete hook bundle was rejected")
	}
	if err := os.Remove(filepath.Join(hooks, "remind.sh")); err != nil {
		t.Fatal(err)
	}
	if hookFilesCompatible(root) {
		t.Fatal("missing reminder hook was reported compatible")
	}
}

func TestCodexHooksTrustedRequiresBothActiveBoundaryEntries(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	config := `[hooks.state."felt@cailmdaley-felt:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:one"

[hooks.state."felt@cailmdaley-felt:hooks/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:two"
`
	if err := os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if !codexHooksTrusted() {
		t.Fatal("trusted active hook entries were not recognized")
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(config[:len(config)-len("\n[hooks.state.\"felt@cailmdaley-felt:hooks/hooks.json:pre_tool_use:0:0\"]\ntrusted_hash = \"sha256:two\"\n")]), 0o644); err != nil {
		t.Fatal(err)
	}
	if codexHooksTrusted() {
		t.Fatal("one missing trust entry was reported fully trusted")
	}
}
