# Graph Operations

The dependency graph is bidirectional: felt tracks both what you depend on (upstream) and what depends on you (downstream). The public surface for traversal, visualization, and integrity checks is `felt tree`.

## Traversal

```bash
felt tree <id> --up         # direct dependencies
felt tree <id> --up --all   # transitive dependencies
felt tree <id> --down       # direct dependents
felt tree <id> --down --all # transitive dependents
```

## Visualization

```bash
felt tree -f mermaid    # Mermaid diagram
felt tree -f dot        # Graphviz DOT
felt tree -f text       # ASCII tree (default)
felt tree               # dependency tree from roots
felt tree <id>          # subtree from specific felt
```

Mermaid output can be pasted into GitHub markdown or rendered with `mmdc`.

## Integrity

```bash
felt tree --check       # validates graph
```

Checks for dangling references and cycles.

## How Ready Works

`felt ls --ready` returns open felts where all dependencies are closed:

```
       ┌─────────────┐
       │  C (closed) │
       └──────┬──────┘
              │ (B depends on C)
              ▼
       ┌─────────────┐
       │  B (closed) │
       └──────┬──────┘
              │ (A depends on B)
              ▼
       ┌─────────────┐     ┌────────────┐
       │   A (open)  │ ◀───│  D (open)  │
       └─────────────┘     └────────────┘
                            (A depends on D)

ready: D is ready (no deps)
       A is NOT ready (D is open)
```

In this diagram, arrows point from dependency to dependent (same as `felt tree -f mermaid` output). A depends on both B and D. Since D is open, A is blocked. After closing D, A becomes ready.

## Link Management

```bash
felt edit <id> --link <depends-on-id>    # add dependency
felt edit <id> --unlink <depends-on-id>  # remove dependency
```

`felt edit --link` checks for cycles before adding.
