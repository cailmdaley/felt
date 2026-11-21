package shuttlecli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestRexSetupInstallsAndIsIdempotent(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	rexDir := filepath.Join(tmp, "rex")
	srcLua, err := filepath.Abs(filepath.Join("..", "..", "daemon", "share", "rex", "shuttle.lua"))
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	env := sysenv.New(tmp, nil)
	env.Stdout = &out
	env.Stderr = &out

	// Dry-run writes nothing.
	if code := Run(env, []string{"rex-setup", "--config-dir", rexDir, "--source", srcLua, "--dry-run"}); code != 0 {
		t.Fatalf("dry-run failed (%d): %s", code, out.String())
	}
	if _, err := os.Stat(filepath.Join(rexDir, "shuttle", "init.lua")); !os.IsNotExist(err) {
		t.Fatalf("dry-run should not create shuttle/init.lua")
	}

	// Real install copies shuttle.lua and creates init.lua.
	out.Reset()
	if code := Run(env, []string{"rex-setup", "--config-dir", rexDir, "--source", srcLua}); code != 0 {
		t.Fatalf("rex-setup failed (%d): %s", code, out.String())
	}
	gotLua, err := os.ReadFile(filepath.Join(rexDir, "shuttle", "init.lua"))
	if err != nil {
		t.Fatal(err)
	}
	wantLua, err := os.ReadFile(srcLua)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotLua, wantLua) {
		t.Fatalf("installed shuttle/init.lua does not match source")
	}
	initBytes, err := os.ReadFile(filepath.Join(rexDir, "init.lua"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(initBytes)) != `require("shuttle").setup{}` {
		t.Fatalf("unexpected init.lua: %q", string(initBytes))
	}

	// Second run is idempotent and does not duplicate the require line.
	out.Reset()
	if code := Run(env, []string{"rex-setup", "--config-dir", rexDir, "--source", srcLua}); code != 0 {
		t.Fatalf("second rex-setup failed (%d): %s", code, out.String())
	}
	initAfter, err := os.ReadFile(filepath.Join(rexDir, "init.lua"))
	if err != nil {
		t.Fatal(err)
	}
	if string(initAfter) != string(initBytes) {
		t.Fatalf("second run modified init.lua:\nbefore: %q\nafter:  %q", string(initBytes), string(initAfter))
	}
}

func TestRexSetupPreservesExistingInitAndKeyOverride(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	rexDir := filepath.Join(tmp, "rex")
	if err := os.MkdirAll(rexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rexDir, "init.lua"), []byte(`require("rexweb").setup{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	srcLua, err := filepath.Abs(filepath.Join("..", "..", "daemon", "share", "rex", "shuttle.lua"))
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	env := sysenv.New(tmp, nil)
	env.Stdout = &out
	env.Stderr = &out

	if code := Run(env, []string{"rex-setup", "--config-dir", rexDir, "--source", srcLua, "--key", "shift+cmd+k"}); code != 0 {
		t.Fatalf("rex-setup failed (%d): %s", code, out.String())
	}
	got, err := os.ReadFile(filepath.Join(rexDir, "init.lua"))
	if err != nil {
		t.Fatal(err)
	}
	want := "require(\"rexweb\").setup{}\n\nrequire(\"shuttle\").setup{ key = \"shift+cmd+k\" }\n"
	if string(got) != want {
		t.Fatalf("init.lua mismatch:\ngot:  %q\nwant: %q", string(got), want)
	}
}
