package shuttlecli

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// withStubbedLiveSessions is an app whose tmux server reports exactly live.
func withStubbedLiveSessions(t *testing.T, live map[string]bool) *app {
	t.Helper()
	a := testApp(t)
	a.liveTmuxSessions = func() map[string]bool { return live }
	return a
}

// seedShuttleRoleUID seeds a shuttle role with an explicit intrinsic uid (persisted
// as the frontmatter `id:` key), so tests can exercise the uid-keyed tmux names.
func seedShuttleRoleUID(t *testing.T, storage *felt.Storage, id, uid, status string, block map[string]any) {
	t.Helper()
	seedFiber(t, storage, id, uid, status, block, nil)
}

// ---- computeState (pure matrix) --------------------------------------------

func TestComputeState(t *testing.T) {
	oneshotBlock := &shuttle.Block{Kind: "oneshot"}
	standingBlock := &shuttle.Block{Kind: "standing"}
	cases := []struct {
		name    string
		block   *shuttle.Block
		status  string
		running bool
		want    string
	}{
		{"running wins", oneshotBlock, felt.StatusActive, true, "running"},
		{"active oneshot idle", oneshotBlock, felt.StatusActive, false, "idle"},
		{"active standing scheduled", standingBlock, felt.StatusActive, false, "scheduled"},
		{"open paused", oneshotBlock, felt.StatusOpen, false, "paused"},
		{"closed", oneshotBlock, felt.StatusClosed, false, "closed"},
		{"unknown falls through", oneshotBlock, "weird", false, "weird"},
		{"empty unknown", oneshotBlock, "", false, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := computeState(tc.block, tc.status, tc.running); got != tc.want {
				t.Fatalf("computeState(%q, running=%v) = %q, want %q", tc.status, tc.running, got, tc.want)
			}
		})
	}
}

// ---- status ----------------------------------------------------------------

func TestShuttleStatus_JSONRowsAndStates(t *testing.T) {
	dir, storage := newStore(t)
	// An active oneshot with a live worker, an active standing (idle/scheduled),
	// a paused (open) role, a closed role, and a pure note (no shuttle facet).
	seedShuttleRoleUID(t, storage, "proj/runner", "01KTHDNZS287ZSSG8X8V59XKW1", felt.StatusActive, oneshot())
	seedShuttleRole(t, storage, "proj/sched", felt.StatusActive, map[string]any{"kind": "standing", "agent": "claude-opus", "schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"}}, nil)
	seedShuttleRole(t, storage, "proj/paused", felt.StatusOpen, oneshot(), nil)
	seedShuttleRole(t, storage, "proj/done", felt.StatusClosed, oneshot(), nil)
	note := &felt.Felt{ID: "proj/note", Name: "note", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := storage.Write(note); err != nil {
		t.Fatalf("Write note: %v", err)
	}

	runner := mustRead(t, storage, "proj/runner")
	liveSession := shuttleTmuxSessionName(runner.ID, runner.UID)
	a := withStubbedLiveSessions(t, map[string]bool{liveSession: true})

	out, _, err := executeApp(t, a, dir, "status", "--json")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode rows: %v\n%s", err, out)
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 shuttle rows (note excluded), got %d: %+v", len(rows), rows)
	}
	byID := map[string]FiberStatus{}
	for _, r := range rows {
		byID[r.FiberID] = r
	}
	if r := byID["proj/note"]; r.FiberID != "" {
		t.Fatalf("pure note must not appear: %+v", r)
	}
	if r := byID["proj/runner"]; !r.Running || r.State != "running" {
		t.Fatalf("runner should be running: %+v", r)
	}
	if r := byID["proj/sched"]; r.State != "scheduled" || r.Running {
		t.Fatalf("standing should be scheduled+idle: %+v", r)
	}
	if r := byID["proj/paused"]; r.State != "paused" {
		t.Fatalf("open role should be paused: %+v", r)
	}
	if r := byID["proj/done"]; r.State != "closed" {
		t.Fatalf("closed role should be closed: %+v", r)
	}
}

func TestShuttleStatus_TableRendersAndExcludesNotes(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	a := withStubbedLiveSessions(t, map[string]bool{})

	out, _, err := executeApp(t, a, dir, "status")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	if !strings.Contains(out, "task") || !strings.Contains(out, "FIBER") {
		t.Fatalf("table should list the role under a header:\n%s", out)
	}
	if !strings.Contains(out, "idle") {
		t.Fatalf("active oneshot with no worker should read idle:\n%s", out)
	}
}

