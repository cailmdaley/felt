package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
)

func workerBindingKind(kind string) bool {
	return kind == "dispatch" || kind == "resume" || kind == "claim" || kind == "migrate"
}

// currentWorkerFiber resolves process identity before dispatch-time hints.
// Native identity that has no local binding never inherits its parent's pane
// or dispatch path. Without native or pane evidence an environment-only worker
// cannot detect a reassignment; the path is only a compatibility fallback.
func (a *app) currentWorkerFiber() (*felt.Felt, error) {
	if harness, id := a.harnessSessionFromEnv(); id != "" {
		host, err := a.resolveOwnHost("")
		if err != nil {
			return nil, err
		}
		row, err := currentSessionBinding(messaging.Address{Host: host, Harness: harness, ID: id}, a.localMessageLedger())
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, fmt.Errorf("native %s session %s has no local worker binding", harness, id)
		}
		return a.workerBindingFiber(*row)
	}
	session, _ := a.tmuxCurrentSession()
	if uid := fiberUIDFromTmuxSession(session); uid != "" {
		return a.workerFiberByUID(uid)
	}
	if path := a.env.Getenv("SHUTTLE_FIBER_PATH"); path != "" {
		return a.workerFiberAtPath(path, "")
	}
	return nil, fmt.Errorf("cannot identify current worker; supply an explicit fiber")
}

func currentSessionBinding(address messaging.Address, records []SessionProvenance) (*SessionProvenance, error) {
	var found *SessionProvenance
	for _, row := range records {
		if row.Host != address.Host || messaging.NormalizeHarness(row.Harness) != address.Harness || row.nativeSessionID() != address.ID || row.fiber() == "" || !workerBindingKind(row.Kind) {
			continue
		}
		if found != nil && row.At < found.At {
			continue
		}
		if found != nil && row.At == found.At && !sessionRecordBelongsToFiber(row, &felt.Felt{ID: found.fiber(), UID: found.UID}) {
			return nil, fmt.Errorf("native session %s has conflicting newest worker bindings", address.ID)
		}
		copy := row
		found = &copy
	}
	return found, nil
}

func (a *app) workerBindingFiber(row SessionProvenance) (*felt.Felt, error) {
	if row.FiberPath != "" {
		if !filepath.IsAbs(row.FiberPath) {
			return nil, fmt.Errorf("session ledger fiber_path is not absolute")
		}
		return a.workerFiberAtPath(row.FiberPath, row.UID)
	}
	if row.UID != "" {
		return a.workerFiberByUID(row.UID)
	}
	return nil, fmt.Errorf("session binding lacks a verifiable fiber UID or path")
}

func (a *app) workerFiberAtPath(path, uid string) (*felt.Felt, error) {
	path, err := a.canonicalPath(path)
	if err != nil {
		return nil, err
	}
	id, err := a.canonicalFiberID(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	f, err := felt.Parse(id, data)
	if err != nil {
		return nil, err
	}
	if f.UID == "" || (uid != "" && f.UID != uid) {
		return nil, fmt.Errorf("worker fiber UID does not match %s", path)
	}
	f.Path = path
	return f, nil
}

func workerStoreRoot(path string) string {
	for dir := filepath.Dir(path); dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		if filepath.Base(dir) == ".felt" {
			return filepath.Dir(dir)
		}
	}
	return ""
}

func (a *app) workerFiberByUID(uid string) (*felt.Felt, error) {
	stores, err := a.configuredFeltStores()
	if err != nil {
		return nil, err
	}
	if root, err := felt.ProjectRoot(a.env, a.dir); err == nil {
		stores = append(stores, root)
	}
	// A dispatch path can locate a store even when its document was renamed.
	if path := a.env.Getenv("SHUTTLE_FIBER_PATH"); path != "" {
		if abs, err := a.env.Abs(path); err == nil {
			if root := workerStoreRoot(abs); root != "" {
				stores = append(stores, root)
			}
		}
	}
	var found *felt.Felt
	for _, store := range a.normalizeFeltStores(stores) {
		f, err := felt.NewStorage(store).FindMetadataWithoutGuessing("", uid)
		if err != nil {
			continue
		}
		f, err = a.workerFiberAtPath(f.Path, uid)
		if err != nil {
			return nil, err
		}
		if found != nil && !a.samePath(found.Path, f.Path) {
			return nil, fmt.Errorf("worker UID %s exists in multiple stores", uid)
		}
		found = f
	}
	if found == nil {
		return nil, fmt.Errorf("no local fiber for worker UID %s", uid)
	}
	return found, nil
}

// implicitWorkerArgs also selects the canonical store for lifecycle writes;
// the worker's project cwd need not contain that store.
func (a *app) implicitWorkerArgs(args []string) ([]string, error) {
	if len(args) != 0 {
		return args, nil
	}
	f, err := a.currentWorkerFiber()
	if err != nil {
		return nil, err
	}
	a.dir = workerStoreRoot(f.Path)
	return []string{strings.TrimSpace(f.ID)}, nil
}
