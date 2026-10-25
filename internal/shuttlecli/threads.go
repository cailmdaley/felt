package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/cailmdaley/felt/internal/felt"
)

// threadStates is the roster's group order; Archived is drawn only under --all.
var threadStates = []string{"Waiting", "To review", "Working", "Armed", "Draft", "Resting", "Archived"}

// ThreadNode is one thread as the daemon's GET /api/v1/threads/*id serves it
// (Shuttle.Threads.tree/4): its board column, its roster state and its own
// threads to every depth. HostUnreachable marks an Armed thread whose host the
// daemon's fleet view cannot currently see. BlockedOn is what a resting thread
// waits for (a fiber uid or text) and Until the name it reads as.
type ThreadNode struct {
	ID              string       `json:"id"`
	UID             string       `json:"uid,omitempty"`
	Name            string       `json:"name,omitempty"`
	Host            string       `json:"host,omitempty"`
	Column          string       `json:"column"`
	State           string       `json:"state"`
	HostUnreachable bool         `json:"host_unreachable,omitempty"`
	Outcome         string       `json:"outcome,omitempty"`
	BlockedOn       string       `json:"blocked_on,omitempty"`
	Until           string       `json:"until,omitempty"`
	PendingResults  int          `json:"pending_results,omitempty"`
	Threads         []ThreadNode `json:"threads"`
}

// threadTree is the endpoint's response: the orchestrator and its threads.
// PendingResults counts what waits in the orchestrator's own mailbox while it
// has no live worker.
type threadTree struct {
	FiberID        string       `json:"fiber_id"`
	UID            string       `json:"uid,omitempty"`
	Name           string       `json:"name,omitempty"`
	FeltStore      string       `json:"felt_store,omitempty"`
	PendingResults int          `json:"pending_results,omitempty"`
	Threads        []ThreadNode `json:"threads"`
}

// threadRow is one thread in `shuttle threads --json`: the node with the count
// of unfinished threads below it, the count of thread results and messages
// waiting for its next worker (zero while one is live), and those threads
// themselves under --all.
type threadRow struct {
	ID              string      `json:"id"`
	UID             string      `json:"uid,omitempty"`
	Name            string      `json:"name,omitempty"`
	Host            string      `json:"host,omitempty"`
	Column          string      `json:"column"`
	State           string      `json:"state"`
	HostUnreachable bool        `json:"host_unreachable,omitempty"`
	Outcome         string      `json:"outcome,omitempty"`
	BlockedOn       string      `json:"blocked_on,omitempty"`
	Until           string      `json:"until,omitempty"`
	Unfinished      int         `json:"unfinished"`
	PendingResults  int         `json:"pending_results"`
	Threads         []threadRow `json:"threads,omitempty"`
}

