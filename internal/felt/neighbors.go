package felt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func absentNeighborError(query string, absent map[string]int) error {
	neighbor := strings.SplitN(cleanLookupID(query), "/", 2)[0]
	if _, ok := absent[neighbor]; ok {
		return fmt.Errorf("neighbor %q is not mounted: %s", neighbor, query)
	}
	return nil
}

// AbsentNeighbors returns the root fiber's declared neighbors that cannot be
// reached through an enclosing store. Each count starts at zero for check.
func (s *Storage) AbsentNeighbors() (map[string]int, error) {
	_, absent, err := s.neighborState()
	return absent, err
}

func (s *Storage) neighborState() (string, map[string]int, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return "", nil, err
	}
	var roots []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), FileExt) {
			roots = append(roots, strings.TrimSuffix(entry.Name(), FileExt))
		}
	}
	absent := map[string]int{}
	if len(roots) != 1 {
		return "", absent, nil
	}
	rootID := roots[0]
	f, err := s.readPathWithMode(filepath.Join(s.root, rootID+FileExt), rootID, ParseMetadataOnly)
	if err != nil {
		// CheckParseability reports an unreadable root; it cannot declare neighbors.
		return rootID, absent, nil
	}
	var neighbors []string
	if node := f.ExtraFields["neighbors"]; node != nil {
		if node.Kind == yaml.ScalarNode {
			var neighbor string
			err = node.Decode(&neighbor)
			if neighbor != "" {
				neighbors = []string{neighbor}
			}
		} else {
			err = node.Decode(&neighbors)
		}
		if err != nil {
			return rootID, nil, fmt.Errorf("%s neighbors: %w", rootID, err)
		}
	}
	outer, _, mounted := s.EnclosingStore()
	for _, neighbor := range neighbors {
		reachable := false
		if mounted {
			for _, p := range []string{neighbor, neighbor + FileExt} {
				if _, err := os.Stat(filepath.Join(outer, p)); err == nil {
					reachable = true
				}
			}
		}
		if !reachable {
			absent[neighbor] = 0
		}
	}
	return rootID, absent, nil
}
