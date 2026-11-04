package shuttlecli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestRexInstall(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, arch, file string
		corrupt          bool
	}{
		{"amd64", "x86_64", "rex-linux-amd64.tar.gz", false},
		{"arm64", "aarch64", "rex-linux-arm64.tar.gz", false},
		{"checksum mismatch", "x86_64", "rex-linux-amd64.tar.gz", true},
		{"unsupported", "riscv64", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			tools := t.TempDir()
			env.Set("PATH", tools+":/usr/bin:/bin")
			// macOS has shasum instead of sha256sum; the installer targets Linux.
			sysenvtest.LinkScript(t, filepath.Join(tools, "sha256sum"), "#!/bin/sh\nexec shasum -a 256 \"$@\"\n")
			// On Linux, use its actual verifier rather than the macOS adapter.
			if bin, err := env.LookPath("/usr/bin/sha256sum"); err == nil {
				os.Remove(filepath.Join(tools, "sha256sum"))
				if err := os.Symlink(bin, filepath.Join(tools, "sha256sum")); err != nil {
					t.Fatal(err)
				}
			}
			sysenvtest.LinkScript(t, filepath.Join(tools, "uname"), "#!/bin/sh\ncase $1 in -s) echo Linux;; -m) echo "+tc.arch+";; esac\n")
			payload := []byte("#!/bin/sh\necho installed-rex\n")
			var archive bytes.Buffer
			gz := gzip.NewWriter(&archive)
			tw := tar.NewWriter(gz)
			if err := tw.WriteHeader(&tar.Header{Name: "rex", Mode: 0755, Size: int64(len(payload))}); err != nil {
				t.Fatal(err)
			}
			tw.Write(payload)
			tw.Close()
			gz.Close()
			tarPath := filepath.Join(t.TempDir(), "archive.tar.gz")
			if err := os.WriteFile(tarPath, archive.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			sha := fmt.Sprintf("%x", sha256.Sum256(archive.Bytes()))
			if tc.corrupt {
				sha = strings.Repeat("0", 64)
			}
			release := fmt.Sprintf(`{"commit":"abc123","artifacts":[{"filename":"rex-linux-amd64.zip","sha256":"bad"},{"filename":%q,"sha256":%q}]}`, tc.file, sha)
			releasePath := filepath.Join(t.TempDir(), "release.json")
			os.WriteFile(releasePath, []byte(release), 0600)
			calls := filepath.Join(t.TempDir(), "calls")
			sysenvtest.LinkScript(t, filepath.Join(tools, "curl"), `#!/bin/sh
[ "$1" = -fsSL ] && [ "$3" = -o ] || exit 91
printf '%s\n' "$2" >> `+shellQuote(calls)+`
case "$2" in
 https://blob.superlogical.com/api/releases/rex/snapshot) cp `+shellQuote(releasePath)+` "$4" ;;
 https://blob.superlogical.com/download/rex/snapshot/abc123/`+tc.file+`) cp `+shellQuote(tarPath)+` "$4" ;;
 *) exit 92 ;;
esac
`)
			target := filepath.Join(env.Getenv("HOME"), ".local/bin/rex")
			os.MkdirAll(filepath.Dir(target), 0700)
			os.WriteFile(target, []byte("existing-binary"), 0755)
			// Keep the old inode open: replacing it must not modify a running server's binary.
			old, err := os.Open(target)
			if err != nil {
				t.Fatal(err)
			}
			defer old.Close()
			for range 2 {
				out, err := env.Command("/bin/sh", "../../bin/rex-install").CombinedOutput()
				got, _ := os.ReadFile(target)
				if tc.corrupt || tc.file == "" {
					if err == nil || string(got) != "existing-binary" {
						t.Fatalf("failed install: %s %v, target %q", out, err, got)
					}
				} else {
					if err != nil || !bytes.Equal(got, payload) || !strings.Contains(string(out), "No running server was touched") {
						t.Fatalf("install: %s %v, target %q", out, err, got)
					}
				}
			}
			oldData := make([]byte, len("existing-binary"))
			old.ReadAt(oldData, 0)
			if string(oldData) != "existing-binary" {
				t.Fatalf("old inode changed: %q", oldData)
			}
		})
	}
}
