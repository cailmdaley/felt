# Interactive tutorial

Learn felt and Shuttle by using them, with the coding agent you already have as your tutor.
Give it this prompt:

```{.text .agent-prompt}
Read https://cailmdaley.github.io/felt/llms.txt and walk me through an interactive, hands-on tutorial of felt and Shuttle. Ask what I want to learn first, use a disposable scratch folder, and use the cheapest available model for any demo threads.
```

Claude Code, Codex, Antigravity and Pi can all follow it.
Your agent checks what you have installed, shows you a menu, and takes one small step at a time: it runs a real command, shows you the output, and explains what changed before going on.

## The two parts

**felt** keeps your notes, decisions and tasks as Markdown files in Git, with a command-line tool to write, link and search them.
It works by itself, with nothing running in the background.

**Shuttle** runs coding agents against those notes.
You write the result you want; a background service, the daemon, launches an agent session to produce it, and the answer is recorded in the note.
Tasks nest, so one agent can manage others, on one machine or several.

## Modules

Start at the beginning or jump to the one you want.

| # | Module | You will | Needs |
|---|---|---|---|
| 1 | felt, your Git-backed wiki | plan a small workshop: write, link, find and close notes | felt |
| 2 | Ambient mode | let an everyday agent session adopt itself into a thread | the daemon, tmux or Rex |
| 3 | Running and steering a thread | write a goal, launch an agent, message it and review its result | the daemon, a signed-in agent |
| 4 | Trees of threads | give a parent two child threads and review what they return | Module 3's setup |
| 5 | Messages, files and tapestries | follow the work entirely from a terminal | Module 3's setup |
| 6 | Multi-machine fleets | see which machine owns which work | the daemon; a second machine is optional |
| 7 | The default UI, and your own | tour the board, then build a small UI without a build step | the daemon, a browser |

Module 1 needs only [felt](getting-started.md).
For the rest, [set up Shuttle](shuttle/setup.md) first, or ask the tutor to help.

## Ground rules for the tutor

[`llms.txt`](llms.txt) gives your agent these rules, along with the exercises:

- **A disposable sandbox.** Exercises happen in a scratch folder. The agent never writes to your real notes or active work, and offers to delete the folder at the end.
- **The cheapest model.** Every demo thread runs on the cheapest model you have installed and signed in to, at low effort. The agent tells you which one, and uses a larger model only if you ask.
- **Asking before reaching outside.** A few steps touch your machine's Shuttle configuration, such as registering the sandbox with the daemon or turning ambient mode on. The agent says what will change and how it will undo it, and waits for your yes.
- **Real output.** The agent shows what your machine printed, including failures.

Demo launches use your agent subscription or API account.
Some history remains after cleanup: Shuttle keeps a host-local record of posts, sent files and sessions.

## Follow it yourself

[`llms.txt`](llms.txt) is plain text, and its commands work without an agent.
It also indexes this documentation for any coding agent.
