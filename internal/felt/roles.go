package felt

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// RoleStorage is the store that holds the role charters: the enclosing
// store when s is a view of one, else s itself.
func (s *Storage) RoleStorage() *Storage {
	if external := s.ExternalRefs(); external != nil {
		return NewStorage(external.ProjectDir())
	}
	return s
}

// RoleCharters finds every office's charter in s's role store (see
// RoleStorage): the fiber at roles/<office> at its top, or at
// <mount>/roles/<office> where <mount> is a top-level entry of its .felt/ that
// links to a directory. The store's own charter wins a collision, then mounts
// in name order; the charters a winner hides are returned as shadowed. It
// reads those roles/ directories and their charters, never the rest of the
// store.
func (s *Storage) RoleCharters() (charters map[string]*Felt, shadowed []*Felt, err error) {
	st := s.RoleStorage()
	root := st.Root()
	ids, err := charterIDs(root, "")
	if err != nil {
		return nil, nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range entries {
		if entry.Type()&fs.ModeSymlink == 0 {
			continue
		}
		if info, err := os.Stat(filepath.Join(root, entry.Name())); err != nil || !info.IsDir() {
			continue
		}
		mounted, err := charterIDs(root, entry.Name()+"/")
		if err != nil {
			return nil, nil, err
		}
		ids = append(ids, mounted...)
	}
	found, err := st.ListMetadataByIDs(ids, nil, false)
	if err != nil {
		return nil, nil, err
	}
	charters = map[string]*Felt{}
	for _, f := range found {
		office := path.Base(f.ID)
		if charters[office] != nil {
			shadowed = append(shadowed, f)
			continue
		}
		charters[office] = f
	}
	return charters, shadowed, nil
}

// charterIDs lists the candidate charter ids <prefix>roles/<office> under root.
func charterIDs(root, prefix string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(prefix), RolesNamespace))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if (entry.IsDir() || entry.Type()&fs.ModeSymlink != 0) && ValidRole(entry.Name()) {
			ids = append(ids, prefix+RolesNamespace+"/"+entry.Name())
		}
	}
	return ids, nil
}

// NoCharterError names where an office's charter may live.
func NoCharterError(office string) error {
	return fmt.Errorf("role %q has no charter at roles/%s or <mount>/roles/%s", office, office, office)
}

// QualifyRole is the role to store for a fiber at file when given role: a
// bare office becomes <office>/<person> when the repository holding the fiber
// names a person; a role already naming a person, or naming that person
// alone, is kept as given.
func QualifyRole(role, file string) string {
	if strings.Contains(role, "/") {
		return role
	}
	person := PersonAt(file)
	if person == "" || person == role {
		return role
	}
	return role + "/" + person
}
