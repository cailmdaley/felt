# Getting started

**For Shuttle, we recommend letting your agent guide setup.**
[Set up Shuttle](shuttle/setup.md) gives you one prompt to copy: your agent installs the service, prepares a notes collection, and puts the setup task on your board.
The linked instructions are readable by you as well as the agent.

The walkthrough below is for using **felt on its own**: install the command-line tools, create a note, and record a decision.
You can follow it yourself or ask your agent to work through it with you.

## Install

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

The installer downloads the `felt` and `shuttle` commands and prints where it puts them.
It uses `/usr/local/bin` if writable, otherwise `~/.local/bin`; add that directory to `PATH` if your shell cannot find the commands.
Both x86_64 and arm64 are supported.
There is no Windows build.

It also installs felt's integration for supported agent CLIs it finds, including Claude Code and Codex.
That writes to those agents' configuration folders; `felt uninstall` reverses the integration.
If you prefer installing the tools separately from the integration, use Homebrew:

```sh
brew install cailmdaley/tap/felt
```

For source builds and other installation choices, see the [installation reference](shuttle/installation.md).
Check your installation with `felt --version`; use `felt update` later to update both commands and refresh agent integration.

## Create a store

A **store** is a folder containing your felt notes in a `.felt/` directory.
From the project directory where you want to keep notes:

```sh
felt init
```

You can run this again safely; it creates or repairs the store without replacing its notes.
If you use Git, commit `.felt/` with your project to keep the history.
You can connect projects to a [shared store](concepts/cross-project.md) later.

## File a fiber

Each note is called a **fiber**.
Suppose you're planning a small workshop and need to choose a venue:

```sh
felt add workshop-venue "Choose a workshop venue" -s open
```

This creates `.felt/workshop-venue/workshop-venue.md`.
Open it in your editor and write your constraints below the metadata:

```markdown
We expect 25 people, and several will arrive by train.
Compare the library meeting room with the café's back room.
```

The short name `workshop-venue` is how you address the note in commands.
The title is what you and your agents see when reading it.
`-s open` marks it as a task you haven't finished.
An existing decision or reference note doesn't need a status.

## Close it with a real outcome

When you've made the decision:

```sh
felt edit workshop-venue -s closed \
  -o "Use the library meeting room: it seats 30 and is near the station."
```

Add the reasoning to the body so someone can understand the choice later:

```markdown
We expect 25 people, and several will arrive by train.
The café is closer, but its back room only seats 18.
```

The outcome is the conclusion you can read without opening the whole note.
Closing the task keeps that conclusion and the reasoning in your project.

## Find it again

```sh
felt show workshop-venue
felt ls -s all "workshop"
```

`felt ls` by itself lists unfinished tasks.
`-s all` includes closed tasks so you can retrieve completed decisions.
Notes remain ordinary Markdown files you can read in any editor.

When the workshop grows, keep related notes in nested folders and connect them with `[[wikilinks]]` in their text.
[Organizing](concepts/organizing.md) explains when to split a note, nest it, or link it.
[Companion files](concepts/companions.md) shows how to keep a programme, plot, or report beside the note it belongs to.

## Work with your agent

If the installer didn't already add your agent's integration, run the matching command:

```sh
felt setup claude
# Or: felt setup codex
# Or: felt setup pi
```

The integration gives the agent project context at session start and instructions for recording what it learns.
You and the agent read and write the same notes.
For example, an agent preparing the participant guide can read the venue decision instead of asking you to repeat it.
[Agent integration](agents.md) explains the details.

To assign tasks and follow agents on a board, continue with [Set up Shuttle](shuttle/setup.md).
