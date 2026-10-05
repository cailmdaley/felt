# Set up Shuttle

This guide targets **2.0.0-rc.1**, a release candidate for testing before the stable 2.0 release.
The agent setup guide pins that version explicitly; ordinary stable updates do not select it.

**We recommend setting up Shuttle with the agent you already use.**
Give it the prompt below, let it check your machine and explain the choices, then open the board link it gives you.
You can use Claude Code, Codex, or pi on macOS or Linux.

Shuttle gives your agents a shared task board.
The setup agent installs the background service, creates a place for notes if you don't have one, and puts its own setup task on the board.
You don't need to organize a collection of notes or learn the command-line tools first.

## 1. Give your agent this prompt

```{.text .agent-prompt}
Read https://cailmdaley.github.io/felt/shuttle/agent-setup/ and help me set up Shuttle on this machine. Use existing configuration where possible, explain the choices I need to make, and record this setup as a task on the board. Give me the board URL when it is ready.
```

The [agent setup guide](agent-setup.md) is also written for you to read.
It explains what will be installed, which files are created, and how the agent checks the result.
You can follow it yourself if you prefer.
Your agent doesn't need the felt plugin installed to read that page; installing the integration is part of setup.

## 2. Open your board

The agent gives you a link, usually <http://127.0.0.1:4000/> on your own laptop.
Open it to see **Set up Shuttle**, the task recording what your agent has done and anything still needed.
When the running conversation can be attached, that card follows the setup session itself.
Otherwise it stays a draft with an explanation; the agent won't pretend that the conversation is connected.

The board has three views:

- **Desk** shows tasks, running agents, and results awaiting review.
- **Chronicle** shows activity over time.
- **Board** holds files agents have sent, such as reports and plots.

Shuttle stores notes as ordinary Markdown files managed by **felt**.
Each note is called a **fiber**.
On a fresh installation, setup creates a default collection so you can start using the board immediately.
You can add project-specific collections later.

## 3. Choose how conversations open

In **Settings**, choose where **Aloft**, the button on a running task, should open its conversation.
The choices depend on the agent and the connections it supports; [Opening conversations](conversations.md) explains them.
A terminal worker keeps running in tmux when you close its window, but the machine itself must stay awake.

Your agent can help connect another machine when you want work to continue while your laptop is closed.
Start with one working machine; add [remotes](remotes.md) when you need them.

## Run one small task

Ask your agent to prepare a small task in the project you want to use—for example, describe its contents without changing any files.
The setup guide includes [a worker check](agent-setup.md#verify-a-worker) so you can see the task start, open its conversation, and review the result.
The setup card records which of these checks actually passed.

## Reference

- [Agent setup guide](agent-setup.md): the readable checklist and commands behind onboarding.
- [Opening conversations](conversations.md): terminal, desktop, and browser choices.
- [Connect your machines](remotes.md): Tailscale, SSH, and shared servers.
- [Codex desktop setup](codex-desktop.md): connect to the same native desktop backend.
- [Installation reference](installation.md): configuration files, service management, and recovery.
