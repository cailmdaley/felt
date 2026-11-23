# felt

When a project spans several days or coding-agent sessions, decisions and unfinished work scatter across chat transcripts, issue comments, and half-finished notes.
**felt** keeps them beside the work as ordinary Markdown files in Git that both you and your agents read, edit, and search.
**Shuttle** is an optional layer on top that runs coding agents against those notes and lets you follow their progress on a board or from the terminal.

## felt is the notes; Shuttle is the live sessions

| | felt | Shuttle |
|---|---|---|
| Holds | **fibers**: notes, decisions, tasks, and the files beside them | the live sessions working on those fibers |
| Does | record, search, link, nest, and sync through Git | launch agents on tasks, show them on a board, carry messages between sessions, search their transcripts |
| Runs as | the `felt` command; nothing in the background | the `shuttle` command and a background **daemon** |
| An agent needs | the felt skill | the shuttle skill as well |

You can use felt on its own, with any editor and no background service.
A collaborator joining a shared store needs only felt; Git carries the notes.
Shuttle becomes useful when you want agents launched for you, a board to follow them on, or sessions that message each other.

## How it works

### Notes that grow with the work

Each note in felt is called a **fiber**: a Markdown file with a short YAML header (`name`, optional `status`, and a one-sentence `outcome` recording what was decided) living in its own directory under `.felt/`.

```markdown
---
name: Choose a workshop venue
status: closed
outcome: "Use the library meeting room: it seats 30 and is near the station."
---

We expect 25 people, and several will arrive by train.
The café is closer, but its back room only seats 18.
```

Related fibers nest in directories, connect with `[[wikilinks]]`, and keep plots, PDFs, or reports beside the note that explains them.
`.felt/` opens as an [Obsidian](https://obsidian.md) vault, works with any text editor, and [cross-project stores](concepts/cross-project.md) let several projects share one collection.
With the [agent integration](agents.md), Claude Code, Codex, Antigravity, and Pi read project context at session start and write back what they learn, so the next session reads the conclusion instead of recovering a whole transcript.

### Written tasks run by coding agents

With Shuttle, adding a `shuttle:` block turns a fiber into a **constitution**: a written description of the result you want an agent to produce, along with the project directory, agent, and host that should run it.

1. **Describe the result.** Write the goal and constraints (`## Desired State`), not step-by-step instructions.
2. **Let the daemon run it.** Shuttle's background service launches a **worker** (an agent session in tmux or Rex) in your project directory. Constitutions nest like any other fibers, so an orchestrator can manage child **threads**.
3. **Follow and steer.** Check progress, send messages, inspect files, or read a worker's summary page (**tapestry**) from the terminal or the browser board.
4. **Review the outcome.** Finished work records its conclusion in `outcome` and waits for review; unfinished work writes `## Status` and hands off so a fresh session can continue cleanly.

With [ambient mode](shuttle/configuration.md#ambient-mode) on, an ordinary coding-agent session you started yourself can also adopt itself into a thread once the conversation turns into substantive work.
Each machine runs its own daemon and owns the workers it launches; [connecting machines](shuttle/remotes.md) lets one board show and steer a whole **fleet**.

### One engine, three UI layers

Shuttle is built in [three layers](shuttle/ui-architecture.md):

- **Layer 1 — CLI & HTTP API:** everything can be done from the `shuttle` command or the daemon's Core HTTP API without opening a browser.
- **Layer 2 — UI primitives SDK:** every daemon serves unstyled, accessible UI components at `/sdk/shuttle-sdk.js` so you can drop a personal interface into `~/.config/shuttle/ui/<name>/` with no build step.
- **Layer 3 — The default board:** served at `http://127.0.0.1:4000/`, with two views — **Desk** (what waits on you, what is working, what awaits review, and what rests) and **Channels** (what each line of work says to you, with attached files and per-worker threads).

<video controls preload="metadata" playsinline
  poster="assets/shuttle-board-tour-poster.jpg"
  aria-label="Narrated tour of the Shuttle board: creating a task, starting a new session or resuming one, opening a worker, and reviewing a result">
  <source src="assets/shuttle-board-tour.mp4" type="video/mp4">
  <track kind="captions" srclang="en" label="English" default src="assets/shuttle-board-tour.vtt">
  <a href="assets/shuttle-board-tour.mp4">Download the narrated board tour (MP4)</a>.
</video>

*The tour uses a fictional workshop: venue research, a draft programme, and a participant guide.*

## Ready to start?

Go to **[Setup & Tutorial](getting-started.md)** — we recommend letting your coding agent guide you through installation and the hands-on tutorial.
You can also explore the in-depth documentation in the sidebar, or give your agent [`llms.txt`](llms.txt) to index the whole site.

## License & contributing

Both Go CLIs and the board UI ship under the [MIT License](https://github.com/cailmdaley/felt/blob/main/LICENSE).
The shuttle daemon (`daemon/lib/`) contains code derived from OpenAI's Symphony under the [Apache License 2.0](https://github.com/cailmdaley/felt/blob/main/LICENSE-APACHE), preserved in [`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).

Source and issues live at [github.com/cailmdaley/felt](https://github.com/cailmdaley/felt).
To build or patch felt, see [CONTRIBUTING.md](https://github.com/cailmdaley/felt/blob/main/CONTRIBUTING.md) and [AGENTS.md](https://github.com/cailmdaley/felt/blob/main/AGENTS.md).
