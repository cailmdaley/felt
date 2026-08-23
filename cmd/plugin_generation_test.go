package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPluginGenerationMarkerBindsSameVersionPayloadChanges(t *testing.T) {
	root := testRepoRoot(t)
	one := filepath.Join(t.TempDir(), "one")
	two := filepath.Join(t.TempDir(), "two")
	for _, destination := range []string{one, two} {
		for _, name := range []string{".claude-plugin", "claude-plugin"} {
			if err := copyTree(filepath.Join(root, name), filepath.Join(destination, name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(two, "claude-plugin", "skills", "felt", "SKILL.md"), []byte("same version, different payload\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := buildPluginGeneration("local", root, "", "", one)
	if err != nil {
		t.Fatal(err)
	}
	second, err := buildPluginGeneration("local", root, "", "", two)
	if err != nil {
		t.Fatal(err)
	}
	if first.PluginVersion != second.PluginVersion || first.PayloadSHA256 == second.PayloadSHA256 {
		t.Fatalf("identities do not isolate payload change: first=%#v second=%#v", first, second)
	}
}

func TestPluginGenerationMarkerLivesInsideHarnessPayload(t *testing.T) {
	root := testRepoRoot(t)
	candidate := filepath.Join(t.TempDir(), "candidate")
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(root, name), filepath.Join(candidate, name)); err != nil {
			t.Fatal(err)
		}
	}
	identity, err := buildPluginGeneration("github", marketplaceRepo, "v1.2.3", "0123456789012345678901234567890123456789", candidate)
	if err != nil {
		t.Fatal(err)
	}
	if err := writePluginGeneration(candidate, identity); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(candidate, "claude-plugin", pluginGenerationMarkerName)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got pluginGenerationIdentity
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got != identity {
		t.Fatalf("marker = %#v, want %#v", got, identity)
	}
	if digest, err := pluginPayloadDigest(filepath.Join(candidate, "claude-plugin")); err != nil || digest != identity.PayloadSHA256 {
		t.Fatalf("marker changed payload digest: %q (%v), want %q", digest, err, identity.PayloadSHA256)
	}
	if got, err := validatePluginGeneration(filepath.Join(candidate, "claude-plugin")); err != nil || got != identity {
		t.Fatalf("validated identity = %#v (%v), want %#v", got, err, identity)
	}
	if err := os.WriteFile(filepath.Join(candidate, "claude-plugin", "skills", "felt", "SKILL.md"), []byte("tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := validatePluginGeneration(filepath.Join(candidate, "claude-plugin")); err == nil {
		t.Fatal("tampered generation validated")
	}
}
