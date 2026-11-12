package felt

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// isolateGitConfig keeps the developer's global and system git config out of
// felt.person lookups.
func isolateGitConfig(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

// gitRepo initializes a repository at dir, with felt.person set when person
// is not "".
func gitRepo(t *testing.T, dir, person string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	commands := [][]string{{"init", "-q"}}
	if person != "" {
		commands = append(commands, []string{"config", PersonConfigKey, person})
	}
	for _, args := range commands {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func createAndRead(t *testing.T, s *Storage, id, status string) *Felt {
	t.Helper()
	f, err := New(id, "Fiber "+id)
	if err != nil {
		t.Fatal(err)
	}
	f.Status = status
	if err := s.Create(f); err != nil {
		t.Fatalf("Create(%s): %v", id, err)
	}
	got, err := s.Read(id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCreateStampsRoleFromHoldingRepository(t *testing.T) {
	isolateGitConfig(t)
	outer := t.TempDir()
	gitRepo(t, outer, "alice")
	s := NewStorage(outer)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	if got := createAndRead(t, s, "plain", StatusOpen).Role; got != "alice" {
		t.Fatalf("role = %q, want alice", got)
	}
	if got := createAndRead(t, s, "flying", StatusActive).Role; got != "alice" {
		t.Fatalf("active role = %q, want alice", got)
	}
	for _, status := range []string{"", StatusClosed} {
		if got := createAndRead(t, s, "note"+status, status).Role; got != "" {
			t.Fatalf("status %q stamped role %q", status, got)
		}
	}

	// A mount: the outer store's shared/ is a link into another repository's
	// .felt, whose own config says whom that checkout works for.
	other := t.TempDir()
	gitRepo(t, other, "sam")
	if err := os.MkdirAll(filepath.Join(other, ".felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(other, ".felt"), filepath.Join(s.Root(), "shared")); err != nil {
		t.Fatal(err)
	}
	if got := createAndRead(t, s, "shared/x", StatusOpen).Role; got != "sam" {
		t.Fatalf("role inside the mount = %q, want sam", got)
	}
	if got := createAndRead(t, s, "shared/x/y", StatusOpen).Role; got != "sam" {
		t.Fatalf("role under a mounted fiber = %q, want sam", got)
	}

	f, _ := New("preset", "Preset")
	f.Status, f.Role = StatusOpen, "analyst/carol"
	if err := s.Create(f); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Read("preset"); got.Role != "analyst/carol" {
		t.Fatalf("a creator's role = %q, want analyst/carol kept", got.Role)
	}
}

func TestCreateWithoutPersonWritesNoRole(t *testing.T) {
	isolateGitConfig(t)
	dir := t.TempDir()
	gitRepo(t, dir, "")
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	f := createAndRead(t, s, "x", StatusOpen)
	data, err := os.ReadFile(f.Path)
	if err != nil {
		t.Fatal(err)
	}
	if f.Role != "" || strings.Contains(string(data), "role:") {
		t.Fatalf("unconfigured repository stamped a role:\n%s", data)
	}
}

// role sits after the native fields and before the extras: exactly where a
// felt that does not know it would round-trip it, so builds that do and don't
// rewrite the same bytes.
func TestRoleRoundTripsInPlace(t *testing.T) {
	t.Parallel()
	content := []byte(`---
id: 01JZ0000000000000000000000
name: Shared
status: open
created-at: 2026-05-31T00:00:00Z
description: one line
role: analyst/sam
tempered: true
review: later
---

body
`)
	f, err := Parse("shared", content)
	if err != nil {
		t.Fatal(err)
	}
	if f.Role != "analyst/sam" {
		t.Fatalf("Role = %q", f.Role)
	}
	if _, extra := f.ExtraFields["role"]; extra {
		t.Fatal("role parsed as an extra field")
	}
	out, err := f.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(content) {
		t.Fatalf("round trip changed bytes:\n%s", out)
	}
	f.Role = ""
	out, _ = f.Marshal()
	if strings.Contains(string(out), "role:") {
		t.Fatalf("empty role written:\n%s", out)
	}
}

func TestValidRoleAndPerson(t *testing.T) {
	t.Parallel()
	for role, want := range map[string]bool{
		"sam": true, "analyst/sam": true, "data-lead/sam-2": true,
		"": false, "a/b/c": false, "Sam": false, "analyst/": false, "/sam": false, "a--b": false, "roles/x/y": false,
	} {
		if got := ValidRole(role); got != want {
			t.Errorf("ValidRole(%q) = %v, want %v", role, got, want)
		}
	}
	if RolePerson("analyst/sam") != "sam" || RolePerson("sam") != "sam" {
		t.Fatal("RolePerson is not the last segment")
	}
}

func TestPersonLookupOtherPersons(t *testing.T) {
	isolateGitConfig(t)
	mine := t.TempDir()
	gitRepo(t, mine, "alice")
	bare := t.TempDir()
	gitRepo(t, bare, "")
	deep := filepath.Join(mine, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	p := NewPersonLookup()
	for _, tc := range []struct {
		role, dir string
		want      bool
	}{
		{"", mine, false},
		{"alice", mine, false},
		{"analyst/alice", mine, false},
		{"sam", mine, true},
		{"analyst/sam", deep, true},
		{"sam", bare, false},
	} {
		f := &Felt{Role: tc.role, Path: filepath.Join(tc.dir, "x.md")}
		if got := p.OtherPersons(f); got != tc.want {
			t.Errorf("OtherPersons(role=%q in %s) = %v, want %v", tc.role, tc.dir, got, tc.want)
		}
	}
}
