# Guide a Shuttle setup

Help the user reach one working task, then add the machines and conversation views they need.
The public [setup guide](https://cailmdaley.github.io/felt/shuttle/setup/) carries the human explanation; [installation](https://cailmdaley.github.io/felt/shuttle/installation/) carries the service and configuration reference.
Read the pages for the branch you're setting up, and check the installed CLI's `--help` before using commands that may differ by release.
In a source checkout, use `docs/shuttle/` so guidance matches the code being built.

## Establish the setup

Inspect before asking what the machine can tell you: OS, installed `felt`, `shuttle`, `tmux`, harness versions, `shuttle host --json`, `shuttle doctor`, and `felt setup receipt --json`.
Read existing configuration before changing it and preserve unrelated settings.
Don't print authentication files or tokens.

Ask only for decisions you cannot infer: which machines should run work, which project/store to use, whether other people have accounts there, and where the user wants conversations to open.
Explain the recommendation in those terms, without presenting every configuration field at once.
An agent CLI must already authenticate on each execution host; let the human complete login and trust prompts.

Distinguish these choices throughout:

- The worker's host and execution surface: terminal in tmux, or Codex app conversation.
- The fleet transport: Tailscale or SSH between Shuttle daemons.
- The conversation view: terminal, Claude browser/app, or Codex desktop/remote access.

Remote Control is not a general prerequisite for Shuttle.
Kitty's local control socket, Claude Remote Control, and Codex remote access serve different purposes.

## Reach one local task

Use the prebuilt release unless the user is developing Shuttle.
Initialize or select the store, declare the host class, install the daemon supervisor, then register the store in Settings or its registry.
An empty registry permits the service to start but gives it no work to poll.
Projects in the Capture picker are configured separately from stores.

On macOS, terminal workers need an existing terminal-owned tmux server or Kitty available to start one.
Never kill a populated tmux server to repair its permissions.
On Linux, establish how the daemon survives logout: an authorized lingering systemd user service, or the documented tmux supervisor where systemd isn't available.

Create a small read-only task as a draft and select an installed harness explicitly.
Use `--surface cli` for a terminal Codex test; new Codex tasks otherwise default to app and require an App Server endpoint.
Arm the test, inspect other eligible tasks, then release the daemon's startup hold.
Verify the actual worker starts in the right directory, receives a message, and closes to Awaiting review.
For a terminal worker, test attach and detach too.
If the user only requested the board, don't launch a worker to test it.

## Add a remote

Follow [Connect your machines](https://cailmdaley.github.io/felt/shuttle/remotes/).
Verify installation, login, project path, host identity, and store on the remote before debugging transport.
Use distinct host IDs.

On personal machines, standard Tailscale plus Serve gives same-user discovery without manual fleet entries.
On a shared server, prefer SSH to the protected daemon Unix socket from a single-user hub.
Userspace Tailscale is an advanced, policy-dependent route; don't bypass an institution's required SSH authentication with it.
Keep all authentication and network exposure within the user's authorized setup.

`shuttle remotes add` replaces a configured entry, so preserve extra fields when editing an existing remote.
An SSH entry also needs a running tunnel; `shuttle tunnels install` manages it on supported supervisors.
For two-factor SSH, have the human establish the documented ControlMaster connection and use `--multiplex`.
Verify a return route separately if remote agents must reach the hub.

A discovered HTTPS remote needs an explicit SSH destination for terminal attachment.
Fleet visibility doesn't copy projects or synchronize fibers; Git/`felt sync` handles shared documents, while `shuttle.host` remains the execution owner.
A laptop closing its lid stops local computation and local board availability; only work on an awake remote continues.

## Configure the conversation view

Follow [Opening conversations](https://cailmdaley.github.io/felt/shuttle/conversations/).
The browser's Claude opening preference changes links, not worker execution or Claude's Remote Control settings.
Verify a live recorded Remote Control link before promising browser/app opening.
For Kitty, explain that the opener runs on the daemon serving the page and needs SSH for a remote worker.
Offer the quick-access panel after normal terminal attachment works.

For Codex app workers, follow the [desktop backend guide](https://cailmdaley.github.io/felt/shuttle/codex-desktop/) and inspect the installed app rather than assuming its bundle path.
Use the native bundled executable, preserve the app's tools environment, and give Shuttle the same explicit socket as the bridge.
Keep any existing supervisor overrides when reinstalling.
A restart can interrupt this very conversation if it owns that backend; arrange the verification from an independent session before quitting the app.
Don't substitute a CLI worker to hide an unavailable app backend.

## Leave a verified setup

Check the intended workflow end to end, not only process liveness: the board sees the host, a task runs there, and the chosen opener returns to that exact conversation.
A Codex thread file or a successful `thread/start` response does not prove the desktop or phone can continue it.
Record what was actually tested, the relevant host/store/project choices, and any remaining human login or device check.
Keep machine-specific paths and operational notes in the user's store, not public docs.
Leave rollback instructions for any app override or service you added.
