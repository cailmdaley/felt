# Graph Operations

The dependency graph is bidirectional: felt tracks both what you depend on (upstream) and what depends on you (downstream).

## Traversal

```bash
felt upstream <id>      # transitive dependencies
felt downstream <id>    # what transitively depends on this
felt path <from> <to>   # dependency path between two felts
```

## Visualization

```bash
felt graph -f mermaid   # Mermaid diagram (default)
felt graph -f dot       # Graphviz DOT
felt graph -f text      # ASCII tree
felt tree               # dependency tree from roots
felt tree <id>          # subtree from specific felt
```

Mermaid output can be pasted into GitHub markdown or rendered with `mmdc`.

## Integrity

```bash
felt check              # validates graph
```

Checks for dangling references and cycles.

## How Ready Works

`felt ready` returns open felts where *all* dependencies are closed:

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

In this diagram, arrows point from dependency to dependent (same as `felt graph` output). A depends on both B and D. Since D is open, A is blocked. After closing D, A becomes ready.

## Link Management

```bash
felt link <id> <depends-on-id>     # add dependency
felt unlink <id> <depends-on-id>   # remove dependency
```

`link` checks for cycles before adding.