func (a *app) threadsCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "threads <fiber>",
		Short: "A constitution's threads, grouped by state",
		Long: `Lists the threads of a constitution: the constitutions nested under it, as
the orchestrator's launch prompt and the board's thread rail see them. Direct
threads are grouped Waiting, To review, Working, Armed, Draft, Resting; each row gives
the thread's id, state, name and the first sentence of its outcome, and the
number of unfinished threads below it. A thread resting until something
(shuttle rest --until) reads "⏸ until <name>". Archived threads (a tempered or
discarded verdict) are a count.

--all adds the archived threads as their own group and every deeper level,
indented under its orchestrator in containment order.

The roster comes from this host's daemon (GET /api/v1/threads/<id>), which
classifies threads by the board's rules over its cached constitutions. A
thread is Working when its worker runs on this host or on a remote the daemon
polls fresh, and Armed when it is active with no worker running; "Armed · host
unreachable" means the daemon cannot currently see its host, so whether a
worker runs there is unknown. "N waiting for its next worker" counts the
thread results and messages queued for a constitution with no live worker,
on the orchestrator's header line and on each thread this host owns; arming
it releases them. --json prints the orchestrator and its rows, each with its
board column and pending_results.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tree, err := a.fetchThreads(a.threadsQuery(args[0]))
			if err != nil {
				return err
			}
			if root, err := felt.ProjectRoot(a.env, a.dir); err == nil {
				nameBlockers(felt.NewStorage(root), tree.Threads)
			}
			rows, archived := threadRows(tree.Threads, all)
			if a.json {
				return a.outputJSON(map[string]any{
					"fiber_id":        tree.FiberID,
					"uid":             tree.UID,
					"name":            tree.Name,
					"pending_results": tree.PendingResults,
					"threads":         rows,
					"archived":        archived,
				})
			}
			a.printThreads(tree, rows, archived, all)
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "Also list archived threads and every deeper level")
	return cmd
}

// threadsQuery names the constitution to the daemon by its uid when the local
// store resolves it (felt's own resolution, partial ids included), else as given.
func (a *app) threadsQuery(query string) string {
	if f, _, err := a.shuttleResolveFiber(query, false); err == nil {
		if f.UID != "" {
			return f.UID
		}
		if canonical, err := a.canonicalFiberID(f.Path); err == nil && canonical != "" {
			return canonical
		}
		return f.ID
	}
	return query
}

func (a *app) fetchThreads(id string) (*threadTree, error) {
	segments := strings.Split(id, "/")
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/threads/" + strings.Join(segments, "/"))
	if err != nil {
		return nil, err
	}
	tree, err := getDaemonJSON[threadTree](a, endpoint, "parsing daemon threads response")
	var status daemonStatusError
	switch {
	case errors.As(err, &status) && status.status == http.StatusNotFound:
		var body struct {
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(status.body), &body) == nil && body.Error == "not_found" {
			return nil, fmt.Errorf("no constitution %s in this host's daemon cache", id)
		}
		return nil, fmt.Errorf("this host's daemon serves no thread roster; restart it on a build that has `shuttle threads` (%w)", err)
	case errors.As(err, &status) && status.status == http.StatusServiceUnavailable:
		return nil, fmt.Errorf("the daemon cannot list threads yet (%s); retry after its first poll", status.body)
	case isLifecycleTransportError(err):
		return nil, fmt.Errorf("%w (start the daemon with `make start` or set SHUTTLE_DAEMON_URL)", err)
	case err != nil:
		return nil, err
	}
	return &tree, nil
}

// threadRows orders the direct threads by state, Waiting first (the daemon
// serves each level in address order, which a stable sort keeps within a
// state), and counts the archived ones. A state this build does not name
// follows the named ones, so a newer daemon's rows are never dropped. Under
// --all the archived stay, and every row carries its own threads in
// containment order.
func threadRows(nodes []ThreadNode, all bool) ([]threadRow, int) {
	rows := make([]threadRow, 0, len(nodes))
	archived := 0
	states := append([]string(nil), threadStates...)
	for _, n := range nodes {
		if !slices.Contains(states, n.State) {
			states = append(states, n.State)
		}
	}
	for _, state := range states {
		for _, n := range nodes {
			if n.State != state {
				continue
			}
			if state == "Archived" {
				archived++
				if !all {
					continue
				}
			}
			rows = append(rows, toThreadRow(n, all))
		}
	}
	return rows, archived
}

func toThreadRow(n ThreadNode, all bool) threadRow {
	row := threadRow{ID: n.ID, UID: n.UID, Name: n.Name, Host: n.Host, Column: n.Column, State: n.State, HostUnreachable: n.HostUnreachable, Outcome: n.Outcome, BlockedOn: n.BlockedOn, Until: shuttleNonEmpty(n.Until, n.BlockedOn), Unfinished: unfinishedThreads(n.Threads), PendingResults: n.PendingResults}
	if all {
		for _, child := range n.Threads {
			row.Threads = append(row.Threads, toThreadRow(child, true))
		}
	}
	return row
}

// nameBlockers names, from this host's store, what each thread waits for when
// the daemon did not.
func nameBlockers(st *felt.Storage, nodes []ThreadNode) {
	for i := range nodes {
		if nodes[i].BlockedOn != "" && nodes[i].Until == "" {
			nodes[i].Until = blockerName(st, nodes[i].BlockedOn)
		}
		nameBlockers(st, nodes[i].Threads)
	}
}

// unfinishedThreads is the board badge's count: every non-archived thread below.
func unfinishedThreads(nodes []ThreadNode) int {
	n := 0
	for _, t := range nodes {
		if t.State != "Archived" {
			n++
		}
		n += unfinishedThreads(t.Threads)
	}
	return n
}

func (a *app) printThreads(tree *threadTree, rows []threadRow, archived int, all bool) {
	out := a.env.Stdout
	header := fmt.Sprintf("%s  %s", tree.FiberID, tree.Name)
	if tree.PendingResults > 0 {
		header += fmt.Sprintf("  (%s)", waitingLabel(tree.PendingResults))
	}
	fmt.Fprintln(out, header)
	if len(rows) == 0 && archived == 0 {
		fmt.Fprintln(out, "\nno threads")
		return
	}
	group := ""
	for _, row := range rows {
		if row.State != group {
			group = row.State
			fmt.Fprintf(out, "\n%s\n", group)
		}
		printThreadRow(a, row, 1)
	}
	if !all && archived > 0 {
		fmt.Fprintf(out, "\n(%d archived; --all to show)\n", archived)
	}
}

func printThreadRow(a *app, row threadRow, depth int) {
	line := fmt.Sprintf("%s%s  %s  %s", strings.Repeat("  ", depth), row.ID, row.stateLabel(), shuttleNonEmpty(row.Name, row.ID))
	if sentence := firstSentence(row.Outcome); sentence != "" {
		line += ": " + sentence
	}
	var counts []string
	if row.Unfinished > 0 {
		counts = append(counts, fmt.Sprintf("%d %s", row.Unfinished, plural(row.Unfinished, "thread", "threads")))
	}
	if row.PendingResults > 0 {
		counts = append(counts, waitingLabel(row.PendingResults))
	}
	if len(counts) > 0 {
		line += " (" + strings.Join(counts, "; ") + ")"
	}
	fmt.Fprintln(a.env.Stdout, line)
	for _, child := range row.Threads {
		printThreadRow(a, child, depth+2)
	}
}

// stateLabel is the row's state as the launch roster writes it
// (Shuttle.Threads.state_label/1).
func (row threadRow) stateLabel() string {
	switch {
	case row.HostUnreachable:
		return "Armed · host unreachable"
	case row.BlockedOn != "":
		return row.State + " · ⏸ until " + row.Until
	}
	return row.State
}

// waitingLabel names what waits for a fiber's next worker, as the launch
// roster writes it (Shuttle.Threads.roster/5).
func waitingLabel(n int) string {
	return fmt.Sprintf("%d waiting for its next worker", n)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

var sentenceEnd = regexp.MustCompile(`[.!?](\s|$)|\n`)

// firstSentence is an outcome's first sentence, capped at 120 characters, as
// the orchestrator's launch roster shows it.
func firstSentence(text string) string {
	text = strings.TrimSpace(text)
	if loc := sentenceEnd.FindStringIndex(text); loc != nil {
		end := loc[0]
		if text[end] != '\n' {
			end++
		}
		text = strings.TrimSpace(text[:end])
	}
	if runes := []rune(text); len(runes) > 120 {
		return string(runes[:119]) + "…"
	}
	return text
}
