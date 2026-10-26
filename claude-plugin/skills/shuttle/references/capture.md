# Capture

A capture starts from the user's idea rather than an existing constitution: you turn it into a fiber, install and claim that fiber, then work it. `From User` is the current request; discuss scope with the user where it is unresolved. The launch gives you the owning felt store, the project directory, the install settings, and an exact claim endpoint and JSON body. If `From User` opens with `Meeting mode`, read [meeting.md](meeting.md) as well; it extends these steps.

1. **Crystallize.** Search for related fibers, choose the right parent, and file the idea with a lede and a Desired State proportionate to what the user actually asked. Keep its status `open`.
2. **Take up a role.** Choose the role that fits, or create one, and assign it with `shuttle role` ([roles.md](roles.md)); read its charter before you start the work.
3. **Install as a draft.** Run `shuttle install <fiber-id> --disabled` with the supplied model, surface, host and project directory, and apply any supplied effort or chrome setting with `shuttle set-agent`. Keep every field in `Install` exactly as given. `--disabled` holds the status at `open`; never install armed and reset the status afterward, because in that gap the poller can launch a second worker.
4. **Claim.** POST the supplied `Claim` JSON to the `Claim endpoint` with `Content-Type: application/json`, replacing only `<fiber id>` with your fiber. When the endpoint names a unix socket, send through it as given (`curl --unix-socket <path> http://localhost/...`). Build the JSON with a JSON library and pass it as a file or structured body, never by interpolating user text into shell quotes. Claim only after the install succeeded (the daemon refuses an uninstalled fiber with `not_installed`), and don't pipe setup commands through `tail` or the like, which hides their failures. Continue only on a successful claim: retry a lost response with the same body, and never activate after a rejection.
5. **Activate.** Run `shuttle resume <fiber-id>` only after the claim succeeds; activating sooner lets the poller launch a duplicate worker.
6. **Work it** by the worker loop and exits in the shuttle skill.

A Claude/Pi terminal claim names your `tmux_session` and, when supplied, your native `session_uuid`, and renames the terminal to the fiber's worker name.
A managed Codex claim names the exact conversation `session_uuid` and its presentation (`surface: cli` or `surface: app`); it renames no terminal.
Use the supplied body unchanged apart from the fiber id, never another conversation's id or a new App Server.
Exit verbs need no fiber or store — `shuttle handoff` to continue, `shuttle close` to stop — then end your turn. Never kill the shared App Server or a parent process to end the conversation.
