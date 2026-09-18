package cmd

import (
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
				wantStores, wantRegistry := "Environment="+strconv.Quote("FELT_STORES="+stores)+"\n", "Environment="+strconv.Quote("FELT_STORES_FILE="+registry)+"\n"
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

func TestSupervisorStorePathEscaping(t *testing.T) {
	for _, platform := range []string{"Darwin", "Linux"} {
		t.Run(platform, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			registry := filepath.Join(home, `registry & <notes> "quoted" \literal %h`, "stores.json")
			store := filepath.Join(home, `store with spaces & "quotes" \literal %n`)
			t.Setenv("FELT_STORES_FILE", registry)
			out, err := exec.Command("sh", "../bin/shuttle", "install-agent", "--print", "--os", platform,
				"--path", os.Getenv("PATH"), "--felt-stores", store).Output()
			if err != nil {
				t.Fatal(err)
			}
			for key, expected := range map[string]string{"FELT_STORES": store, "FELT_STORES_FILE": registry} {
				var got string
				if platform == "Linux" {
					prefix := `Environment="` + key + `=`
					for _, line := range strings.Split(string(out), "\n") {
						if strings.HasPrefix(line, prefix) {
							// Unquote the full assignment as systemd does, then expand
							// escaped specifier markers. A single % is never allowed.
							assignment, err := strconv.Unquote(strings.TrimPrefix(line, "Environment="))
							if err != nil {
								t.Fatal(err)
							}
							value := strings.TrimPrefix(assignment, key+"=")
							if strings.Contains(strings.ReplaceAll(value, "%%", ""), "%") {
								t.Fatalf("unescaped systemd specifier in %s", line)
							}
							got = strings.ReplaceAll(value, "%%", "%")
						}
					}
				} else {
					_, tail, found := strings.Cut(string(out), "<key>"+key+"</key>")
					if !found {
						t.Fatalf("missing %s", key)
					}
					element, _, _ := strings.Cut(strings.TrimSpace(tail), "</string>")
					if err := xml.Unmarshal([]byte(element+"</string>"), &got); err != nil {
						t.Fatal(err)
					}
				}
				if got != expected {
					t.Fatalf("%s round trip: got %q, want %q", key, got, expected)
				}
			}
		})
	}
}
