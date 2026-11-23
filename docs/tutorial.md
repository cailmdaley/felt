# Interactive tutorial

Learn felt and Shuttle by using them, with the coding agent you already have as your tutor — or follow the commands yourself.
Give Claude Code, Codex, Antigravity, or Pi this prompt:

```{.text .agent-prompt}
Read https://cailmdaley.github.io/felt/tutorial/ and walk me through an interactive, hands-on tutorial of felt and Shuttle. Ask what I want to learn first, use a disposable scratch folder, and use the cheapest available model for any demo threads.
```

Everything below is both the human-readable walkthrough and the exact protocol your agent follows.

## Tutor protocol

You are a hands-on tutor.
Your user learns by watching real commands run and deciding what happens next.

### 1. Look, then ask

Summarize felt and Shuttle in two or three sentences, in your own words.
Then see what is installed; a missing tool is normal, not an error:

```sh
felt --version
shuttle --version
shuttle doctor
shuttle agents
```

Tell the user what you found, then show this menu and **ask where to start**.
Wait for the answer. Suggest Module 1 to a newcomer.

| # | Module | Needs |
|---|---|---|
| 1 | felt: your Git-backed wiki and memory store | `felt` |
| 2 | Ambient mode: an everyday session becomes a thread | daemon, tmux or Rex |
| 3 | Running and steering a thread | daemon, one signed-in agent |
| 4 | Trees of threads: agents managing agents | Module 3's setup |
| 5 | Messages, family boards, files and tapestries | Module 3's setup |
| 6 | Multi-machine fleets | daemon; a second machine to go beyond a look |
| 7 | The default UI, and building your own | daemon, a browser |

If felt is missing, offer to install it: `curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh`.
If the daemon is missing, Module 1 still works in full; for the rest, offer the [agent setup checklist](shuttle/agent-setup.md).
Ask before installing anything.
If a command below isn't recognized, check its `--help`: the installed release may be older than this page. Offer `felt update`, and skip that exercise if the user declines.

### 2. Stay in the sandbox

Do every exercise in one disposable directory. **Never write to the user's own felt stores or active work.**

```sh
SANDBOX="$HOME/shuttle-tutorial-sandbox"
mkdir "$SANDBOX" && touch "$SANDBOX/.shuttle-tutorial"
cd "$SANDBOX" && git init
```

`mkdir` without `-p` fails if the directory exists. Don't reuse it: ask, or pick another name.
Shell variables may not survive between your tool calls, so set `SANDBOX` again in each one, and pass `-C "$SANDBOX"` to every `felt` and `shuttle` command that touches the sandbox.

Some steps reach outside the sandbox. They are marked **[asks first]**: say exactly what will change and how you will undo it, and go ahead only on a yes. Never skip that because the user agreed to the tutorial in general.

### 3. Use the cheapest model

**Mandatory for every worker the tutorial launches.**
Read `shuttle agents --json` (it carries `cost_class`) and choose the first of these that is in the registry, whose program is installed, and that is signed in. Check the program with `command -v`: `claude`, `codex` and `pi` are named as the record's `cli`, and `cli: antigravity` runs `agy`.

1. `claude-haiku`
2. `agy-flash`
3. `pi-haiku`
4. `codex-luna`
5. `pi-openai-luna`
6. `pi-luna`
7. `pi-gemini-flash`
8. `pi-openai-terra`
9. otherwise, any agent with `cost_class: economy`, or whichever fast, small model the registry holds

Never spend a flagship or lead model (`claude-fable`, `claude-opus`, `agy-neon`) on a demo unless the user explicitly asks.
Omitting the agent does *not* mean cheap: the registry default is a large model. So always pass it: `-m "$CHEAP"` to `shuttle install`, `--agent "$CHEAP"` to `shuttle thread`, `adopt` and `capture`.
Lower its effort too, before launching, with `shuttle -C "$SANDBOX" set-agent <fiber> --effort low`, where the agent has effort levels. The luna agents default to `max`.
Tell the user which model you chose and why. Keep the demo prompts tiny.
Demo launches use your agent subscription or API account.

### 4. One small step at a time

- One idea per turn: say what you are about to do, run it, show the real output, explain what changed on disk or in the daemon, and ask before going on.
- Never invent output. If a command fails, show the failure and work it out together.
- Before a revealing step, invite a guess: "what do you think `felt ls` shows now that it's closed?"
- Let the user type the commands if they'd rather.
- When waiting on a worker, check every few seconds and say what you see.

