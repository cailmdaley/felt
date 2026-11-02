package messaging

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// DetectProcessSender resolves a caller from a live hook registration.
// Mutable session-id environment variables never establish sender identity.
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
	codexDistance := len(ancestors) + 1
	for pid, distance := os.Getpid(), 0; distance < len(ancestors); distance++ {
		parent, name, ok := processParent(pid)
		if !ok {
			break
		}
		if strings.EqualFold(name, "codex") {
			codexDistance = distance
			break
		}
		pid = parent
	}
	return detectProcessSenderForThread(env, host, ancestors, codexDistance)
}

func detectProcessSenderForThread(env *sysenv.Env, host string, ancestors map[int]int, codexDistance int) string {
	nearest := len(ancestors) + 64
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
			if distance >= codexDistance && harness != "codex" {
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