// The table hides closed rows by default and says so; --closed restores them;
// the JSON arm is never filtered.
func TestShuttleStatus_TableHidesClosedByDefault(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "live", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, storage, "done", felt.StatusClosed, oneshot(), nil)
	a := withStubbedLiveSessions(t, map[string]bool{})

	out, _, err := executeApp(t, a, dir, "status")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	if strings.Contains(out, "done") || !strings.Contains(out, "(1 closed hidden; --closed to show)") {
		t.Fatalf("closed row should be hidden and counted:\n%s", out)
	}

	out, err = runCommand(t, dir, "status", "--closed")
	if err != nil {
		t.Fatalf("status --closed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "done") || strings.Contains(out, "closed hidden") {
		t.Fatalf("--closed should list the closed row without a trailer:\n%s", out)
	}

	out, err = runCommand(t, dir, "status", "--json")
	if err != nil {
		t.Fatalf("status --json: %v\n%s", err, out)
	}
	if !strings.Contains(out, "\"done\"") {
		t.Fatalf("json should always carry closed rows:\n%s", out)
	}
}

func TestShuttleStatus_IncludeOrphans(t *testing.T) {
	dir, _ := newStore(t)
	// A live shuttle session that maps to no shuttle: facet in the store.
	a := withStubbedLiveSessions(t, map[string]bool{"ghost-01KTHDNZS287ZSSG8X8V59XKW9-shuttle": true})

	out, _, err := executeApp(t, a, dir, "status", "--include-orphans", "--json")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	found := false
	for _, r := range rows {
		if r.FiberID == "ghost-01KTHDNZS287ZSSG8X8V59XKW9-shuttle" && r.Running {
			found = true
		}
	}
	if !found {
		t.Fatalf("orphan session should surface with --include-orphans: %+v", rows)
	}
}

// ---- ps --------------------------------------------------------------------

func TestShuttlePs_AttributesOwner(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRoleUID(t, storage, "proj/worker", "01KTHDNZS287ZSSG8X8V59XKW2", felt.StatusActive, oneshot())
	f := mustRead(t, storage, "proj/worker")
	session := shuttleTmuxSessionName(f.ID, f.UID)
	a := withStubbedLiveSessions(t, map[string]bool{session: true})

	out, _, err := executeApp(t, a, dir, "ps", "--json")
	if err != nil {
		t.Fatalf("ps: %v\n%s", err, out)
	}
	var rows []map[string]string
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(rows) != 1 || rows[0]["session"] != session || rows[0]["fiber_id"] != "proj/worker" {
		t.Fatalf("ps should attribute %q to proj/worker: %+v", session, rows)
	}
}

func TestShuttlePs_Empty(t *testing.T) {
	dir, _ := newStore(t)
	a := withStubbedLiveSessions(t, map[string]bool{})

	out, _, err := executeApp(t, a, dir, "ps")
	if err != nil {
		t.Fatalf("ps: %v\n%s", err, out)
	}
	if !strings.Contains(out, "no live shuttle workers") {
		t.Fatalf("empty ps should say so:\n%s", out)
	}
}

// ---- session-name ----------------------------------------------------------

func TestShuttleSessionName(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRoleUID(t, storage, "proj/task", "01KTHDNZS287ZSSG8X8V59XKW3", felt.StatusActive, oneshot())
	f := mustRead(t, storage, "proj/task")
	want := shuttleTmuxSessionName(f.ID, f.UID)

	out, err := runCommand(t, dir, "session-name", "proj/task")
	if err != nil {
		t.Fatalf("session-name: %v\n%s", err, out)
	}
	if strings.TrimSpace(out) != want {
		t.Fatalf("session-name = %q, want %q", strings.TrimSpace(out), want)
	}
	if !strings.Contains(want, "01KTHDNZS287ZSSG8X8V59XKW3") {
		t.Fatalf("uid-keyed name expected, got %q", want)
	}
}

