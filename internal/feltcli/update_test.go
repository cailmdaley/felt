package feltcli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractBinariesRequiresBothCLIExecutables(t *testing.T) {
	archive := updateArchive(t, map[string][]byte{
		"felt":    []byte("new felt"),
		"shuttle": []byte("new shuttle"),
	})
	got, err := extractBinaries(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	if string(got["felt"]) != "new felt" || string(got["shuttle"]) != "new shuttle" {
		t.Fatalf("extracted binaries = %q / %q", got["felt"], got["shuttle"])
	}

	missing := updateArchive(t, map[string][]byte{"felt": []byte("new felt")})
	if _, err := extractBinaries(bytes.NewReader(missing)); err == nil {
		t.Fatal("archive without shuttle was accepted")
	}
	empty := updateArchive(t, map[string][]byte{"felt": nil, "shuttle": []byte("new shuttle")})
	if _, err := extractBinaries(bytes.NewReader(empty)); err == nil {
		t.Fatal("archive with an empty Felt executable was accepted")
	}
}

func TestUpdatePairIsCurrentRequiresMatchingSiblingShuttle(t *testing.T) {
	dir := t.TempDir()
	feltPath := filepath.Join(dir, "felt")
	if err := os.WriteFile(feltPath, []byte("felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if updatePairIsCurrent(feltPath, "1.2.3", "v1.2.3", "build-a") {
		t.Fatal("felt without a sibling shuttle was considered up to date")
	}
	shuttlePath := filepath.Join(dir, "shuttle")
	shuttle := `#!/bin/sh
[ "$1" = "--version" ] || exit 2
printf 'shuttle version build-b\n'
`
	if err := os.WriteFile(shuttlePath, []byte(shuttle), 0o755); err != nil {
		t.Fatal(err)
	}
	if updatePairIsCurrent(feltPath, "1.2.3", "v1.2.3", "build-a") {
		t.Fatal("felt with a mismatched shuttle build was considered up to date")
	}
	shuttle = strings.ReplaceAll(shuttle, "build-b", "build-a")
	if err := os.WriteFile(shuttlePath, []byte(shuttle), 0o755); err != nil {
		t.Fatal(err)
	}
	if !updatePairIsCurrent(feltPath, "1.2.3", "v1.2.3", "build-a") {
		t.Fatal("matching felt/shuttle pair was not considered up to date")
	}
	if updatePairIsCurrent(feltPath, "1.2.2", "v1.2.3", "build-a") {
		t.Fatal("an older felt version was considered up to date")
	}
}

func TestRefuseHomebrewUpdateUsesResolvedCellarPath(t *testing.T) {
	root := t.TempDir()
	cellarBinary := filepath.Join(root, "Cellar", "felt", "1.2.3", "bin", "felt")
	if err := os.MkdirAll(filepath.Dir(cellarBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cellarBinary, []byte("felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(root, "bin", "felt")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(cellarBinary, launcher); err != nil {
		t.Fatal(err)
	}
	err := refuseHomebrewUpdate(launcher)
	if err == nil || !strings.Contains(err.Error(), "brew upgrade felt") || !strings.Contains(err.Error(), "/Cellar/") {
		t.Fatalf("Cellar-managed felt update error = %v", err)
	}
}

func TestRefuseHomebrewUpdateUsesBrewPrefix(t *testing.T) {
	root := t.TempDir()
	prefix := filepath.Join(root, "homebrew")
	binary := filepath.Join(prefix, "opt", "felt", "bin", "felt")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	brew := filepath.Join(binDir, "brew")
	if err := os.WriteFile(brew, []byte("#!/bin/sh\nprintf '%s\\n' \"$BREW_PREFIX\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("BREW_PREFIX", prefix)
	if err := refuseHomebrewUpdate(binary); err == nil || !strings.Contains(err.Error(), "brew upgrade felt") {
		t.Fatalf("Homebrew-prefix felt update error = %v", err)
	}
	outside := filepath.Join(root, "outside", "felt")
	if err := os.MkdirAll(filepath.Dir(outside), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := refuseHomebrewUpdate(outside); err != nil {
		t.Fatalf("non-Homebrew felt path was refused: %v", err)
	}
}

func TestReplaceBinaryPairStagesBothBinariesAndCreatesMissingShuttle(t *testing.T) {
	dir := t.TempDir()
	feltPath := filepath.Join(dir, "felt")
	if err := os.WriteFile(feltPath, []byte("old felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	binaries := map[string][]byte{"felt": []byte("new felt"), "shuttle": []byte("new shuttle")}
	if err := replaceBinaryPair(feltPath, binaries); err != nil {
		t.Fatal(err)
	}
	for name, want := range binaries {
		path := filepath.Join(dir, name)
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s = %q, %v; want %q", name, got, err, want)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %v; want 0755", name, info.Mode())
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("update left staging or backup files: %v", entries)
	}
}

func TestReplaceBinaryPairReplacesBothExistingBinaries(t *testing.T) {
	dir := t.TempDir()
	feltPath := filepath.Join(dir, "felt")
	for name, old := range map[string]string{"felt": "old felt", "shuttle": "old shuttle"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(old), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	binaries := map[string][]byte{"felt": []byte("new felt"), "shuttle": []byte("new shuttle")}
	if err := replaceBinaryPair(feltPath, binaries); err != nil {
		t.Fatal(err)
	}
	for name, want := range binaries {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s = %q, %v; want %q", name, got, err, want)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("update left staging or backup files: %v, %v", entries, err)
	}
}

func TestReplaceBinaryPairRejectsIncompletePairWithoutChangingEitherFile(t *testing.T) {
	dir := t.TempDir()
	feltPath := filepath.Join(dir, "felt")
	shuttlePath := filepath.Join(dir, "shuttle")
	for path, value := range map[string]string{feltPath: "old felt", shuttlePath: "old shuttle"} {
		if err := os.WriteFile(path, []byte(value), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := replaceBinaryPair(feltPath, map[string][]byte{"felt": []byte("new felt")}); err == nil {
		t.Fatal("incomplete binary pair was accepted")
	}
	for path, want := range map[string]string{feltPath: "old felt", shuttlePath: "old shuttle"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v; want %q", path, got, err, want)
		}
	}
}

func TestReplaceBinaryPairRejectsNonFileDestinationBeforeChangingPair(t *testing.T) {
	dir := t.TempDir()
	feltPath := filepath.Join(dir, "felt")
	if err := os.WriteFile(feltPath, []byte("old felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "shuttle"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := replaceBinaryPair(feltPath, map[string][]byte{"felt": []byte("new felt"), "shuttle": []byte("new shuttle")}); err == nil {
		t.Fatal("directory destination was accepted")
	}
	if got, err := os.ReadFile(feltPath); err != nil || string(got) != "old felt" {
		t.Fatalf("felt after rejected update = %q, %v", got, err)
	}
}

func updateArchive(t *testing.T, binaries map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	gz := gzip.NewWriter(&output)
	writer := tar.NewWriter(gz)
	for name, data := range binaries {
		if err := writer.WriteHeader(&tar.Header{Name: "release/" + name, Mode: 0o755, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
