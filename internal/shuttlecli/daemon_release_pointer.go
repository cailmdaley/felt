package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/spf13/cobra"
)

func (a *app) releasePointerPath() (string, error) {
	home, err := a.env.UserHomeDir()
	return filepath.Join(home, ".shuttle", "repo"), err
}

// Selection, activation and pruning share a host-local lock. Pruning cannot
// delete a tree between another deployment's selection and its daemon cycle.
func (a *app) withReleaseLock(operation func() error) error {
	pointer, err := a.releasePointerPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(pointer), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(filepath.Dir(pointer), "release.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return operation()
}

func (a *app) writeSelectedRelease(release daemonRelease) error {
	pointer, err := a.releasePointerPath()
	if err != nil {
		return err
	}
	return atomicfile.Write(pointer, []byte(release.Dir+"\n"), 0600)
}

func (a *app) selectDaemonRelease(release daemonRelease) error {
	return a.withReleaseLock(func() error {
		validated, err := a.validateDaemonRelease(release.Dir)
		if err != nil {
			return err
		}
		return a.writeSelectedRelease(validated)
	})
}

func (a *app) daemonSelectReleaseCmd() *cobra.Command {
	return &cobra.Command{Use: "select-release <path>", Short: "Select the release supervisors boot next", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return a.selectDaemonRelease(daemonRelease{Dir: args[0]})
		}}
}

func (a *app) daemonActivateReleaseCmd() *cobra.Command {
	return &cobra.Command{Use: "activate-release <path> -- <cycle-command> [args...]", Short: "Migrate release pins, select a built release and cycle its daemon", Hidden: true, Args: cobra.MinimumNArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			commandPath, err := a.env.LookPath(args[1])
			if err != nil {
				return err
			}
			return a.withReleaseLock(func() error {
				pointer, err := a.releasePointerPath()
				if err != nil {
					return err
				}
				// A concurrent prune may have removed an unselected build while
				// activation waited. Validate only once we exclude that writer.
				release, err := a.validateDaemonRelease(args[0])
				if err != nil {
					return err
				}
				previous, readErr := os.ReadFile(pointer)
				if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
					return readErr
				}
				plans, err := a.planReleaseMigrations()
				if err != nil {
					return err
				}
				// Validate everything before changing the selection. A failed migration or
				// cycle restores both the pointer and the definitions it changed.
				rollback := func(cause error) error {
					var failures []error
					failures = append(failures, cause)
					if readErr == nil {
						failures = append(failures, atomicfile.Write(pointer, previous, 0600))
					} else if err := os.Remove(pointer); err != nil && !errors.Is(err, os.ErrNotExist) {
						failures = append(failures, err)
					}
					for _, plan := range plans {
						failures = append(failures, atomicfile.Write(plan.path, plan.original, plan.mode))
					}
					failures = append(failures, a.reloadReleaseMigrations(plans, false), a.reloadReleaseMigrations(plans, true))
					return errors.Join(failures...)
				}
				for _, plan := range plans {
					if err := atomicfile.Write(plan.path, plan.updated, plan.mode); err != nil {
						return rollback(err)
					}
				}
				if err := a.reloadReleaseMigrations(plans, false); err != nil {
					return rollback(err)
				}
				if err := a.writeSelectedRelease(release); err != nil {
					return rollback(err)
				}
				if err := a.reloadReleaseMigrations(plans, true); err != nil {
					return rollback(err)
				}
				// The callback can avoid a second restart when a loaded pin
				// migration has already cycled the selected supervisor.
				cycleEnv := a.env.Clone()
				cycleEnv.Set("SHUTTLE_ACTIVATION_CYCLED", "0")
				for _, plan := range plans {
					if plan.loaded {
						cycleEnv.Set("SHUTTLE_ACTIVATION_CYCLED", "1")
					}
				}
				command := cycleEnv.Command(commandPath, args[2:]...)
				command.Stdin, command.Stdout, command.Stderr = a.env.Stdin, a.env.Stdout, a.env.Stderr
				if err := command.Run(); err != nil {
					return rollback(fmt.Errorf("cycling selected release %s: %w", release.Dir, err))
				}
				return nil
			})
		}}
}

