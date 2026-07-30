# Getting started

This page installs the `felt` CLI and walks one fiber from creation to a closed
outcome. It takes about five minutes. The quickest path needs only `curl` and
`tar`.

## Install

The install script downloads the release binary for your platform:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

It installs to `/usr/local/bin` if that is writable, otherwise `~/.local/bin`.
Override with `FELT_INSTALL_DIR`. It supports macOS and Linux on x86_64 and
arm64. There is no Windows build.

Homebrew:

```bash
brew install cailmdaley/tap/felt
```

From source, if you have Go 1.23.4 or newer (`go.mod` declares `go 1.23.4`, so
an earlier 1.23 patch triggers a toolchain download):

```bash
go install github.com/cailmdaley/felt@latest
```

Check the install:

```bash
felt --version
```

If the command is not found, the install directory is not on your `PATH`. The
script prints the line to add.

!!! note "The script also wires up your coding agents"
    If `claude` or `codex` is on your `PATH`, `install.sh` runs `felt setup
    claude` and `felt setup codex` for you. That registers felt's plugin
    marketplace and installs its hooks, which writes to `~/.claude` and
    `~/.codex`. There is no opt-out flag. The script prints what it is doing
    before it does it, and `felt uninstall` reverses it. If you would rather
    decide yourself, download the script and run it after reading, or use
    Homebrew and run `felt setup claude` when you want it.

Later, upgrade with `felt update`. That swaps the binary and refreshes the agent
plugin in the same step, so the two never skew.

## Create a store

Create a store — a `.felt/` directory — at the root of the project where your
work lives:

```bash
cd ~/dev/my-project
felt init
```

`felt init` creates or repairs `.felt/` and writes two support files: a
`myst.yml` so the store can render as a site, and a `.gitignore` for felt's
per-fiber write locks. Run it again any time — it is idempotent.

Commit `.felt/` to your repository. The trail is worth versioning.

## File a fiber

```bash
felt add covariance-estimation "Covariance estimation" -s open
```

Two arguments: the slug you will address it by, and the human name. Everything
else is optional. `-s open` opts this fiber into status tracking, which is what
makes it show up in `felt ls`.

Most fibers do not need a status. A fiber that records a decision or a finding
completes the moment you write it. Nothing stays to do. Reach for `-s` when you
want the thing to nag you.

Give it a body:

```bash
felt edit covariance-estimation \
  -b "Analytic covariance is too slow for our bin count. Trying jackknife."
```

!!! warning
    `felt edit -b` replaces the whole body. For anything longer than a couple of
    sentences, open `.felt/covariance-estimation/covariance-estimation.md` in
    your editor and write there. felt reads it back on the next command.

## Add a child and nest it

Work grows sub-questions. Give them their own fibers:

```bash
felt add jackknife-patches "Jackknife patch count" -s active
felt nest jackknife-patches covariance-estimation
```

```
Nested jackknife-patches under covariance-estimation as covariance-estimation/jackknife-patches
```

`felt nest <child> <parent>` moves the whole subtree on disk and rewrites the
addresses that point at it. The directory tree carries containment on its own,
so no parent field can drift. `felt unnest <child>` promotes it back to the top
level.

## Look at the store

```bash
felt ls
```

```
○ covariance-estimation
    Covariance estimation
◐ covariance-estimation/jackknife-patches
    Jackknife patch count
```

`felt ls` shows tracked fibers only, open and active by default. Pass a query to
search names, outcomes, frontmatter text, and slugs. Any filter widens the
search to every status automatically:

```bash
felt ls "jackknife"          # search
felt ls -s all               # everything tracked, closed included
felt ls --body "patches"     # search bodies too
```

`felt tree` shows containment:

```
○ covariance-estimation  Covariance estimation
    └── ◐ .../jackknife-patches  Jackknife patch count
```

`felt show` reads one fiber:

```bash
felt show jackknife-patches
```

A bare slug resolves when it is globally unique, so you rarely have to type the
full path. `felt show` has four detail levels — `felt show <id> -d compact` for
metadata and outcome only, `-d full` for everything.

## Close it with a real outcome

This part matters most.

```bash
felt edit jackknife-patches -s closed \
  -o "150 patches: stable off-diagonal, <2% bias at all scales"
```

Write the `outcome` as a one-line conclusion. `felt show -d compact` puts that
line in front of you months later. Say what you learned, decided, or measured,
in a sentence that stands alone. An outcome that says "done" has failed — the
status field already said that.

Closing stamps `closed-at`. The fiber stays in the tree. `felt ls -s all` still
finds it. felt deletes nothing.

## The file on disk

```yaml
---
id: 01KYTG89NAA3MZ68RZSG6MS7VT
name: Jackknife patch count
status: closed
created-at: 2026-07-30T14:52:55-07:00
updated-at: 2026-07-30T15:10:41-07:00
closed-at: 2026-07-30T15:10:41-07:00
outcome: "150 patches: stable off-diagonal, <2% bias at all scales"
---

Tried 50 and 300 as well. Below 100 the off-diagonal is noise-dominated.

Rolls up into [[covariance-estimation]].
```

That covers the whole storage format. felt mints the `id` as a ULID at `felt
add` and preserves it across moves. The `[[wikilink]]` points at another fiber
in the narrative. felt computes the reverse direction on demand, so `felt show
covariance-estimation --citations` finds this fiber pointing at it.

## Next steps

**Wire up your coding agent.** If the install script did not already do it:

```bash
felt setup claude    # or: felt setup codex
```

This installs the felt plugin: a SessionStart hook that lists active and
recently touched fibers, a gate that nudges the agent to load the felt skill
before it starts editing, and the `felt` and `shuttle` skills themselves. The
agent then reads and writes the same store you do. See
[Agent integration](agents.md).

**Keep reading.** [Fibers](concepts/fibers.md) covers the data model in full,
and [Organizing](concepts/organizing.md) covers the judgment calls — when a
status earns its keep, when to nest, how to write an outcome, and when a
wikilink is doing real work.
