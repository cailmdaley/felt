package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// requireReviewReport refuses a worker's own close or ask when it would reach
// the human and the constitution's tapestry.html has not been written since
// this worker was dispatched. A thread answers to its orchestrator and a
// standing run to its schedule, so neither is held; the board's verbs carry no
// worker identity, so the human is never held either.
func (a *app) requireReviewReport(f *felt.Felt) error {
	if !a.isOwnFiber(f) && !a.dispatchedHere(f) {
		return nil
	}
	f, err := a.workerFiberAtPath(f.Path, f.UID)
	if err != nil {
		return err
	}
	// A project's .felt may be a symlink into a larger store, so ancestry is
	// read from the store that holds the fiber.
	if orchestratorOf(felt.NewStorage(workerStoreRoot(f.Path)), f) != nil {
		return nil
	}
	if block, ok, err := shuttle.BlockOf(f); err != nil || !ok || block.Kind == "standing" {
		return err
	}
	dispatched := dispatchedAt(f)
	if dispatched.IsZero() {
		return nil
	}
	page := filepath.Join(filepath.Dir(f.Path), "tapestry.html")
	info, err := os.Stat(page)
	if err == nil && !info.ModTime().Before(dispatched) {
		return nil
	}
	return fmt.Errorf("%s goes to the human, whose report is out of date.\n"+
		"Rewrite %s so it describes the whole constitution as it stands, then run this again.\n"+
		"Nothing here needs review? Use 'shuttle rest'.", f.ID, page)
}

// dispatchedHere reports the daemon's launch path for this process. It covers a
// native session whose ledger binding has not landed yet.
func (a *app) dispatchedHere(f *felt.Felt) bool {
	path := a.env.Getenv("SHUTTLE_FIBER_PATH")
	return path != "" && a.samePath(path, f.Path)
}
