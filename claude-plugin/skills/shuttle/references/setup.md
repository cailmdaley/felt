# Guide a Shuttle setup

Help the user reach one working task, then add the machines and conversation views they need.
The public [setup guide](https://cailmdaley.github.io/felt/shuttle/setup/) carries the human explanation; [installation](https://cailmdaley.github.io/felt/shuttle/installation/) carries the service and configuration reference.
Read the pages for the branch you're setting up, and check the installed CLI's `--help` before using commands that may differ by release.
In a source checkout, use `docs/shuttle/` so guidance matches the code being built.

## First machine: use the shared checklist

Read the public [agent setup guide](https://cailmdaley.github.io/felt/shuttle/agent-setup/), or `docs/shuttle/agent-setup.md` in a source checkout.
That page is the canonical onboarding procedure and is readable by the human following along.
The [setup page](https://cailmdaley.github.io/felt/shuttle/setup/) supplies the copyable prompt; don't send a newcomer through a command catalogue first.

Reuse existing configuration and stores.
For a fresh installation, use the installer's default notes collection rather than making the user design a store layout.
Explain where it lives and how to change it later.
Inspect before asking; reserve questions for real choices such as shared-host access, desired remote machines, or conversation opening.
Leave authentication and device permission prompts to the human.

Represent this setup with a fiber named **Set up Shuttle**, reusing an existing setup fiber where appropriate.
Don't reinstall or claim a setup fiber owned by another live worker.
Give it a lede, Desired State, and current Status; keep it open while installing its Shuttle block as a draft.
When this harness can identify and attach its current session, claim it successfully before activating it, as in [capture.md](capture.md).
Never guess a conversation ID or launch a duplicate worker to populate the board.
If adoption is unsupported, leave a visible draft with an honest outcome and continue helping from the current conversation.
Return the working board URL once the setup card is visible.

A successful claim verifies adoption, not fresh dispatch.
The guide distinguishes the optional read-only worker test from connecting this conversation.
Record separately whether the board, dispatch, messaging, and chosen opener were actually verified.
Don't mark an unavailable desktop backend as working by silently substituting a terminal worker.

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
