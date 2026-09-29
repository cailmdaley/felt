package shuttle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DataDir is the host-local shuttle state directory: $SHUTTLE_DATA_DIR, else
// ~/.shuttle. The variable is trimmed, and a leading "~" or "~/" is expanded
// to the home directory; the value is otherwise neither cleaned nor made
// absolute, so a socket-path check sees what the operator wrote. Every
// host-local file the CLI and the daemon keep — the event stream, the ledgers,
// the mailboxes, the daemon socket — lives under it.
//
// The daemon's Shuttle.data_dir/0 applies the same rule, and
// daemon/test/fixtures/data_dir/cases.json holds both readers to it.
//
// It errors only when a home directory is needed and cannot be resolved.
func DataDir() (string, error) {
	v := strings.TrimSpace(os.Getenv("SHUTTLE_DATA_DIR"))
	if v != "" && v != "~" && !strings.HasPrefix(v, "~/") {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	if v == "" {
		return filepath.Join(home, ".shuttle"), nil
	}
	return home + v[1:], nil
}
