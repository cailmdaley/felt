package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Store resolution for the felt shuttle aggregate-read verbs (status, ps) and the
// single-fiber address verbs (session-name, attach). felt's note verbs always
// operate on one store resolved from -C/cwd; the shuttle read surface needs more:
// it must see every fiber the daemon would dispatch, from anywhere (e.g. `make
// status` runs from the felt checkout, not a felt repo). So it mirrors
// Shuttle.FeltStores' precedence — FELT_STORES env → ~/.config/felt/stores.json
// registry — ported here as the same surface the Elixir poller reads. This is
// operational config (which stores exist on this machine), not the felt data
// model; it stays isolated in the shuttle cmd layer.
//
// The registry is the source of truth: when FELT_STORES is unset, configuredFeltStores
// resolves to whatever the registry lists (empty when none registered). A registered
// aggregate store whose .felt/ symlinks fan out into project substores is covered by
// one in-process walk.

// shuttleStores returns the felt stores the aggregate read verbs walk. With -C /
// --felt-store set (changeDir, mapped by the group's PersistentPreRun), it is that
// single store — the explicit scope wins, exactly as the daemon's
// `--felt-store <store>` invocations expect. Otherwise it is the configured store
// surface (configuredFeltStores).
func shuttleStores() ([]string, error) {
	if changeDir != "" {
		root, err := resolveProjectRoot()
		if err != nil {
			return nil, err
		}
		return []string{root}, nil
	}
	return configuredFeltStores()
}

// configuredFeltStores returns every felt store the dispatcher considers, mirroring
// Shuttle.FeltStores in the Elixir daemon so the felt CLI sees the same surface the
// poller does:
//
//  1. FELT_STORES env var (comma-separated; non-empty wins)
//  2. the persisted registry ~/.config/felt/stores.json (or $FELT_STORES_FILE)
//
// The registry is the source of truth; an empty env and an empty/absent registry
// resolve to no stores (callers handle the empty case).
func configuredFeltStores() ([]string, error) {
	if envStores := feltStoresEnv(); len(envStores) > 0 {
		return envStores, nil
	}
	return registeredFeltStores()
}

// feltStoresEnv parses FELT_STORES into a normalized store list, matching the
// Elixir reader's split-and-trim.
func feltStoresEnv() []string {
	raw := os.Getenv("FELT_STORES")
	if raw == "" {
		return nil
	}
	return normalizeFeltStores(strings.Split(raw, ","))
}

// registeredFeltStores reads the persisted registry (~/.config/felt/stores.json,
// or $FELT_STORES_FILE) and returns its normalized store list. A missing file or
// empty list returns an empty slice with no error.
func registeredFeltStores() ([]string, error) {
	path, err := feltStoresRegistryReadPath()
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	// Tolerate both shapes the Elixir writer accepts:
	//   {"version": 1, "felt_stores": [...]}  ← canonical
	//   [...]                                 ← bare list
	var wrapped struct {
		FeltStores []string `json:"felt_stores"`
	}
	if err := json.Unmarshal(content, &wrapped); err == nil && wrapped.FeltStores != nil {
		return normalizeFeltStores(wrapped.FeltStores), nil
	}
	var bare []string
	if err := json.Unmarshal(content, &bare); err == nil {
		return normalizeFeltStores(bare), nil
	}
	return nil, fmt.Errorf("parsing %s: unexpected shape", path)
}

