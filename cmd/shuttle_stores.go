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
// status` runs from the shuttle checkout, not a felt repo). So it mirrors
// shuttle-ctl's FeltStores precedence — LOOM_HOMES → ~/.shuttle/felt_stores.json
// registry → LOOM_HOME → ~/loom — ported here as the same surface the Elixir
// poller reads. This is operational config (which stores exist on this machine),
// not the felt data model; it stays isolated in the shuttle cmd layer.
//
// In production LOOM_HOMES is set (=~/loom on this Mac), so configuredFeltStores
// resolves to the single loom aggregate, whose .felt/ symlinks felt's storage
// follows into every project substore — one in-process walk covers everything.
// The registry path is the fallback for a machine that does not set LOOM_HOMES.

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
// shuttle-ctl's schema.FeltStores (which mirrors Shuttle.FeltStores in the Elixir
// daemon) so the felt CLI sees the same surface the poller does:
//
//  1. LOOM_HOMES env var (comma-separated; non-empty wins)
//  2. ~/.shuttle/felt_stores.json (or $SHUTTLE_FELT_STORES_FILE) when present
//  3. Single store from shuttleLoomHome (LOOM_HOME, then ~/loom)
func configuredFeltStores() ([]string, error) {
	if envStores := loomHomesEnv(); len(envStores) > 0 {
		return envStores, nil
	}
	if registered, err := registeredFeltStores(); err == nil && len(registered) > 0 {
		return registered, nil
	}
	store, err := shuttleLoomHome()
	if err != nil {
		return nil, err
	}
	return []string{store}, nil
}

// shuttleLoomHome returns the single default loom store: LOOM_HOME, then ~/loom.
// It is the from-anywhere fallback for the shuttle verbs — where felt's note
// verbs error outside a felt repo, the shuttle surface defaults to the loom
// aggregate (shuttle-ctl's FeltStore behavior).
func shuttleLoomHome() (string, error) {
	if loom := os.Getenv("LOOM_HOME"); loom != "" {
		return expandUserPath(loom)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, "loom"), nil
}

// loomHomesEnv parses LOOM_HOMES into a normalized store list, matching the
// Elixir reader's split-and-trim.
func loomHomesEnv() []string {
	raw := os.Getenv("LOOM_HOMES")
	if raw == "" {
		return nil
	}
	return normalizeFeltStores(strings.Split(raw, ","))
}

// registeredFeltStores reads the persisted ~/.shuttle/felt_stores.json (or
// $SHUTTLE_FELT_STORES_FILE override) and returns its normalized store list. A
// missing file or empty list returns an empty slice with no error — callers fall
// back to the single loom default.
func registeredFeltStores() ([]string, error) {
	path, err := feltStoresRegistryPath()
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

func feltStoresRegistryPath() (string, error) {
	if env := os.Getenv("SHUTTLE_FELT_STORES_FILE"); env != "" {
		return expandUserPath(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".shuttle", "felt_stores.json"), nil
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
