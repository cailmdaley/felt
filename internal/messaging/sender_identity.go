package messaging

import (
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// DetectProcessSender resolves a caller from a live hook registration or a
// per-thread capability injected by the Codex App Server. Mutable session-id
// environment variables never establish sender identity.
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
	capabilityID := ""
	if capability := env.Getenv("SHUTTLE_SENDER_CAPABILITY"); capability != "" {
		capabilityID, _ = codexSenderFromCapability(env, host, capability)
	}
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
			if harness == "codex" && (capabilityID == "" || registration.ID != capabilityID) {
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
	if capabilityID != "" && (sender == "" || nearest > codexDistance) {
		address, err := FormatAddress(host, "codex", capabilityID)
		if err == nil {
			return address
		}
	}
	return sender
}

type codexCapabilityOwner struct {
	SessionUUID          string `json:"session_uuid"`
	ThreadID             string `json:"thread_id"`
	BackendHost          string `json:"backend_host"`
	BackendEndpoint      string `json:"backend_endpoint"`
	Active               bool   `json:"active"`
	SenderCapabilityHash string `json:"sender_capability_sha256"`
}

func codexSenderFromCapability(env *sysenv.Env, host, capability string) (string, bool) {
	raw, err := hex.DecodeString(capability)
	if err != nil || len(raw) != 32 {
		return "", false
	}
	hash := tokenHash(capability)
	root := filepath.Join(dataDir(env), "app-workers")
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	capturedID := env.Getenv("CODEX_THREAD_ID")
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-len(filepath.Ext(entry.Name()))]
		if capturedID != "" && capturedID != id {
			continue
		}
		path := filepath.Join(root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		b, err := readBounded(path, 1<<20)
		var record codexCapabilityOwner
		if err != nil || json.Unmarshal(b, &record) != nil || !record.Active || record.SessionUUID != id || record.ThreadID != id || record.BackendHost != host || record.BackendEndpoint != codexSocket(env) {
			continue
		}
		stored, err := hex.DecodeString(record.SenderCapabilityHash)
		want, _ := hex.DecodeString(hash)
		if err != nil || len(stored) != len(want) || subtle.ConstantTimeCompare(stored, want) != 1 {
			continue
		}
		return id, true
	}
	return "", false
}
