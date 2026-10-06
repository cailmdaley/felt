package shuttlecli

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"syscall"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// The single-fiber address verbs — session-name and attach. Both resolve a fiber
// to its canonical id + intrinsic uid (shuttleAddressFiber) and derive the
// worker's tmux session name.

// addressFiberLookup keeps exact matches, rejected guesses and ambiguous slugs
// separate so a caller never turns a storage hint into a recipient choice.
type addressFiberLookup struct {
	Fibers    []*felt.Felt
	Guesses   []guessedAddressFiber
	Ambiguous []ambiguousAddressFiber
}

// ambiguousAddressFiber is a slug naming several fibers in one store.
type ambiguousAddressFiber struct {
	Candidates []string
	Store      string
}

// refused reports whether the lookup found anything a caller must not choose
// from: a guess or an ambiguous slug.
func (lookup addressFiberLookup) refused() bool {
	return len(lookup.Guesses) > 0 || len(lookup.Ambiguous) > 0
}

// candidateCount counts every fiber the query could name.
func (lookup addressFiberLookup) candidateCount() int {
	n := len(lookup.Fibers) + len(lookup.Guesses)
	for _, ambiguous := range lookup.Ambiguous {
		n += len(ambiguous.Candidates)
	}
	return n
}

type guessedAddressFiber struct {
	Guess *felt.GuessError
	Store string
}

// lookupShuttleAddressFibers searches every configured store without prefix,
// tail, or last-segment guessing. Physical copies reached through views collapse
// by their symlink-resolved path; distinct files remain distinct candidates.
func (a *app) lookupShuttleAddressFibers(query string) (addressFiberLookup, error) {
	stores, err := a.shuttleStores()
	if err != nil {
		return addressFiberLookup{}, err
	}
	lookup := addressFiberLookup{}
	seen := map[string]bool{}
	for _, store := range stores {
		f, err := felt.NewStorage(store).FindMetadataWithoutGuessing("", query)
		if err == nil {
			key := f.Path
			if key == "" {
				key = store + "\x00" + f.ID
			}
			if !seen[key] {
				seen[key] = true
				lookup.Fibers = append(lookup.Fibers, f)
			}
			continue
		}
		var ambiguous *felt.AmbiguousFiberError
		if errors.As(err, &ambiguous) {
			lookup.Ambiguous = append(lookup.Ambiguous, ambiguousAddressFiber{Candidates: ambiguous.Candidates, Store: store})
			continue
		}
		var guess *felt.GuessError
		if errors.As(err, &guess) {
			lookup.Guesses = append(lookup.Guesses, guessedAddressFiber{Guess: guess, Store: store})
			continue
		}
		var missing *felt.NoFiberMatchError
		if errors.As(err, &missing) {
			continue
		}
		return lookup, fmt.Errorf("resolving fiber %q in store %s: %w", query, store, err)
	}
	return lookup, nil
}

func (lookup addressFiberLookup) candidateLabels() []string {
	labels := make([]string, 0, lookup.candidateCount())
	for _, f := range lookup.Fibers {
		label := f.ID
		if f.Path != "" {
			label += " (" + f.Path + ")"
		}
		labels = append(labels, label)
	}
	for _, candidate := range lookup.Guesses {
		label := candidate.Guess.Guess
		where := candidate.Guess.Root
		if where == "" {
			where = candidate.Store
		}
		if where != "" {
			label += " (guessed in " + where + ")"
		}
		labels = append(labels, label)
	}
	for _, ambiguous := range lookup.Ambiguous {
		for _, id := range ambiguous.Candidates {
			labels = append(labels, id+" (in "+ambiguous.Store+")")
		}
	}
	sort.Strings(labels)
	return labels
}

// shuttleAddressFiber resolves a unique exact fiber from anywhere. Addressing a
// worker cannot safely inherit the read commands' prefix and tail completion.
func (a *app) shuttleAddressFiber(query string) (*felt.Felt, error) {
	lookup, err := a.lookupShuttleAddressFibers(query)
	if err != nil {
		return nil, err
	}
	if len(lookup.Fibers) == 1 && !lookup.refused() {
		return lookup.Fibers[0], nil
	}
	if len(lookup.Fibers) > 1 || lookup.refused() {
		return nil, fmt.Errorf("fiber target %q is ambiguous or only resolves by guessing; candidates: %s", query, strings.Join(lookup.candidateLabels(), ", "))
	}
	return nil, fmt.Errorf("no fiber found matching %q", query)
}

func (a *app) sessionNameCmd() *cobra.Command {
	sessionNameCmd := &cobra.Command{
		Use:   "session-name <fiber>",
		Short: "Print the canonical tmux session name for a fiber",
		Long: `Resolves the fiber and prints the tmux session name shuttle uses for its
worker: <leaf>-<uid>-shuttle, keyed by the fiber's intrinsic id. A fiber
without an id has no session name and the command fails. It searches the
-C / --store when set, otherwise every configured store, so it
works from any directory.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := a.shuttleAddressFiber(args[0])
			if err != nil {
				return err
			}
			session := shuttleTmuxSessionName(f.ID, f.UID)
			if session == "" {
				return errFiberWithoutUID(f.ID)
			}
			if a.json {
				// Emit the dispatch-canonical id (matches the daemon);
				// the session name itself is leaf+uid keyed, so prefix-independent.
				id := f.ID
				if canonical, err := a.canonicalFiberID(f.Path); err == nil && canonical != "" {
					id = canonical
				}
				return a.outputJSON(map[string]string{"fiber_id": id, "session": session})
			}
			fmt.Fprintln(a.env.Stdout, session)
			return nil
		},
	}
	return sessionNameCmd
}

func (a *app) attachCmd() *cobra.Command {
	attachCmd := &cobra.Command{
		Use:   "attach <fiber>",
		Short: "Attach to a running worker's tmux session",
		Long: `Resolves the fiber to its worker's tmux session name and execs
'tmux attach'. Resolves the fiber from any directory, like session-name.
Exits with a clear error if no session is live.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := a.shuttleAddressFiber(args[0])
			if err != nil {
				return err
			}

			want := shuttleTmuxSessionName(f.ID, f.UID)
			if want == "" {
				return errFiberWithoutUID(f.ID)
			}
			session, _ := a.liveWorkerSession(f)
			if session == "" {
				return fmt.Errorf("no tmux session %q — fiber %s has no live worker\n(run 'shuttle ps' to list active workers)", want, args[0])
			}

			tmux, err := a.env.LookPath("tmux")
			if err != nil {
				return fmt.Errorf("tmux not found: %w", err)
			}
			// Replace this process with tmux attach.
			return syscall.Exec(tmux, []string{"tmux", "attach", "-t", session}, a.env.Environ())
		},
	}
	return attachCmd
}
