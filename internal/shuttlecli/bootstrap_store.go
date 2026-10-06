package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
)

// A missing registry gets an existing project store or a home-directory store.
// An operator-authored registry, including an empty one, always wins.
func (a *app) bootstrapSupervisorStore(options supervisorOptions, cwd string) error {
	if options.Stores != "" {
		return nil
	}
	if _, err := os.Lstat(options.StoresFile); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	root, err := a.nearestBootstrapStore(cwd)
	if err != nil {
		home, homeErr := a.env.UserHomeDir()
		if homeErr != nil {
			return homeErr
		}
		root = filepath.Join(home, "felt")
		if err := felt.NewStorage(root).Init(); err != nil {
			return fmt.Errorf("initializing default felt store: %w", err)
		}
	}
	payload, err := json.MarshalIndent(map[string]any{"version": 1, "felt_stores": []string{root}}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(options.StoresFile), 0755); err != nil {
		return err
	}
	// Publish a complete registry without replacing concurrent operator setup.
	file, err := os.CreateTemp(filepath.Dir(options.StoresFile), ".stores-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(append(payload, '\n'))
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Link(file.Name(), options.StoresFile); errors.Is(err, os.ErrExist) {
		return nil
	} else if err != nil {
		return err
	}
	fmt.Fprintf(a.env.Stderr, "Registered felt store: %s\n", root)
	return nil
}

func (a *app) nearestBootstrapStore(cwd string) (string, error) {
	dir, err := a.env.Abs(cwd)
	if err != nil {
		return "", err
	}
	for {
		if root, err := felt.ProjectRoot(a.env, dir); err == nil {
			return root, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no project felt store")
		}
		dir = parent
	}
}

func (a *app) supervisorBootstrapDirectory() (string, error) {
	if a.dir != "" {
		return felt.ProjectRoot(a.env, a.dir)
	}
	return a.env.Getwd()
}
