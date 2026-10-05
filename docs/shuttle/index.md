# Shuttle

Shuttle runs coding agents against written tasks and gives you a board for following their work.
Use it when you want to describe a result, choose where an agent works, and come back to a recorded outcome.
It can run tasks on your laptop or on an awake remote machine.

Tasks live in **felt**, the command-line tool for Markdown notes shipped in this repository.
felt calls each note a **fiber** and keeps it under a `.felt/` directory in your project.
You can edit a fiber in any text editor and keep it in Git.
Shuttle adds execution settings to selected fibers; your other fibers remain notes.

[Set up Shuttle](setup.md) takes you from installation to a small task on one machine.
You don't need a multi-machine setup to start.

## From a written task to a result

Suppose you are planning a small workshop.
You have recorded your venue choice in felt and written a draft programme.
Now you want an agent to turn those notes into a one-page guide for participants.
Write a fiber describing the result: include travel directions and the schedule, use the existing notes, and flag missing details rather than inventing them.
Shuttle calls this task description a **constitution**: it gives the agent a result to work toward and the constraints it must respect.
The agent chooses its implementation steps.

1. **Prepare the task.** Write the fiber, choose an installed agent, and tell Shuttle the project directory where it should work.
2. **Start the work.** Activate the task with `shuttle resume` or the board.
   Shuttle's background service, called the **daemon**, watches your registered note collections and launches the agent.
   A running agent session is called a **worker**.
3. **Follow and steer.** Read the task on the board, open its conversation, or attach to a terminal worker with `shuttle attach <fiber>`.
   You can revise the written task as your requirements change.
4. **Read the result.** The worker records its conclusion in the fiber's `outcome` field.
   It closes the task for your review, or leaves continuation notes and hands off so another session can continue.

<video controls preload="metadata" playsinline
  poster="../assets/shuttle-board-tour-poster.jpg"
  aria-label="Narrated tour of the Shuttle board: creating a task, starting a new session or resuming one, opening a worker with Aloft, and reviewing a result">
  <source src="../assets/shuttle-board-tour.mp4" type="video/mp4">
  <track kind="captions" srclang="en" label="English" default src="../assets/shuttle-board-tour.vtt">
  <a href="../assets/shuttle-board-tour.mp4">Download the narrated board tour (MP4)</a>.
</video>

The tour pairs screenshots of the board over a fictional workshop with control guides, diagrams of dialogs and menus the screenshots don't show.

A terminal worker runs in **tmux**, which keeps its terminal session alive when you close a window or disconnect from SSH.
Codex can also run through its native desktop backend; see [Opening conversations](conversations.md) for the available choices.
The machine doing the work must stay awake.

## A task carries its own context

The fiber's body holds the goal, constraints, and evidence.
Its `outcome` is a short conclusion you can read without opening the whole document.
A `## Status` section tells a continuing worker what's done, what remains, and how to proceed.
This makes unfinished work readable across sessions, including sessions with a fresh conversation.

Shuttle stores execution settings in the fiber's YAML header, under `shuttle:`:

```yaml
---
name: Prepare the workshop guide
status: active
shuttle:
  kind: oneshot
  host: my-laptop
  project_dir: /home/me/projects/workshop
  agent: claude-opus
---
```

Here `oneshot` means a finite task, `host` selects the machine that may run it, `project_dir` sets the agent's working directory, and `agent` selects a configured agent.
Use `shuttle install` to write these settings rather than assembling the block by hand.
[Set up Shuttle](setup.md#run-one-small-task) shows the complete commands and explains the release step that allows tasks to launch after a daemon restart.

felt preserves the `shuttle:` settings without interpreting them.
The `shuttle` command validates them and manages the task's lifecycle.
The document stays readable even without Shuttle running.

## Follow the work on the board

The daemon serves a browser board at `http://127.0.0.1:4000/` on a single-user machine.
It has three views:

- **Desk:** task cards, running workers, and results awaiting your review.
- **Chronicle:** activity, sessions, and commits over time.
- **Board:** a document overview and reader for each fiber's channel. The fiber page carries its controls inline; its worker pill opens the conversation.

[The board guide](board.md) covers editing, review, and the controls in each view.
The command line also supports task lifecycle operations if you prefer working from a terminal.

Each machine runs its own daemon and owns the workers it starts.
Connecting machines lets one board show their combined tasks and activity; this group of connected machines is called a **fleet**.
[Connect your machines](remotes.md) covers discovery, SSH, and shared servers.

## Continue

- [Set up Shuttle](setup.md): install the service and run your first task.
- [Constitutions](constitutions.md): write goals and constraints an agent can act on.
- [Lifecycle](lifecycle.md): pause, resume, review, and continue work.
- [Opening conversations](conversations.md): return to workers in a terminal, desktop app, or browser.
- [Installation reference](installation.md): configuration files, service management, and recovery.

For notes without agent execution, start with [felt's getting-started guide](../getting-started.md).
