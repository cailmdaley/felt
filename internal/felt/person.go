package felt

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// PersonConfigKey is the git config key naming the person a checkout works
// for. Open fibers created in that checkout are stamped `role: <person>`.
const PersonConfigKey = "felt.person"

var roleSegment = `[a-z0-9]+(?:-[a-z0-9]+)*`
var rolePattern = regexp.MustCompile(`^` + roleSegment + `(?:/` + roleSegment + `)?$`)

// ValidRole reports whether role is `<office>` or `<office>/<person>`, each
// segment a slug. The office is never `roles`, so a charter path such as
// `roles/analyst` is not mistaken for a role.
func ValidRole(role string) bool {
	return rolePattern.MatchString(role) && !strings.HasPrefix(role+"/", "roles/")
}

// RolePerson is the person responsible under role: its last segment, so
// `role: sam` (Sam's own desk) and `role: analyst/sam` are both Sam's.
func RolePerson(role string) string { return path.Base(role) }

// PersonAt returns felt.person for the repository that holds, or will hold,
// the fiber file at file. The nearest existing ancestor is resolved through
// symlinks first, so a fiber reached through a mount answers to the mounted
// repository's config. Git's own precedence applies (the repository's config,
// then the global one).
func PersonAt(file string) string {
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(dir); err == nil || filepath.Dir(dir) == dir {
			break
		}
		dir = filepath.Dir(dir)
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	out, _ := exec.Command("git", "-C", dir, "config", "--get", PersonConfigKey).Output()
	return strings.TrimSpace(string(out))
}

// StampRole gives an open or active fiber about to be created at its id in s
// the role `<person>` when it has none and its repository names a person.
// Create calls it; creators that write through Write under their own lock
// call it themselves.
func (s *Storage) StampRole(f *Felt) {
	if f.Role != "" || (f.Status != StatusOpen && f.Status != StatusActive) {
		return
	}
	f.Role = PersonAt(s.Path(f.ID))
}

// SetRole gives f role, refusing one that is not <office> or <office>/<person>;
// an empty role clears it.
func (f *Felt) SetRole(role string) error {
	if role != "" && !ValidRole(role) {
		return fmt.Errorf("role must be <person> or <office>/<person>, each a lowercase slug, got %q", role)
	}
	f.Role = role
	return nil
}