// feltStoresRegistryPath is the canonical registry location for WRITES:
// $FELT_STORES_FILE, else ~/.config/felt/stores.json.
func feltStoresRegistryPath() (string, error) {
	if env := os.Getenv("FELT_STORES_FILE"); env != "" {
		return expandUserPath(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "felt", "stores.json"), nil
}

// feltStoresRegistryReadPath is the path to READ from: the canonical path when it
// exists, else the legacy ~/.shuttle/felt_stores.json as a one-time shim for a host
// not yet migrated off the old location. An explicit $FELT_STORES_FILE is honored
// verbatim (no legacy fallback). Mirrors Shuttle.FeltStores.read_config_path/0.
func feltStoresRegistryReadPath() (string, error) {
	primary, err := feltStoresRegistryPath()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(primary); err == nil {
		return primary, nil
	}
	if os.Getenv("FELT_STORES_FILE") == "" {
		if home, herr := os.UserHomeDir(); herr == nil {
			legacy := filepath.Join(home, ".shuttle", "felt_stores.json")
			if _, serr := os.Stat(legacy); serr == nil {
				return legacy, nil
			}
		}
	}
	return primary, nil
}

// normalizeFeltStores trims, drops empty, expands `~`, and deduplicates while
// preserving first-seen order — matching Shuttle.FeltStores.normalize.
func normalizeFeltStores(stores []string) []string {
	seen := make(map[string]bool, len(stores))
	out := make([]string, 0, len(stores))
	for _, s := range stores {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		expanded, err := expandUserPath(s)
		if err != nil {
			continue
		}
		if seen[expanded] {
			continue
		}
		seen[expanded] = true
		out = append(out, expanded)
	}
	return out
}

// canonicalFiberID re-derives a fiber's dispatch-canonical id from its on-disk
// markdown path: the id relative to the NEAREST enclosing .felt store, not the
// outer aggregate-store namespace. This matters for fibers in symlinked
// substores (e.g. an aggregate's .felt/<x>/lightcone -> a project's own .felt):
// felt's aggregate walk names such a fiber by its full outer path (…/lightcone/foo),
// but the daemon polls the project store DIRECTLY (it expands the aggregate's
// symlinks into the real store roots) and so identifies — and dispatches, and routes
// write verbs by — the SUBSTORE id (lightcone/foo). shuttle-ctl re-canonicalized
// the same way (schema.FiberRefFromPath); status/ps must too, or a status
// fiber_id won't round-trip into a daemon-routed verb (and the Stage 3.4 shim
// would change shuttle-ctl's output). Ported from shuttle's pkg/schema/fiber.go.
//
// Returns "" with an error when the path is not under a .felt store (caller falls
// back to felt's native id). felt already carries f.Path symlink-resolved, but
// EvalSymlinks again here is idempotent and keeps the function correct for any
// caller.
func canonicalFiberID(mdPath string) (string, error) {
	if mdPath == "" {
		return "", fmt.Errorf("empty fiber path")
	}
	abs, err := filepath.Abs(mdPath)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	rel, err := feltStoreRelativePath(abs)
	if err != nil {
		return "", err
	}
	return fiberIDFromStorePath(rel)
}

// feltStoreRelativePath walks up from a markdown path to the nearest enclosing
// .felt directory and returns the path relative to it (slash-separated).
func feltStoreRelativePath(path string) (string, error) {
	current := filepath.Dir(path)
	for {
		if filepath.Base(current) == ".felt" {
			rel, err := filepath.Rel(current, path)
			if err != nil {
				return "", fmt.Errorf("computing store-relative path: %w", err)
			}
			return filepath.ToSlash(rel), nil
		}
		next := filepath.Dir(current)
		if next == current {
			break
		}
		current = next
	}
	return "", fmt.Errorf("path %q is not under a .felt store", path)
}

// fiberIDFromStorePath derives the fiber id from a store-relative markdown path,
// honoring felt's directory-per-fiber layout (<id>/<leaf>.md) and the flat
// single-file form (<leaf>.md at the store root).
func fiberIDFromStorePath(rel string) (string, error) {
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "./")
	parts := strings.Split(rel, "/")
	if len(parts) == 0 {
		return "", fmt.Errorf("empty store-relative path")
	}
	file := parts[len(parts)-1]
	if !strings.HasSuffix(file, ".md") {
		return "", fmt.Errorf("path %q does not point at a markdown fiber", rel)
	}
	basename := strings.TrimSuffix(file, ".md")
	if len(parts) == 1 {
		return basename, nil
	}
	parent := parts[len(parts)-2]
	if parent != basename {
		return "", fmt.Errorf("unexpected fiber layout under .felt: %q", rel)
	}
	return strings.Join(parts[:len(parts)-1], "/"), nil
}

// expandUserPath expands a leading ~ and returns a cleaned absolute path.
func expandUserPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("empty path")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, path[2:])
		}
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}
