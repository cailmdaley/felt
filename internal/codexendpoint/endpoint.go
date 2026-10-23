// Package codexendpoint names the host-local Codex control endpoint.
package codexendpoint

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"strings"
)

// Resolve is independent of HOME, CODEX_HOME, TMPDIR and XDG_RUNTIME_DIR.
// hostname is the actual OS hostname, never Shuttle's logical host identity.
func Resolve(override string, uid int, hostname string) (string, error) {
	if override != "" {
		if !filepath.IsAbs(override) || filepath.Clean(override) != override || strings.ContainsAny(override, "\x00\n\r") || len(override) > 100 {
			return "", fmt.Errorf("SHUTTLE_CODEX_SOCKET must be a clean absolute Unix socket path of at most 100 bytes")
		}
		return override, nil
	}
	if uid < 0 || hostname == "" {
		return "", fmt.Errorf("cannot establish OS uid and hostname for Codex endpoint")
	}
	hash := sha256.Sum256([]byte(hostname))
	return fmt.Sprintf("/tmp/shuttle-codex-%d-%x/control.sock", uid, hash[:8]), nil
}
