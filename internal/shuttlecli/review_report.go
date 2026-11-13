package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// requireReviewReport refuses a worker's own close or ask when it would reach
// the human and the constitution's companion page (felt.CompanionNames:
// tapestry.html, artifact.html or report.html) has not been written since
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
	page := felt.CompanionPath(filepath.Dir(f.Path))
	if info, err := os.Stat(page); page != "" && err == nil && !info.ModTime().Before(dispatched) {
		return nil
	}
	if page == "" {
		page = filepath.Join(filepath.Dir(f.Path), felt.CompanionNames[0])
	}
	return fmt.Errorf("%s goes to the human, whose report is out of date.\n"+
		"Rewrite %s so it describes the whole constitution as it stands, then run this again.\n"+
		"Nothing here needs review? Use 'shuttle rest'.", f.ID, page)
}

// requireThreadsReviewed refuses a worker's own close for review while a
// thread beneath its constitution waits on the worker's review: closed,
// without a verdict, and not marked for the human. The orchestrator settles
// each before it leaves, so none is left with no one to review it.
func (a *app) requireThreadsReviewed(f *felt.Felt) error {
	if !a.isOwnFiber(f) && !a.dispatchedHere(f) {
		return nil
	}
	// Descendants are read from the store that holds the fiber, as
	// requireReviewReport reads ancestry.
	f, err := a.workerFiberAtPath(f.Path, f.UID)
	if err != nil {
		return err
	}
	st := felt.NewStorage(workerStoreRoot(f.Path))
	fibers, err := st.ListMetadataHavingFrontmatterFields([]string{shuttle.FacetKey})
	if err != nil {
		return err
	}
	var pending []string
	for _, below := range fibers {
		if !strings.HasPrefix(below.ID, f.ID+"/") || below.Status != felt.StatusClosed || shuttle.Verdict(below) != "" {
			continue
		}
		if block, ok, err := shuttle.BlockOf(below); err == nil && ok && block.ThreadParent != nil && block.Review == nil {
			pending = append(pending, below.ID)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	slices.Sort(pending)
	return fmt.Errorf("%s has threads waiting on your review:\n  %s\n"+
		"Read each against its Desired State, then temper it (shuttle close <thread> --tempered=true), "+
		"discard it (shuttle close <thread> --tempered=false) or mark it for the human "+
		"(shuttle close <thread> --review \"<why>\"); then close again.",
		f.ID, strings.Join(pending, "\n  "))
}

// dispatchedHere reports the daemon's launch path for this process. It covers a
// native session whose ledger binding has not landed yet.
func (a *app) dispatchedHere(f *felt.Felt) bool {
	path := a.env.Getenv("SHUTTLE_FIBER_PATH")
	return path != "" && a.samePath(path, f.Path)
}
