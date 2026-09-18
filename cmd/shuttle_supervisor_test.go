package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Render both supervisors with a disposable home: default installs must use
// the editable registry even when an old FELT_STORES is inherited at install.
func TestSupervisorStoreSource(t *testing.T) {
	for _, platform := range []string{"Darwin", "Linux"} {
		for _, fixed := range []bool{false, true} {
			t.Run(platform+map[bool]string{false: "/registry", true: "/override"}[fixed], func(t *testing.T) {
				home := t.TempDir()
				registry := filepath.Join(home, "custom-stores.json")
				t.Setenv("HOME", home)
				t.Setenv("FELT_STORES", "/stale/inherited/store")
				t.Setenv("AGENT_FELT_STORES", "")
				t.Setenv("FELT_STORES_FILE", registry)
				args := []string{"../bin/shuttle", "install-agent", "--print", "--os", platform, "--path", os.Getenv("PATH")}
				stores := ""
				if fixed {
					stores = "/chosen/store"
					args = append(args, "--felt-stores", stores)
				}
				out, err := exec.Command("sh", args...).Output()
				if err != nil {
					t.Fatal(err)
				}
				text := string(out)
				wantStores, wantRegistry := "Environment=FELT_STORES="+stores+"\n", "Environment=FELT_STORES_FILE="+registry+"\n"
				if platform == "Darwin" {
					wantStores = "<key>FELT_STORES</key>\n        <string>" + stores + "</string>"
					wantRegistry = "<key>FELT_STORES_FILE</key>\n        <string>" + registry + "</string>"
				}
				if !strings.Contains(text, wantStores) || !strings.Contains(text, wantRegistry) || strings.Contains(text, "/stale/inherited/store") {
					t.Fatalf("unexpected store configuration:\n%s", text)
				}
				entries, err := os.ReadDir(home)
				if err != nil || len(entries) != 0 {
					t.Fatalf("preview mutated home: %v %v", entries, err)
				}
			})
		}
	}
}
