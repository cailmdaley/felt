package messaging

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// DetectProcessSender resolves the nearest ancestor with a live, unique hook
// registration. Environment session ids do not establish process identity.
// A shared harness process can own several sessions; that is ambiguous and
// returns no identity. Registrations and this resolver share the host user's
// filesystem trust boundary, not a boundary against arbitrary same-uid code.
func DetectProcessSender(env *sysenv.Env, host string) string {
	ancestors := make(map[int]int)
	for pid, distance := os.Getpid(), 0; pid > 0 && distance < 64; distance++ {
		if _, seen := ancestors[pid]; seen {
			break
		}
		ancestors[pid] = distance
		parent, _, ok := processParent(pid)
		if !ok {
			break
		}
		pid = parent
	}
	nearest := len(ancestors) + 1
	sender := ""
	ambiguous := false
	for _, harness := range []string{"claude", "codex", "pi"} {
		root := filepath.Join(dataDir(env), "mailboxes", harness)
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			b, err := readBounded(filepath.Join(root, entry.Name(), "receiver.json"), 16384)
			var registration mailboxRegistration
			if err != nil || json.Unmarshal(b, &registration) != nil || registration.Ended || registration.Host != host || registration.Start == "" {
				continue
			}
			distance, ancestor := ancestors[registration.PID]
			if !ancestor || distance > nearest || !registration.live() {
				continue
			}
			address, err := FormatAddress(host, harness, registration.ID)
			if err != nil {
				continue
			}
			if distance < nearest {
				nearest, sender, ambiguous = distance, address, false
			} else if address != sender {
				ambiguous = true
			}
		}
	}
	if ambiguous {
		return ""
	}
	return sender
}
