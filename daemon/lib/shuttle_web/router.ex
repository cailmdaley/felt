defmodule ShuttleWeb.Router do
  @moduledoc """
  Router for the Shuttle Phoenix surface.

  Agent-API REST endpoints for worker coordination.
  """

  use Phoenix.Router

  pipeline :api do
    plug(:accepts, ["json"])
  end

  scope "/api/v1", ShuttleWeb do
    pipe_through(:api)

    post("/dispatch", DispatchController, :create)
    # Images pasted into the composer, written on the host owning the fiber
    # (owner-routed) so the directive can name their paths.
    post("/attachments", AttachmentsController, :create)
    # Write-and-claim: register an externally-spawned live tmux session as a
    # fiber's running worker (capture sessions claim themselves here).
    post("/claim", ClaimController, :create)
    # Spawn-without-constitution: launch a capture session from a free-text
    # prompt; the session files the fiber and claims itself.
    post("/capture", CaptureController, :create)
    # A recording starts for a new capture (/capture with `meeting`) or joins
    # an existing constitution (/meeting/join). Both record on THIS daemon's
    # audio; only the agent's half is owner-routed. Stop acts locally; GET
    # observes this daemon or the host named by its optional origin.
    post("/meeting/join", MeetingController, :join)
    post("/meeting/stop", MeetingController, :stop)
    get("/meeting", MeetingController, :show)
    # The unified kanban write-plane: one call hides resolve + invoke +
    # owner-routing (local invoke, or forward to the owning remote daemon's
    # own /transition).
    post("/transition", TransitionController, :create)
    # Hard-kill a fiber's live worker (owner-routed). The kanban fires this when
    # a running card is dragged off the in-flight column; the column write follows.
    post("/kill", KillController, :create)
    # Open a tmux session in kitty: a worker's (the ▸ aloft / ☞ needs-you-now pill), or
    # a past session's resume (a History row).
    # Deliberately NOT owner-routed: the terminal opens on the host serving the
    # UI (where the human is), ssh-ing out for a remote worker. See Shuttle.Kitty.
    post("/attach", AttachController, :create)
    # Start (or find) the tmux session resuming a past harness session on THIS
    # host — the leg /attach forwards to the host that ran it.
    post("/sessions/resume", SessionResumeController, :create)
    # Put a message in front of a fiber's worker (owner-routed): message a live
    # session, else resume or dispatch it with the message as From User.
    post("/deliver", DeliverController, :create)
    get("/peers", MessagingController, :peers)
    post("/messages", MessagingController, :create)
    post("/messages/files", MessagingController, :create_files)
    get("/state", StateController, :show)
    get("/state/composite", StateController, :composite)
    get("/fibers", FiberDocumentsController, :index)
    # Must precede the `/fibers/*id` wildcard, else "composite" resolves as a
    # fiber id. The unified cross-host board: local owner feed + cached remote
    # feeds, concatenated with reconciled per-host liveness.
    get("/fibers/composite", FiberDocumentsController, :composite)
    get("/fibers/*id", FiberDocumentsController, :show)
    post("/lifecycle", LifecycleController, :create)
    post("/felt-edit", FeltEditController, :create)
    post("/felt-nest", FeltNestController, :create)
    # Body search across the record, for the Chronicle's search bar. The board
    # matches names and ids client-side off the feed it already holds; only the
    # BODY of every constitution needs the daemon, which is what this shells
    # `felt ls --body --has-field shuttle -s all` for. Local stores only.
    get("/search", SearchController, :show)
    get("/agents", AgentsController, :show)
    # One agent's default-effort override, owner-routed; shells `shuttle
    # agents effort`, which stays the only writer of that grammar.
    post("/agents/effort", AgentsController, :effort)
    get("/version", VersionController, :show)
    post("/fiber/create", FiberController, :create)
    # Cheap owner-routed file metadata for the board's live readers. The UI can
    # detect a changed or newly-created embed without downloading the artifact.
    get("/file-info", FileController, :info)
    get("/felt-stores", FeltStoresController, :show)
    post("/felt-stores", FeltStoresController, :create)
    # The operator files as text, owner-routed: the settings page reads and
    # rewrites `stores/projects/agents/remotes.json` on whichever host owns
    # them. Reads are owner-routed too — a config file describes the daemon
    # that reads it, and only that daemon can see its own `~/.config/shuttle/`.
    get("/config", ConfigController, :index)
    get("/config/:id", ConfigController, :show)
    post("/config/:id", ConfigController, :create)
    # The fleet as rows: the normalized file joined to live reachability and
    # each remote's build. Its two write verbs shell the Go CLI, which stays
    # the fleet file's only writer.
    get("/fleet", FleetController, :show)
    post("/fleet/remotes", FleetController, :upsert)
    post("/tunnels", FleetController, :tunnels)
    # Register a directory as a picker-project on the host that owns it,
    # initializing its `.felt/` when it isn't a store yet. Owner-routed, since
    # only the owning daemon sees its own filesystem.
    post("/projects", ProjectsController, :create)
    # Native half of "+ Add project…": raises the owning host's own folder
    # dialog (Finder/zenity/kdialog) and answers with the chosen path. Blocks
    # for as long as the human takes. Only ever called for the LOCAL host — on
    # a remote (or a host with no dialog) the UI asks for the absolute path
    # instead and posts it straight to /projects.
    post("/choose-folder", ChooseFolderController, :create)
    # Pure-manual release of the boot quarantine: a restarted daemon parks
    # fresh autonomous launches (restart is not dispatch authority) until a
    # human posts here; dirty-death resumes were never withheld.
    post("/quarantine/release", QuarantineController, :create)
    # Pure-manual reset of a remote's tripped circuit breaker: after
    # trip_threshold failed revive cascades the RemoteRegistry stops taking
    # recovery actions until a probe succeeds or a human posts here
    # (`shuttle reset <remote>`). One reset buys exactly one cascade.
    post("/remotes/:name/reset", RemoteController, :reset)
    # The sent-files trail for a fiber (owner-routed): the artifacts a worker
    # pushed with SendUserFile on the card, read from the owning host's
    # events.jsonl hook stream. JSON-native, so it lives in the :api pipeline
    # (unlike /file, which serves raw bytes).
    get("/sent-files", SentFilesController, :show)
    # The global sent-files feed, HOST-scoped like /commits (not owner-routed):
    # every fiber's SendUserFile sends recorded on this host's events.jsonl, no
    # uid filter — the composite counterpart fans in each remote's feed
    # (Shuttle.RemoteTemporalRegistry) the same way /commits/composite does.
    get("/sent-files/all/composite", SentFilesController, :composite_all)
    get("/sent-files/all", SentFilesController, :show_all)
    # The temporal read plane, HOST-scoped rather than owner-routed (see the
    # controller): /activity buckets this host's events.jsonl per minute. A
    # cross-host view fans out and merges.
    get("/activity", ActivityController, :show)
    # The cross-host counterparts: each fans this host's live read together with
    # each remote's feed as Shuttle.RemoteTemporalRegistry holds it — fetched on
    # demand, behind a freshness gate — and reports per-origin freshness in the
    # same `origins` block the kanban composite serves. A disconnected remote's
    # history stays on screen, marked stale.
    get("/activity/composite", ActivityController, :composite)
    get("/sessions/composite", SessionsController, :composite)
    # Join rung 0 for the temporal views: the structural fiber↔session pairing
    # this host recorded at dispatch / claim / resume. Host-scoped like
    # /activity.
    get("/sessions", SessionsController, :show)
    # What the host that ran ledgered sessions knows of them — transcript present,
    # harness, a bridged Claude session's claude.ai URL — for the card's History.
    get("/sessions/links", SessionLinksController, :show)
    # Join rung 0 for commit narration: the commit↔session pairing the hook
    # recorded at commit time (~/.shuttle/commits.jsonl), the sole source for
    # the commit strip. Host-scoped like /sessions.
    get("/commits/composite", CommitsController, :composite)
    get("/commits", CommitsController, :show)
    # Native transcript provenance: JSON receipt, with host routing selected
    # from the session ledger or an explicit `host` query parameter.
    get("/transcript", TranscriptController, :show)
  end

  # File/asset bytes by absolute path (owner-routed). Unlocks `:::{embed}` +
  # relative images in the fiber panel and lets a remote-owned fiber's assets
  # render — only the owning daemon can read its own host's filesystem.
  #
  # Deliberately OUTSIDE the `:api` pipeline: this route returns arbitrary
  # content types (image/PDF/…), so the json `:accepts` plug would 406 a strict
  # `Accept: application/pdf` (a fetch() for an embedded artifact) before the
  # controller runs. The controller sets the response content-type itself and
  # renders its error bodies as JSON directly, so it needs no format negotiation.
  scope "/api/v1", ShuttleWeb do
    # Sandboxed reports resolve sibling resources under this owner/path prefix.
    # Raw asset bytes bypass JSON negotiation; this adds no CORS access for
    # opaque (`null`) origins.
    get("/file-assets/:origin/*path", FileController, :asset)
    get("/file", FileController, :show)
    # Exact native JSONL bytes. Kept outside the JSON pipeline like `/file` so
    # arbitrary harness bytes are relayed without content negotiation.
    get("/transcript/raw", TranscriptController, :raw)
    # The phone page's microphone, relayed into the live `phone` meeting's
    # hark socket. A WebSocket upgrade negotiates no JSON, so it stays outside
    # `:api` like the byte routes above.
    get("/meeting/audio", MeetingAudioController, :upgrade)
  end

  # The served frontend's bare-root document. Static assets are served by
  # `Plug.Static` in the endpoint (it skips `/`); this serves `index.html` so the
  # daemon hosts the board itself — one `shuttle` process, API + UI.
  scope "/", ShuttleWeb do
    get("/", SpaController, :index)
    # `/phone` redirects to the board root.
    get("/phone", SpaController, :phone)
  end
end
