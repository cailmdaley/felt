---
title: 'Multi-tapestry support: discovery, aggregated views, move'
status: closed
tags:
    - spec
depends-on:
    - multi-tapestry-design-walkable
created-at: 2026-01-18T15:39:49.81082+01:00
closed-at: 2026-03-06T17:08:00.62533+01:00
outcome: Closed without implementation. The spec describes a substantial multi-tapestry expansion for felt, but this is outside the project’s current priorities and not worth pursuing now. Treat as scope creep rather than an active roadmap item. If multi-tapestry workflows become a real need later, reopen from the design fibers and reassess with fresh evidence.
---

(multi-tapestry-support)=
# Ralph Spec

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream <fiber-id>`).
   Use it for context — files touched, concepts named — but apply fresh judgment.
   Scan the spec and codebase. What's incomplete? What needs verification? What could improve?

2. **Prioritize** — Identify the single highest-value task to work on yourself.
   This is what you'll focus on in this session.

3. **Delegate** — Any routine, isolated tasks can be launched as background agents (2-3 max, different files).
   For each: create child fiber, launch with Task tool (run_in_background: true).
   Do NOT check their progress or output. They will notify you when finished.

4. **Work** — Focus on your high-value task. If agents finish while you're working, briefly note their results and continue.
   If you have nothing to work on yourself, just wait for agents to complete.

5. **Exit** — End every iteration with `kill $PPID`. The loop continues.

   **NEVER close the fiber if you made changes this iteration.**
   Made an edit? Fixed a bug? Added a test? → `kill $PPID`. That's it. Don't close.

   **Only close when you've actively checked everything and found nothing:**
   - You surveyed the full design and verified each part is implemented
   - You ran tests and they pass
   - You tried interacting with what was built and it works
   - You looked for edge cases, documentation gaps, code smells — nothing found
   - You made zero changes this iteration

   If ALL of that is true → `felt off <fiber-id> -r "summary"` then `kill $PPID`.
   If ANY of it is false → just `kill $PPID`. The loop continues.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Add multi-tapestry support to felt: walkable directories (git-like discovery), registered child tapestries, aggregated views across tapestries, and atomic connected-component moves between tapestries.

## Design

### Design Decisions (from fiber `multi-tapestry-9661749a`)

1. **No cross-tapestry dependencies** — tapestries stay self-contained
2. **Move = connected component** — atomic relocation of fiber + all connected fibers
3. **Aggregated views only** — `felt ls --all` shows multiple tapestries, but they remain separate

### Phase 1: Tapestry Discovery (Registered Children)

**Discovery model:**
- **Upward**: Auto-discovered (existing `FindProjectRoot()` — like git)
- **Children**: Explicitly registered via `felt register <path>`
- **Global**: Auto-checked at `~/loom/.felt/` (hardcoded for now)

Registry stored in `.felt/.tapestries` (simple line-delimited paths).

**New type: `TapestryLocation`**

```go
// internal/felt/discovery.go
type TapestryLocation struct {
    Root     string // e.g., /Users/x/project
    Relative string // e.g., ".", "../parent", "./child", "~/loom"
    Label    string // e.g., "project", "api", "loom"
    Source   string // "current", "parent", "registered", "global"
}
```

**New functions:**

```go
// FindAllTapestries returns tapestries visible from cwd
func FindAllTapestries() ([]TapestryLocation, error) {
    // 1. Current tapestry (FindProjectRoot)
    // 2. Registered children (from .felt/.tapestries)
    // 3. Global tapestry (~/loom/.felt/ if exists)
    // Deduplicate if same path reached multiple ways
}

// LoadRegistry reads .felt/.tapestries
func (s *Storage) LoadRegistry() ([]string, error)

// Register adds a path to .felt/.tapestries
func (s *Storage) Register(path string) error

// Unregister removes a path from .felt/.tapestries
func (s *Storage) Unregister(path string) error
```

**New commands:**

`felt tapestries` — list visible tapestries:
```
$ felt tapestries
.          /Users/cd/project           5 fibers (2 open)    [current]
./api      /Users/cd/project/api       3 fibers (1 open)    [registered]
~/loom     /Users/cd/loom             42 fibers (12 open)   [global]
```

`felt register <path>` — add a child tapestry:
```
$ felt register ./api
Registered ./api
```

`felt unregister <path>` — remove a child tapestry:
```
$ felt unregister ./api
Unregistered ./api
```

**Files:**
- New: `internal/felt/discovery.go` (~120 lines)
- New: `internal/felt/discovery_test.go` (~100 lines)
- New: `cmd/tapestries.go` (~100 lines, includes register/unregister)

### Phase 2: Aggregated Views

**`felt ls --all` / `-A`** — show fibers from all discovered tapestries, prefixed with tapestry label:

```
$ felt ls --all
[.]      ◐ implement-cache-abc   Implement cache layer
[.]      ○ review-perf-def       Review performance
[~/loom] ○ research-k8s-ghi      Research k8s patterns
```

**Hint in regular `felt ls`** — when other tapestries exist, show hint at bottom:

```
$ felt ls
◐ implement-cache-abc   Implement cache layer
○ review-perf-def       Review performance

  Also: 2 tapestries nearby (felt ls --all)
```

**Implementation:**

```go
// cmd/ls.go
var showAllTapestries bool

func init() {
    lsCmd.Flags().BoolVarP(&showAllTapestries, "all", "A", false,
        "Show fibers from all visible tapestries")
}

