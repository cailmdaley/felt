package cmd

// A promoted marketplace path is only the source of truth until a native
// harness copies it into its own cache.  The marker travels with that copy so
// setup receipt can prove that current and the loaded cache are the same
// generation even when their manifest versions happen to match.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const pluginGenerationMarkerName = ".felt-generation.json"

type pluginGenerationIdentity struct {
	Schema         int    `json:"schema"`
	SourceKind     string `json:"source_kind"`
	Source         string `json:"source"`
	RequestedRef   string `json:"requested_ref,omitempty"`
	ResolvedCommit string `json:"resolved_commit,omitempty"`
	PluginVersion  string `json:"plugin_version"`
	FeltBuild      string `json:"felt_build"`
	PayloadSHA256  string `json:"payload_sha256"`
}

func localPluginGeneration(source, candidate string) (pluginGenerationIdentity, error) {
	abs, err := filepath.Abs(source)
	if err != nil {
		return pluginGenerationIdentity{}, fmt.Errorf("resolving local plugin source: %w", err)
	}
	commit := gitResolvedCommit(abs)
	return buildPluginGeneration("local", abs, "", commit, candidate)
}

func remotePluginGeneration(source, checkout, candidate string) (pluginGenerationIdentity, error) {
	ref, err := parseRemoteMarketplaceRef(source)
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	commit := gitResolvedCommit(checkout)
	if commit == "" {
		return pluginGenerationIdentity{}, fmt.Errorf("resolving acquired marketplace commit for %q", source)
	}
	return buildPluginGeneration("github", ref.repository, ref.ref, commit, candidate)
}

func buildPluginGeneration(kind, source, requestedRef, commit, candidate string) (pluginGenerationIdentity, error) {
	manifest, err := readJSONFile[pluginManifest](filepath.Join(candidate, "claude-plugin", ".claude-plugin", "plugin.json"))
	if err != nil {
		return pluginGenerationIdentity{}, fmt.Errorf("reading promoted plugin version: %w", err)
	}
	digest, err := pluginPayloadDigest(filepath.Join(candidate, "claude-plugin"))
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	return pluginGenerationIdentity{
		Schema:         1,
		SourceKind:     kind,
		Source:         source,
		RequestedRef:   requestedRef,
		ResolvedCommit: commit,
		PluginVersion:  manifest.Version,
		FeltBuild:      feltBuildIdentity(),
		PayloadSHA256:  digest,
	}, nil
}

func feltBuildIdentity() string {
	if strings.TrimSpace(rootCmd.Version) != "" {
		return rootCmd.Version
	}
	return Version
}

func sealPluginGeneration(candidate string, identity pluginGenerationIdentity) error {
	if err := writePluginGeneration(candidate, identity); err != nil {
		return err
	}
	if _, err := validatePluginGeneration(filepath.Join(candidate, "claude-plugin")); err != nil {
		return fmt.Errorf("validating sealed plugin generation: %w", err)
	}
	return nil
}

func writePluginGeneration(candidate string, identity pluginGenerationIdentity) error {
	data, err := json.MarshalIndent(identity, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding plugin generation: %w", err)
	}
	data = append(data, '\n')
	path := filepath.Join(candidate, "claude-plugin", pluginGenerationMarkerName)
	// The marker is what recovery and the receipt trust after a crash, so its
	// write must be atomic and durable: fsynced temp file, rename, then a
	// parent-directory sync to make the rename itself survive power loss.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".felt-generation-*")
	if err != nil {
		return fmt.Errorf("writing plugin generation marker: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return fmt.Errorf("writing plugin generation marker: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing plugin generation marker: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("writing plugin generation marker: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("writing plugin generation marker: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("committing plugin generation marker: %w", err)
	}
	if err := syncParentDir(path); err != nil {
		return fmt.Errorf("committing plugin generation marker: %w", err)
	}
	return nil
}

func readPluginGeneration(pluginRoot string) (pluginGenerationIdentity, error) {
	path := filepath.Join(pluginRoot, pluginGenerationMarkerName)
	identity, err := readJSONFile[pluginGenerationIdentity](path)
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	if identity.Schema != 1 || identity.SourceKind == "" || identity.Source == "" ||
		identity.PluginVersion == "" || identity.FeltBuild == "" || identity.PayloadSHA256 == "" {
		return pluginGenerationIdentity{}, fmt.Errorf("incomplete plugin generation marker %q", path)
	}
	if identity.SourceKind == "github" && identity.ResolvedCommit == "" {
		return pluginGenerationIdentity{}, fmt.Errorf("remote plugin generation marker %q has no resolved commit", path)
	}
	return identity, nil
}

func validatePluginGeneration(pluginRoot string) (pluginGenerationIdentity, error) {
	identity, err := readPluginGeneration(pluginRoot)
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	digest, err := pluginPayloadDigest(pluginRoot)
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	if digest != identity.PayloadSHA256 {
		return pluginGenerationIdentity{}, fmt.Errorf("plugin payload digest %s disagrees with generation marker %s", digest, identity.PayloadSHA256)
	}
	manifest, err := readJSONFile[pluginManifest](filepath.Join(pluginRoot, ".claude-plugin", "plugin.json"))
	if err != nil {
		return pluginGenerationIdentity{}, err
	}
	if manifest.Version != identity.PluginVersion {
		return pluginGenerationIdentity{}, fmt.Errorf("plugin manifest version %q disagrees with generation marker %q", manifest.Version, identity.PluginVersion)
	}
	return identity, nil
}

func gitResolvedCommit(root string) string {
	out, err := exec.Command("git", "-C", root, "rev-parse", "--verify", "HEAD^{commit}").Output()
	if err != nil {
		return ""
	}
	commit := strings.TrimSpace(string(out))
	if len(commit) != 40 && len(commit) != 64 {
		return ""
	}
	for _, r := range commit {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return ""
		}
	}
	return strings.ToLower(commit)
}

// pluginPayloadDigest hashes relative path, executable mode, and contents for
// every regular payload file. The generation marker itself is excluded so its
// digest can describe the bytes which the marker accompanies.
func pluginPayloadDigest(root string) (string, error) {
	var paths []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported plugin payload entry %q", path)
		}
		// Prefix match: a SIGKILL between the marker's temp-file creation and
		// its rename can strand a `.felt-generation-*` temp file in the same
		// tree; neither it nor the marker belongs to the described payload.
		if strings.HasPrefix(filepath.Base(path), ".felt-generation") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("walking plugin payload for digest: %w", err)
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, rel := range paths {
		path := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s\x00%03o\x00", rel, info.Mode().Perm()&0o111)
		file, err := os.Open(path)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(h, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