### 5. Finish with cleanup

Run the [cleanup](#cleanup) when the user stops, at whichever module that is, and offer to delete the sandbox.

## Shared setup for Modules 2–5

The daemon only runs fibers in stores it has been told about, so the sandbox has to be registered for these modules.

1. If Module 1 was skipped, make the store: `cd "$SANDBOX" && felt init`, then `felt -C "$SANDBOX" add tutorial "Plan a one-day workshop"`.
2. **[asks first]** Register the sandbox: add its absolute path to `felt_stores` in `~/.config/shuttle/stores.json`, keeping every other entry. The board's **Settings → Notes & tasks** does the same. Undo it by removing that one path again. If `SHUTTLE_STORES` is set for the daemon, it overrides the file; stop and explain rather than editing the service.
3. Addresses must be unique across registered stores. If the user already has a top-level `tutorial` note elsewhere (`shuttle find tutorial`), use `shuttle-tutorial` as the root instead, here and in every command and the Module 7 filter.
4. Check the daemon with `shuttle daemon status` and `shuttle doctor`.

After any restart the daemon holds new launches until `shuttle daemon release`. That releases *every* held task on the machine, so don't run it for a tutorial. `shuttle -C "$SANDBOX" dispatch <fiber>` starts one fiber without releasing the rest.

A worker's program may ask whether to trust a new folder. If a worker sits without working, have the user open it with `shuttle -C "$SANDBOX" attach <fiber>`, answer, and leave with `Ctrl-b` then `d` in tmux.

## Module 1: felt, your Git-backed wiki and memory store

Exercise: plan a fictional workshop for 25 people.

```sh
cd "$SANDBOX" && felt init
felt add tutorial "Plan a one-day workshop" -b "A fictional workshop for 25 people."
felt add tutorial/venue "Choose a venue" -s open
felt add tutorial/programme "Draft the programme" -s open \
  -b "Sessions must fit the room chosen in [[tutorial/venue]]."
felt tree
felt ls
```

`tree` shows all three notes nested. `ls` shows two, because only `open` and `active` notes ask someone to act; `tutorial` has no status.
Open `.felt/tutorial/venue/venue.md` together: plain Markdown, with a short YAML header felt stamps.

Read and follow a link:

```sh
felt show tutorial/programme
felt show tutorial/venue --citations
```

The second lists `tutorial/programme`: the `[[wikilink]]` can be followed backwards.

Record a decision, then find it:

```sh
felt edit tutorial/venue -s closed \
  -o "Use the library meeting room: it seats 30 and is near the station."
felt ls
felt find station
felt show tutorial/venue
```

The venue leaves the to-do list, and `find` still reaches it: closed notes hold what was decided. Ask the user to write one outcome of their own.

Reorganize, and let links follow:

```sh
felt add budget "Estimate the budget"
felt nest budget tutorial
felt tree
felt check
```

Commit with `git add .felt && git commit -m "Plan the workshop"`. `felt sync` merges and `felt sync --push` publishes when the repository has an upstream; this sandbox has none, so just explain them.

**Done when** the user can say where a note is stored, and what an outcome is for.

## Module 2: Ambient mode, where every session is a thread

With ambient mode on, each new Claude Code, Codex or Antigravity session is told how to adopt itself into a fiber once the conversation becomes substantive work. Quick questions stay untracked.

See the current state:

```sh
shuttle host ambient
shuttle host --json
```

**[asks first]** Turn it on, remembering what it was: `shuttle host ambient on`.
That writes `"ambient": true` into `~/.config/shuttle/host.json`. `$SHUTTLE_AMBIENT` (`1` or `0`) overrides the file for one environment. Undo with `shuttle host ambient off`, if that is how you found it.

Have the user open a new agent session in the sandbox, in a second terminal. Its start-of-session context holds a `[Shuttle ambient mode]` note with a complete `shuttle adopt` command. The note appears only when the daemon is reachable and the session isn't already a Shuttle worker. Your own session began before you turned it on, so it has no such note.

**[asks first]** Adopt a session into the sandbox. This needs tmux or Rex. The simplest is for the user to ask that second session: "adopt yourself into `tutorial/session` in this store". To adopt your own session, run:

```sh
shuttle -C "$SANDBOX" adopt tutorial/session "Learn felt and Shuttle" \
  --project-dir "$SANDBOX" --agent "$CHEAP_SAME_PROGRAM"
felt -C "$SANDBOX" show tutorial/session
shuttle -C "$SANDBOX" status tutorial/session
```

`CHEAP_SAME_PROGRAM` is the cheapest agent run by the same program as the adopted session.
One command created the fiber, installed it as a draft, claimed the live session for it and activated it. If the claim fails (the usual reason is no tmux or Rex), the fiber stays a harmless draft; show that instead.

From here the session has an address, shows on the board, and can be messaged. Two things to know:

- `shuttle close`, `handoff` and `rest` **end the session** when it runs them on its own fiber. Don't run them in yours.
- An active fiber whose session exits gets a successor. Park it before cleanup with `shuttle -C "$SANDBOX" pause tutorial/session --no-kill`, which leaves the session running.

**Done when** the user has seen the note or an adopted session, and can turn ambient mode off.

## Module 3: Running and steering a Shuttle thread

Exercise: an agent writes a one-page participant guide. Choose `CHEAP` as in rule 3 and say what it is.

Write the constitution first, with no agent attached:

```sh
felt -C "$SANDBOX" add tutorial/guide "Write the participant guide" -s open
```

Put this in `.felt/tutorial/guide/guide.md`, below the header:

```markdown
Write a short guide for people attending the workshop.

## Desired State

- `guide.md` in the project directory is under 150 words.
- It names the venue recorded in [[tutorial/venue]] and flags missing facts instead of inventing them.
- Before closing, `tapestry.html` beside this fiber shows the guide as a small self-contained page.

## Status

Not started.
```

The Desired State says what must be true at the end. The agent chooses the steps.

```sh
shuttle -C "$SANDBOX" install tutorial/guide --disabled \
  --project-dir "$SANDBOX" -m "$CHEAP"
shuttle -C "$SANDBOX" set-agent tutorial/guide --effort low
shuttle -C "$SANDBOX" status tutorial/guide
felt -C "$SANDBOX" show tutorial/guide
```

The fiber now carries a `shuttle:` block and is still a draft; `status` names the verb that arms it. Skip `set-agent` if the agent has no effort levels.
Ask before launching, then:

```sh
shuttle -C "$SANDBOX" resume tutorial/guide
shuttle -C "$SANDBOX" status tutorial/guide
```

The daemon launches on its next poll. If it is holding launches after a restart, use `dispatch` as in the shared setup. Steer it while it runs:

```sh
shuttle -C "$SANDBOX" message tutorial/guide "Use a friendly tone, and end with one packing tip."
shuttle -C "$SANDBOX" attach tutorial/guide
```

The receipt says what became of the message: delivered into a running turn, waking the worker, or queued for the next one. `attach` takes over a terminal, so the user runs it in their own.

When the worker closes the fiber, read the result together before giving a verdict:

```sh
felt -C "$SANDBOX" show tutorial/guide --field outcome
cat "$SANDBOX/guide.md"
```

Let the user decide. `shuttle -C "$SANDBOX" close tutorial/guide --tempered=true` accepts it; `--tempered=false` discards it; `shuttle -C "$SANDBOX" reopen tutorial/guide` sends it back to work. If a worker misbehaves, `shuttle -C "$SANDBOX" pause tutorial/guide` stops it and parks the fiber. `shuttle -C "$SANDBOX" kill tutorial/guide` only kills the worker and records no verdict, so an active fiber can launch again.

`shuttle capture "<prompt>" --project-dir <dir> --agent "$CHEAP"` is the shortcut for an idea you haven't written up: it launches an agent to write and claim a constitution. Describe it rather than running it, since that agent chooses where to file.

**Done when** the user has accepted or returned a result.

## Module 4: Trees of threads, agents managing agents

A constitution nested under another is a thread, and its nearest ancestor constitution is its **orchestrator**. Use a parent that stays a draft, so only the cheap children run:

```sh
felt -C "$SANDBOX" add tutorial/host "Prepare to host the workshop" -s open
shuttle -C "$SANDBOX" install tutorial/host --disabled \
  --project-dir "$SANDBOX" -m "$CHEAP"
shuttle -C "$SANDBOX" thread tutorial/host \
  "List three icebreakers for 25 people" --agent "$CHEAP" --slug icebreakers --disabled
shuttle -C "$SANDBOX" thread tutorial/host \
  "List five signs the room needs" --agent "$CHEAP" --slug signs --disabled
felt -C "$SANDBOX" tree tutorial/host
```

Each child took its host, project directory and role from the parent. `--disabled` holds it as a draft; without it, `thread` arms the child at once. Write a one-line Desired State into each child's file ("the outcome holds the list"), ask, then start them at low effort and watch:

```sh
shuttle -C "$SANDBOX" set-agent tutorial/host/icebreakers --effort low
shuttle -C "$SANDBOX" set-agent tutorial/host/signs --effort low
shuttle -C "$SANDBOX" resume tutorial/host/icebreakers
shuttle -C "$SANDBOX" resume tutorial/host/signs
shuttle -C "$SANDBOX" threads tutorial/host
```

`threads` is the orchestrator's view: what is working, what asks, what is closed and to be reviewed. A finished child lands under **To review**, since its result goes to the orchestrator rather than straight to the user. A child's close or question wakes only the session that asked for it with `shuttle thread`; others get it as context. Here that may be your own session.
Play orchestrator with the user: read each outcome against its Desired State, then temper or discard it, or put it in front of the human with `shuttle -C "$SANDBOX" close <child> --review "<why it is worth a look>"`.

**Done when** both children have a verdict and the user can say whom a thread answers to.

## Module 5: Messages, family boards, files and tapestries

No browser needed. Use the fibers from Modules 3 and 4.

```sh
shuttle sessions
shuttle -C "$SANDBOX" message tutorial/host "Budget is fixed at 400." --context-only
shuttle -C "$SANDBOX" post --fiber tutorial/host/signs "Signs need A3 paper."
shuttle -C "$SANDBOX" post --fiber tutorial/host --to human "The room is ready: 25 chairs, A3 signs."
shuttle -C "$SANDBOX" board tutorial/host
```

- `sessions` lists live conversations as `shuttle://HOST/HARNESS/ID`. They may be the user's real work: look, and never message one that isn't part of the tutorial.
- `message` addresses one fiber or session. `--context-only` never starts a turn. With no live worker it waits in the fiber's durable inbox: `shuttle -C "$SANDBOX" inbox ls tutorial/host`.
- `post` writes a line on the family's shared board and wakes no one. `board` reads it. Without `--to`, a thread's post goes up to its orchestrator, as the first one does. `--to human` puts the line in the board's Channels view, where it waits on the user until they reply or clear it.

Send a file. A worker's own `shuttle send-file` is recorded against its fiber. From your session it would be recorded against your session, so name the fiber by its id:

```sh
FIBER_ID="$(felt -C "$SANDBOX" show tutorial/guide --field id)"
shuttle -C "$SANDBOX" send-file "$SANDBOX/guide.md" \
  --session "$FIBER_ID" --caption "The guide, for review"
shuttle -C "$SANDBOX" sent-files ls tutorial/guide
```

`sent-files ls` shows the file's time, path, caption and URL. `sent-files clear` hides the trail and deletes no file.

A **tapestry** is one page, `tapestry.html`, beside a fiber, showing where its work stands:

```sh
shuttle -C "$SANDBOX" tapestry tutorial/guide
shuttle -C "$SANDBOX" tapestry tutorial/guide --path
shuttle -C "$SANDBOX" tapestry tutorial/guide --url
```

If the worker left none, write a five-line page at `.felt/tutorial/guide/tapestry.html` and run it again. Ask before `--open`, which opens a window on the user's screen. A daemon on a private socket (a shared server) has no URL to give; use `--path`.

**Done when** the user has read a board line, a sent file and a tapestry from the terminal.

## Module 6: Multi-machine fleets

```sh
shuttle host
shuttle remotes list
```

Every machine runs its own daemon and owns the workers it starts. Walk through the list, if any:

- **Discovered** rows are daemons found over Tailscale, signed in as the same user. They need no configuration.
- **Configured** rows come from `~/.config/shuttle/remotes.json`. This is the SSH route for shared servers and machines outside the tailnet.
- `shuttle.host` on a constitution names the *one* daemon allowed to run it. Copying its file with Git never moves the work. Commands given here for another host's fiber are routed to its owner, which does the writing.

Show the affinity on a draft that never leaves the sandbox, with a remote from the list:

```sh
shuttle -C "$SANDBOX" thread tutorial/host "Print the date" --agent "$CHEAP" \
  --host <remote> --project-dir /tmp --slug remote-date --disabled
felt -C "$SANDBOX" show tutorial/host/remote-date
```

A remote draft stays in this store while you write it, and its block names the other host. **Don't resume it**: that would create it in the other machine's store. A real remote run is **[asks first]**, and needs a sandbox registered on that machine as well.
With no remotes, explain the two routes and offer [Connect your machines](shuttle/remotes.md).

**Done when** the user can say which machine runs a given fiber.

## Module 7: The default UI, and building your own

On a single-user machine, the user opens <http://127.0.0.1:4000/>. **Let them open it**: never drive the live board with a browser tool, since it takes over what they are looking at. Shared servers listen on a private socket; see [Connect your machines](shuttle/remotes.md#shared-servers-and-clusters).

- Press `1` for **Desk**: what waits on them, what is working, what awaits review, what rests. Find the tutorial's cards.
- Press `2` for **Channels**: what the work says to them. Find the line Module 5 posted with `--to human`, under `#misc`, and clear it with its ✓.
- The **Fleet Map** is a page of its own at `/map`.

**[asks first]** Now build a UI. Create `~/.config/shuttle/ui/tutorial-board/index.html`. If that folder exists, choose another name.

```html
<!doctype html>
<meta charset="utf-8">
<title>Tutorial board</title>
<style>
  body { font: 16px/1.5 system-ui; max-width: 44rem; margin: 2rem auto; }
  [data-slot="shuttle-thread-row"] { display: flex; gap: 1rem; padding: .4rem; }
  [data-slot="doing"] { flex: 1; }
  [data-attention="waiting"] [data-slot="slug"] { color: crimson; }
  [data-attention="working"] [data-slot="slug"] { color: seagreen; }
</style>
<h1>My threads</h1>
<p id="note" role="status"></p>
<main></main>
<script type="module">
  import { ShuttleClient, ShuttleFeed, createThreadRow } from '/sdk/shuttle-sdk.js'
  const feed = new ShuttleFeed(new ShuttleClient())
  feed.subscribe(({ fibers, error }) => {
    document.querySelector('#note').textContent = error ?? ''
    const mine = fibers.filter(f => f.fiber.id.startsWith('tutorial/') && f.column)
    document.querySelector('main').replaceChildren(
      ...mine.map(f => createThreadRow(f, { now: Date.now() })))
  })
  feed.start()
</script>
```

Open <http://127.0.0.1:4000/ui/tutorial-board/>. There is no build step and no restart: the daemon reads the file on each request. Change a color, reload, and it's theirs. Then invite the user to ask for a change: show only what waits on them, or add `createComposer` under a selected row.

It lists only fibers whose id begins with `tutorial/`, so it stays clear of the user's real work. It reads, and changes nothing, as written.

The SDK sets no colors, fonts or layout. It supplies structure, keyboard behavior and ARIA, and marks its parts with `data-slot` and their state with attributes such as `data-attention`. The [UI layers & SDK](shuttle/ui-architecture.md) guide has a fuller example.

**Done when** the user has changed the page and seen the change.

## Cleanup

Do this in order, and skip what wasn't used:

1. List what could still run: `shuttle -C "$SANDBOX" status`. Stop each armed tutorial fiber with `shuttle -C "$SANDBOX" pause <fiber>`. For a session adopted in Module 2, add `--no-kill`.
2. Unregister the sandbox: remove its path from `felt_stores` in `~/.config/shuttle/stores.json`, leaving every other entry.
3. Put ambient mode back as it was: `shuttle host ambient on` or `off`.
4. Remove `~/.config/shuttle/ui/tutorial-board/` if you made it.
5. Offer to delete the sandbox. On a yes, check that `"$SANDBOX/.shuttle-tutorial"` exists and that `$SANDBOX` is the directory you created, then `rm -rf "$SANDBOX"`.

Say what remains: Shuttle's host-local history (posts, sent-file records, session transcripts) keeps lines from the demo, and nothing in it runs.
End with one suggestion for the user's own work, such as a first decision worth recording with felt, and the page that covers it.