func canonicalReleasePath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

func releasePathWithin(root, path string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(path) {
		return false
	}
	relative, err := filepath.Rel(canonicalReleasePath(root), canonicalReleasePath(path))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (a *app) daemonPruneReleasesCmd() *cobra.Command {
	var keep []string
	command := &cobra.Command{Use: "prune-releases <checkout> <deploy-root>", Hidden: true, Args: cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			return a.withReleaseLock(func() error {
				pointer, err := a.releasePointerPath()
				if err != nil {
					return err
				}
				selected, err := os.ReadFile(pointer)
				if err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
				settings, err := a.resolveHostSettings()
				if err != nil {
					return err
				}
				body, err := a.daemonLifecycleGet(settings, "/api/v1/version", 5*time.Second)
				if err != nil {
					return fmt.Errorf("not pruning: cannot establish the running daemon's release_path: %w", err)
				}
				var receipt struct {
					ReleasePath string `json:"release_path"`
				}
				if json.Unmarshal(body, &receipt) != nil || !filepath.IsAbs(receipt.ReleasePath) {
					return errors.New("not pruning: /api/v1/version has no absolute release_path")
				}
				protected := append(append([]string{}, keep...), strings.TrimSpace(string(selected)), receipt.ReleasePath)
				packages, _ := a.env.Command("pi", "list").Output()
				// Only registered worktrees are ours to remove. Interrupted Git
				// operations can leave ordinary directories under the deploy root.
				listed, err := a.env.Command("git", "-C", args[0], "worktree", "list", "--porcelain", "-z").Output()
				if err != nil {
					return fmt.Errorf("listing deploy worktrees: %w", err)
				}
				registered := map[string]bool{}
				for _, field := range strings.Split(string(listed), "\x00") {
					if path, ok := strings.CutPrefix(field, "worktree "); ok {
						registered[canonicalReleasePath(path)] = true
					}
				}
				entries, err := os.ReadDir(args[1])
				if err != nil {
					return err
				}
				for _, entry := range entries {
					if !entry.IsDir() {
						continue
					}
					candidate := filepath.Join(args[1], entry.Name())
					if !registered[canonicalReleasePath(candidate)] {
						continue
					}
					retain := strings.Contains(string(packages), "    "+candidate)
					for _, path := range protected {
						if path != "" && releasePathWithin(candidate, path) {
							retain = true
						}
					}
					if retain {
						continue
					}
					// Lease before removal, and hold it until Git finishes. A deploy
					// takes this same lease before creating or using its worktree.
					leases := filepath.Join(filepath.Dir(pointer), "deploy", "leases")
					if err := os.MkdirAll(leases, 0700); err != nil {
						return err
					}
					lease, err := os.OpenFile(filepath.Join(leases, entry.Name()+".lock"), os.O_CREATE|os.O_RDWR, 0600)
					if err != nil {
						return err
					}
					err = syscall.Flock(int(lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
					if errors.Is(err, syscall.EWOULDBLOCK) {
						lease.Close()
						fmt.Fprintf(a.env.Stdout, "retaining leased deploy worktree %s\n", candidate)
						continue
					}
					if err != nil {
						lease.Close()
						return err
					}
					output, removeErr := a.env.Command("git", "-C", args[0], "worktree", "remove", "--force", candidate).CombinedOutput()
					lease.Close()
					if removeErr != nil {
						return fmt.Errorf("pruning %s: %w: %s", candidate, removeErr, output)
					}
				}
				return a.env.Command("git", "-C", args[0], "worktree", "prune").Run()
			})
		}}
	command.Flags().StringArrayVar(&keep, "keep", nil, "Retain this worktree as well as the selected and running releases")
	return command
}