// In RunE:
if showAllTapestries {
    tapestries, _ := felt.FindAllTapestries()
    for _, t := range tapestries {
        storage := felt.NewStorage(t.Root)
        fibers, _ := storage.List()
        // prefix output with [t.Label]
    }
} else {
    // ... existing logic ...

    // Show hint if other tapestries exist
    tapestries, _ := felt.FindAllTapestries()
    if len(tapestries) > 1 {
        fmt.Fprintf(os.Stderr, "\n  Also: %d tapestries nearby (felt ls --all)\n",
            len(tapestries)-1)
    }
}
```

**Files:**
- Modify: `cmd/ls.go` (~50 lines added)

### Phase 3: Connected Component Extraction

**New graph methods:**

```go
// internal/felt/graph.go

// GetConnectedComponent returns all fibers transitively connected to id
func (g *Graph) GetConnectedComponent(id string) []string {
    visited := make(map[string]bool)
    g.walkConnected(id, visited)
    var result []string
    for id := range visited {
        result = append(result, id)
    }
    return result
}

func (g *Graph) walkConnected(id string, visited map[string]bool) {
    if visited[id] { return }
    visited[id] = true
    for _, up := range g.Upstream[id] { g.walkConnected(up, visited) }
    for _, down := range g.Downstream[id] { g.walkConnected(down, visited) }
}
```

**Files:**
- Modify: `internal/felt/graph.go` (~30 lines added)
- Modify: `internal/felt/graph_test.go` (~40 lines added)

### Phase 4: Move Command

**Command: `felt move <id> <target>`**

```
$ felt move cache-abc ~/loom

Moving connected component (3 fibers):
  ● design-cache-def (dependency)
  ○ implement-cache-abc (target)
  ○ cache-tests-ghi (dependent)

Target: ~/loom/.felt/

Continue? [y/n] y
Moved 3 fibers.
```

**Implementation:**

```go
// cmd/move.go

var moveCmd = &cobra.Command{
    Use:   "move <id> <target>",
    Short: "Move fiber and connected component to another tapestry",
    Args:  cobra.ExactArgs(2),
    RunE: func(cmd *cobra.Command, args []string) error {
        query, targetPath := args[0], args[1]

        // 1. Find source fiber
        srcRoot, _ := felt.FindProjectRoot()
        srcStorage := felt.NewStorage(srcRoot)
        fiber, _ := srcStorage.Find(query)

        // 2. Build graph, get connected component
        allFibers, _ := srcStorage.List()
        graph := felt.BuildGraph(allFibers)
        componentIDs := graph.GetConnectedComponent(fiber.ID)

        // 3. Resolve target tapestry
        dstRoot := resolveTargetPath(targetPath) // expand ~/loom, etc.
        dstStorage := felt.NewStorage(dstRoot)
        if !dstStorage.Exists() {
            return fmt.Errorf("target tapestry does not exist: %s", targetPath)
        }

        // 4. Check for ID collisions
        for _, id := range componentIDs {
            if _, err := dstStorage.Read(id); err == nil {
                return fmt.Errorf("fiber %s already exists in target", id)
            }
        }

        // 5. Confirm with user
        // ... show component summary ...

        // 6. Copy fibers to destination
        for _, id := range componentIDs {
            f := graph.Nodes[id]
            dstStorage.Write(f)
        }

        // 7. Delete from source (only after all writes succeed)
        for _, id := range componentIDs {
            srcStorage.Delete(id)
        }

        return nil
    },
}
```

**Edge cases:**
- **Same tapestry**: Error if source == target
- **ID collision**: Error if any fiber ID exists in target
- **Missing target**: Error if target `.felt/` doesn't exist
- **Confirmation**: Require `-y` flag or interactive confirm for >1 fiber

**Files:**
- New: `cmd/move.go` (~150 lines)
- New: `cmd/move_test.go` (~100 lines)

## Context

@internal/felt/storage.go — Current storage implementation. `FindProjectRoot()` walks up looking for `.felt/`. `NewStorage(root)` creates storage for a given root. All commands use this pattern.

@internal/felt/graph.go — DAG operations. `BuildGraph()` constructs graph from fibers. `GetUpstream()`/`GetDownstream()` do BFS traversal. `ValidateDependencies()` checks for dangling refs.

@cmd/ls.go — Main listing command. Add `--all` flag here and hint logic.

@cmd/add.go — Example command pattern. Shows how commands get storage via `FindProjectRoot()` + `NewStorage()`.

## Completion

**Verify by doing, not by checking boxes:**
- Run the tests. Do they pass?
- Try interacting with what you built. Does it work as intended?
- Look for edge cases not covered by tests. Handle them.
- Check that behavior is documented where appropriate.
- Read through the changes with fresh eyes. Anything feel off?

**What must be true when this spec is done:**

1. **Discovery works:**
   ```bash
   cd /tmp/test && felt init
   mkdir sub && cd sub && felt init
   cd ..
   felt register ./sub
   felt tapestries  # Shows both . and ./sub
   ```

2. **Aggregated views work:**
   ```bash
   felt add "Parent fiber"
   cd sub && felt add "Child fiber"
   cd ..
   felt ls --all  # Shows both with [.] and [./sub] prefixes
   felt ls        # Shows hint about nearby tapestries
   ```

3. **Move works with connected components:**
   ```bash
   cd sub
   felt add "Dep A"
   felt add "Task B" -a dep-a-xxx
   felt add "Task C" -a task-b-xxx   # Chain: A <- B <- C
   felt move task-b-xxx ..           # Moves all 3
   cd .. && felt ls                  # Shows all 3
   cd sub && felt ls                 # Empty
   ```

4. **Tests pass:** `go test ./...`

5. **Build succeeds:** `go build .`
