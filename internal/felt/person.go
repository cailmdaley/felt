package felt

import (
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
// segment a slug.
func ValidRole(role string) bool { return rolePattern.MatchString(role) }

// RolePerson is the person responsible under role: its last segment, so
// `role: sam` (Sam's own desk) and `role: analyst/sam` are both Sam's.
func RolePerson(role string) string { return path.Base(role) }

// PersonLookup answers "whom does the repository holding this directory work
// for", running `git config --get felt.person` once per repository.
// Directories map to their repository by walking up to the one containing
// `.git`; every directory on a walk is memoized, so a store's fibers cost one
// stat each.
type PersonLookup struct {
	repoOf   map[string]string // real directory → repository root
	personOf map[string]string // repository root → felt.person
}

// NewPersonLookup returns an empty lookup.
func NewPersonLookup() *PersonLookup {
	return &PersonLookup{repoOf: map[string]string{}, personOf: map[string]string{}}
}

// For returns felt.person for the repository physically holding dir, a
// symlink-resolved directory. Git's own precedence applies (the repository's
// config, then the global one); outside any repository dir itself is asked.
func (p *PersonLookup) For(dir string) string {
	repo := p.repoRoot(dir)
	if person, ok := p.personOf[repo]; ok {
		return person
	}
	out, _ := exec.Command("git", "-C", repo, "config", "--get", PersonConfigKey).Output()
	person := strings.TrimSpace(string(out))
	p.personOf[repo] = person
	return person
}

// OtherPersons reports whether f's role names a person other than the one its
// holding repository works for. A fiber without a role, or in a repository
// with no felt.person, is nobody else's.
func (p *PersonLookup) OtherPersons(f *Felt) bool {
	if f.Role == "" || f.Path == "" {
		return false
	}
	mine := p.For(filepath.Dir(f.Path))
	return mine != "" && mine != RolePerson(f.Role)
}

func (p *PersonLookup) repoRoot(dir string) string {
	var walked []string
	root := dir
	for d := dir; ; d = filepath.Dir(d) {
		if known, ok := p.repoOf[d]; ok {
			root = known
			break
		}
		walked = append(walked, d)
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			root = d
			break
		}
		if parent := filepath.Dir(d); parent == d {
			break
		}
	}
	for _, d := range walked {
		p.repoOf[d] = root
	}
	return root
}

// PersonAt returns felt.person for the repository that holds, or will hold,
// the fiber file at file. The nearest existing ancestor is resolved through
// symlinks first, so a fiber reached through a mount answers to the mounted
// repository's config.
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
	return NewPersonLookup().For(dir)
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
