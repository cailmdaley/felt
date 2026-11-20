package messaging

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// DetectProcessSender names the caller from the nearest live hook registration
// in its process ancestry, or "" when none or several match. A registration at
// or beyond the nearest process running another harness's binary belongs to a
// session that harness runs inside, not to the caller. Claude Code's process
// is named for its version and Pi's for node, so only Codex and agy are seen
// this way.
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
	boundary, boundaryHarness := len(ancestors)+1, ""
	for pid, distance := os.Getpid(), 0; distance < len(ancestors); distance++ {
		parent, name, ok := processParent(pid)
		if !ok {
			break
		}
		if boundaryHarness = harnessBinary(name); boundaryHarness != "" {
			boundary = distance
			break
		}
		pid = parent
	}
	return detectProcessSenderForThread(env, host, ancestors, boundary, boundaryHarness)
}

// harnessBinary names the harness whose binary a process runs, or "".
func harnessBinary(process string) string {
	for _, facts := range harness.All() {
		if strings.EqualFold(process, facts.Binary) {
			return facts.Name
		}
	}
	return ""
}

func detectProcessSenderForThread(env *sysenv.Env, host string, ancestors map[int]int, boundary int, boundaryHarness string) string {
	nearest := len(ancestors) + 64
	sender := ""
	ambiguous := false
	for _, facts := range harness.All() {
		name := facts.Name
		root := filepath.Join(dataDir(env), "mailboxes", name)
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
			if distance >= boundary && name != boundaryHarness {
				continue
			}
			address, err := FormatAddress(host, name, registration.ID)
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
