# Capture

A capture starts from the user's idea rather than an existing constitution. Read
`From User` as the current request; discuss unresolved scope when needed. The
launch supplies the owning felt store, project directory, install metadata, and
an exact claim endpoint and JSON body.

When `From User` opens with `Meeting mode`, the input is a live meeting
transcript: read [meeting.md](meeting.md) too. It extends these steps.

1. **Crystallize.** Search for related fibers, choose the right parent, and file
   the idea with a lede and Desired State proportionate to what the user has
   actually asked. Keep its status `open`.
2. **Assign a role.** Find the charter under `roles/` that fits the work, or
   create one when none does, and assign it with yourself as collaborator:
   `felt shuttle assign <fiber-id> --role <role> --collaborator <your-model>`.
   Read the charter before realizing; its playbooks and gates shape the work.
3. **Install as a draft.** Use `felt shuttle install <fiber-id> --disabled`
   with the supplied model, surface, host and project directory; apply any
   supplied effort or chrome setting with `felt shuttle set-agent`. Preserve
   every field in `Install` exactly. `--disabled` keeps status `open` throughout
   installation. Never install armed and reset status afterward: that gap lets
   the poller launch another worker before you claim this session.
4. **Claim.** POST the supplied `Claim` JSON to `Claim endpoint` with
   `Content-Type: application/json`, replacing only `<fiber id>` with the fiber
   you created. When the endpoint names a unix socket, send the request through
   it exactly as given (`curl --unix-socket <path> http://localhost/...`). Encode JSON with a JSON library and pass it as a file or structured
   request body; do not interpolate user input into shell quoting. Require a
   successful claim before continuing. A lost response can be retried with the
   same body; a rejection must not be followed by activation.
5. **Activate.** Set status `active` only after the successful claim. Activating
   sooner permits the poller to launch a duplicate worker.
6. **Realize.** Follow the worker loop and exit semantics in the shuttle skill.

A terminal claim identifies `tmux_session` and, when supplied, the native
`session_uuid`. Successful claim renames that terminal to the fiber's worker
name. An app claim identifies `surface: app` and the exact conversation
`session_uuid`; it does not rename or replace the conversation. Never substitute
a terminal claim, another conversation ID, or a new app server. App workers end
their turn after the exit write — `felt shuttle handoff` to continue, or
`status: closed` to stop — and never kill the shared backend or a parent
process either way.