// stripFiberID rewrites a seeded fiber's file without its `id:` line, bypassing
// storage (whose writes stamp one) — the shape of a hand-made fiber file.
func stripFiberID(t *testing.T, storage *felt.Storage, id string) {
	t.Helper()
	path := storage.Path(id)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "id:") {
			kept = append(kept, line)
		}
	}
	if err := os.WriteFile(path, []byte(strings.Join(kept, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, storage, id).UID != "" {
		t.Fatalf("fixture %s still carries an id", id)
	}
}

// A fiber without an intrinsic id has no worker session name: the addressing
// verbs say so and name the fix, and the single-fiber report says the daemon
// refuses it.
func TestShuttleFiberWithoutUID_HasNoSessionName(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	stripFiberID(t, storage, "task")
	withStubbedTmux(t, map[string]bool{"task-shuttle": true})

	for _, verb := range []string{"session-name", "attach"} {
		out, err := runCommand(t, dir, verb, "task")
		if err == nil {
			t.Fatalf("%s should refuse a fiber without an id:\n%s", verb, out)
		}
		if !strings.Contains(err.Error(), "felt backfill-ids") {
			t.Fatalf("%s error should name the fix, got: %v", verb, err)
		}
	}

	out, err := runCommand(t, dir, "status", "task")
	if err != nil {
		t.Fatalf("status task: %v\n%s", err, out)
	}
	if !strings.Contains(out, "no intrinsic id") || strings.Contains(out, "running (tmux") {
		t.Fatalf("status should report the missing id and no worker:\n%s", out)
	}
}

// ---- attach (error branch; the exec path can't be unit-tested) --------------

func TestShuttleAttach_NoLiveSession(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	withStubbedTmux(t, map[string]bool{}) // nothing live

	out, err := runCommand(t, dir, "attach", "task")
	if err == nil {
		t.Fatalf("attach should error when no session is live:\n%s", out)
	}
	if !strings.Contains(err.Error(), "no live worker") {
		t.Fatalf("error should explain no live worker, got: %v", err)
	}
}

// ---- cross-store dedup ------------------------------------------------------

func TestListShuttleFibersAcrossStores_DedupsByUID(t *testing.T) {
	dirA, storageA := newStore(t)
	dirB, storageB := newStore(t)
	// Same fiber reachable from two stores (same intrinsic uid, different slug) —
	// the aggregate-plus-project-canonical case. Must collapse to one.
	seedShuttleRoleUID(t, storageA, "ai-futures/shared", "01SHAREDUID0000000000000001", felt.StatusActive, oneshot())
	seedShuttleRoleUID(t, storageB, "shared", "01SHAREDUID0000000000000001", felt.StatusActive, oneshot())
	// A distinct fiber only in store B.
	seedShuttleRoleUID(t, storageB, "only-b", "01ONLYBUID00000000000000001", felt.StatusActive, oneshot())

	entries, err := testApp(t).listShuttleFibersAcrossStores([]string{dirA, dirB})
	if err != nil {
		t.Fatalf("listShuttleFibersAcrossStores: %v", err)
	}
	uids := map[string]bool{}
	for _, e := range entries {
		uids[e.UID] = true
	}
	if len(entries) != 2 {
		t.Fatalf("want 2 entries after uid dedup, got %d: %+v", len(entries), entries)
	}
	if !uids["01SHAREDUID0000000000000001"] || !uids["01ONLYBUID00000000000000001"] {
		t.Fatalf("both distinct uids should survive: %+v", entries)
	}
}

// ---- store resolution ------------------------------------------------------

func TestShuttleStores_Precedence(t *testing.T) {
	// changeDir wins: an explicit -C / --store scopes to that single store.
	dir, _ := newStore(t)
	a := testApp(t)
	a.dir = dir
	got, err := a.shuttleStores()
	if err != nil || len(got) != 1 || got[0] != dir {
		t.Fatalf("with -C, shuttleStores = %v (%v), want [%s]", got, err, dir)
	}

	// No -C: SHUTTLE_STORES wins over the registry file.
	t.Setenv("SHUTTLE_STORES", "/store/a,/store/b,/store/a")
	t.Setenv("SHUTTLE_STORES_FILE", "/nonexistent/should/be/ignored.json")
	got, err = testApp(t).shuttleStores()
	if err != nil {
		t.Fatalf("shuttleStores: %v", err)
	}
	if len(got) != 2 || got[0] != "/store/a" || got[1] != "/store/b" {
		t.Fatalf("SHUTTLE_STORES should win, deduped+ordered: got %v", got)
	}

	// No SHUTTLE_STORES: the registry file is consulted.
	t.Setenv("SHUTTLE_STORES", "")
	regPath := dir + "/felt_stores.json"
	if err := os.WriteFile(regPath, []byte(`{"version":1,"felt_stores":["/reg/x","/reg/y"]}`), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	t.Setenv("SHUTTLE_STORES_FILE", regPath)
	got, err = testApp(t).shuttleStores()
	if err != nil {
		t.Fatalf("shuttleStores: %v", err)
	}
	if len(got) != 2 || got[0] != "/reg/x" || got[1] != "/reg/y" {
		t.Fatalf("registry should be consulted: got %v", got)
	}
}

// TestShuttleAddressFiber_FromAnywhere locks in the cwd-insensitive resolution
// the address verbs need: with no -C, they resolve against the configured stores
// (here SHUTTLE_STORES), by leaf and by full id, regardless of cwd — matching
// the configured-store lookup rather than an implicit project-root lookup.
func TestShuttleAddressFiber_FromAnywhere(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRoleUID(t, storage, "proj/deep/task", "01ADDRUID000000000000000001", felt.StatusActive, oneshot())

	// No -C: resolution falls through to the configured stores.
	t.Setenv("SHUTTLE_STORES", dir)

	for _, q := range []string{"task", "proj/deep/task"} {
		f, err := testApp(t).shuttleAddressFiber(q)
		if err != nil {
			t.Fatalf("shuttleAddressFiber(%q): %v", q, err)
		}
		if f.ID != "proj/deep/task" {
			t.Fatalf("shuttleAddressFiber(%q) = %q, want proj/deep/task", q, f.ID)
		}
		if f.UID != "01ADDRUID000000000000000001" {
			t.Fatalf("resolved fiber lost its uid: %q", f.UID)
		}
	}

	if _, err := testApp(t).shuttleAddressFiber("no-such-fiber"); err == nil {
		t.Fatal("expected an error for an unresolvable query")
	}
}

// TestCanonicalFiberID_SubstoreSymlink locks in the verification fix: a fiber in
// a symlinked substore must report its NEAREST-.felt (dispatch-canonical) id, not
// the outer-aggregate id felt's walk assigns — so a status fiber_id matches the
// daemon (which polls the project store directly) and round-trips into a write
// verb. Mirrors the live aggregate .felt/<x>/lightcone -> project-store topology.
func TestCanonicalFiberID_SubstoreSymlink(t *testing.T) {
	root := t.TempDir()
	// Outer aggregate store.
	outer := felt.NewStorage(root)
	if err := outer.Init(); err != nil {
		t.Fatalf("init outer: %v", err)
	}
	// A separate project store with its own .felt and a shuttle role inside.
	projParent := t.TempDir()
	proj := felt.NewStorage(projParent)
	if err := proj.Init(); err != nil {
		t.Fatalf("init proj: %v", err)
	}
	seedShuttleRoleUID(t, proj, "tooling/the-task", "01SUBSTOREUID00000000000001", felt.StatusActive, oneshot())

	// Mount the project's .felt as a symlinked substore under the aggregate, the
	// way the aggregate store mounts a project store.
	linkParent := root + "/.felt/projx"
	if err := os.MkdirAll(linkParent, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(projParent+"/.felt", linkParent+"/sub"); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	entries, err := testApp(t).listShuttleFibers(root)
	if err != nil {
		t.Fatalf("listShuttleFibers: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 entry through the symlinked substore, got %d: %+v", len(entries), entries)
	}
	// The canonical id is relative to the project store's .felt (tooling/the-task),
	// NOT the outer-aggregate path (projx/sub/tooling/the-task).
	if entries[0].FiberID != "tooling/the-task" {
		t.Fatalf("FiberID = %q, want dispatch-canonical %q", entries[0].FiberID, "tooling/the-task")
	}
}

func TestListShuttleFibers_SkipsNotesAndMalformed(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "good", felt.StatusActive, oneshot(), nil)
	// A pure note (no shuttle facet).
	note := &felt.Felt{ID: "note", Name: "note", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := storage.Write(note); err != nil {
		t.Fatalf("Write note: %v", err)
	}
	// A degenerate shuttle: value (scalar, not a mapping) — round-tripped opaquely,
	// never treated as a dispatch facet.
	bad := &felt.Felt{ID: "bad", Name: "bad", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := bad.SetExtraField("shuttle", "not-a-mapping"); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(bad); err != nil {
		t.Fatalf("Write bad: %v", err)
	}

	entries, err := testApp(t).listShuttleFibers(dir)
	if err != nil {
		t.Fatalf("listShuttleFibers: %v", err)
	}
	if len(entries) != 1 || entries[0].FiberID != "good" {
		t.Fatalf("only the well-formed role should list: %+v", entries)
	}
}

// ---- single-fiber report ---------------------------------------------------

// TestShuttleStatus_SingleFiber is the home the deleted install-idempotent
// report moved into: `shuttle status <fiber>` answers "what is this role,
// and will the daemon dispatch it" for one fiber, and exits 0 either way — an
// armed role and a closed one are both legitimate answers, not errors.
func TestShuttleStatus_SingleFiber(t *testing.T) {
	pdir := t.TempDir()
	for _, tc := range []struct {
		name         string
		status       string
		own          string // this machine's host id; the block's is testhost
		noProjectDir bool
		want         []string
	}{
		{
			name:   "armed",
			status: felt.StatusActive,
			own:    "testhost",
			want: []string{
				"kind:        standing", "host:        testhost", "agent:       claude-opus",
				pdir, `schedule:    "0 8 * * *" tz=UTC`, "status:      active (armed)",
				"→ Armed; eligible for dispatch on this host (testhost)", "boot quarantine",
			},
		},
		{
			// Status alone does not dispatch: another host's daemon owns it.
			name:   "armed, owned elsewhere",
			status: felt.StatusActive,
			own:    "laptop",
			want:   []string{"→ Armed; owned by host testhost", "not this one (laptop)"},
		},
		{
			name:         "armed, no project_dir",
			status:       felt.StatusActive,
			own:          "testhost",
			noProjectDir: true,
			want:         []string{"→ Armed; eligible for dispatch on this host", "no project_dir, so its worker starts in the felt store", "shuttle resume role --project-dir <dir>"},
		},
		{
			name:         "closed, no project_dir",
			status:       felt.StatusClosed,
			own:          "testhost",
			noProjectDir: true,
			want:         []string{"→ Fiber is closed", "shuttle reopen role --project-dir <dir>"},
		},
		{
			name:   "closed",
			status: felt.StatusClosed,
			own:    "testhost",
			want: []string{
				"status:      closed (NOT armed", "→ Fiber is closed", "shuttle reopen role",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withStubbedTmux(t, nil)
			withOwnHost(t, tc.own)
			dir, storage := newStore(t)
			block := map[string]any{
				"kind": "standing", "host": "testhost", "agent": "claude-opus", "project_dir": pdir,
				"schedule": map[string]any{"expr": "0 8 * * *", "tz": "UTC"},
			}
			if tc.noProjectDir {
				delete(block, "project_dir")
			}
			seedShuttleRole(t, storage, "role", tc.status, block, nil)

			out, err := runCommand(t, dir, "status", "role")
			if err != nil {
				t.Fatalf("status <fiber> must exit 0: %v\n%s", err, out)
			}
			for _, want := range tc.want {
				if !strings.Contains(out, want) {
					t.Fatalf("report missing %q:\n%s", want, out)
				}
			}
		})
	}
}

// TestShuttleStatus_SingleFiberRejectsTableFlags: the flags that shape the
// multi-fiber walk have nothing to act on for one fiber, so combining them is an
// error rather than a silently ignored flag.
func TestShuttleStatus_SingleFiberRejectsTableFlags(t *testing.T) {
	for _, flag := range []string{"--all", "--include-orphans"} {
		t.Run(flag, func(t *testing.T) {
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "role", felt.StatusActive, oneshot(), nil)

			out, err := runCommand(t, dir, "status", "role", flag)
			if err == nil {
				t.Fatalf("status <fiber> %s must be refused; out=%s", flag, out)
			}
			if !strings.Contains(err.Error(), "status table") {
				t.Fatalf("error should explain the flag is for the table; err=%v", err)
			}
		})
	}
}

// TestShuttleStatus_SingleFiberWithoutBlock: status reports shuttle roles, so a
// plain fiber is an error that names the verbs that would make it one.
func TestShuttleStatus_SingleFiberWithoutBlock(t *testing.T) {
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "note", felt.StatusOpen)

	if _, err := runCommand(t, dir, "status", "note"); err == nil {
		t.Fatal("status on a block-less fiber must error")
	}
}
