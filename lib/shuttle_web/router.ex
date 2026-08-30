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
    # Write-and-claim: register an externally-spawned live tmux session as a
    # fiber's running worker (capture sessions claim themselves here).
    post("/claim", ClaimController, :create)
    # Spawn-without-constitution: launch a capture session from a free-text
    # prompt; the session files the fiber and claims itself.
    post("/capture", CaptureController, :create)
    # The unified kanban write-plane: one call hides resolve + invoke +
    # owner-routing (local invoke, or forward to the owning remote daemon's
    # own /transition). Supersedes the kanban's prior two-leg resolve/invoke.
    post("/transition", TransitionController, :create)
    # Hard-kill a fiber's live worker (owner-routed). The kanban fires this when
    # a running card is dragged off the in-flight column; the column write follows.
    post("/kill", KillController, :create)
    # Open a worker's tmux session in kitty (the ▸ aloft / ☞ needs-you-now pill).
    # Deliberately NOT owner-routed: the terminal opens on the host serving the
    # UI (where the human is), ssh-ing out for a remote worker. See Shuttle.Kitty.
    post("/attach", AttachController, :create)
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
    get("/version", VersionController, :show)
    post("/fiber/create", FiberController, :create)
    # Bake an astra.yaml to MyST mdast (owner-routed): the ASTRA paper render's
    # backend. Shells out to priv/mystra/bake.mjs on the owning host. JSON-native,
    # so it lives in the :api pipeline (unlike /file, which serves raw bytes).
    get("/astra", AstraController, :show)
    # Cheap owner-routed file metadata for the board's live readers. The UI can
    # detect a changed or newly-created embed without downloading the artifact.
    get("/file-info", FileController, :info)
    get("/felt-stores", FeltStoresController, :show)
    post("/felt-stores", FeltStoresController, :create)
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
    # uid filter — the composite counterpart fans in each remote's cached feed
    # (Shuttle.RemoteTemporalRegistry) the same way /commits/composite does.
    get("/sent-files/all/composite", SentFilesController, :composite_all)
    get("/sent-files/all", SentFilesController, :show_all)
    # The temporal view's read plane, HOST-scoped rather than owner-routed
    # (see the controller): /activity buckets this host's events.jsonl per
    # minute. A cross-host view fans out and merges.
    get("/activity", ActivityController, :show)
    # The cross-host counterparts: each fans this host's live read together with
    # the cached remote reads (Shuttle.RemoteTemporalRegistry) and reports
    # per-origin freshness in the same `origins` block the kanban composite
    # serves. A disconnected remote's history stays on screen, marked stale.
    get("/activity/composite", ActivityController, :composite)
    get("/sessions/composite", SessionsController, :composite)
    # What the ledgered sessions cost, folded out of their transcripts and
    # rolled up per fiber. Host-scoped for the same reason as its neighbours —
    # a transcript lives on the machine that wrote it.
    get("/spend/composite", SpendController, :composite)
    get("/spend", SpendController, :show)
    # Join rung 0 for the temporal views: the structural fiber↔session pairing
    # this host recorded at dispatch / claim / resume. Host-scoped like its two
    # neighbours above.
    get("/sessions", SessionsController, :show)
    # Join rung 0 for commit narration: the commit↔session pairing the hook
    # recorded at commit time (~/.shuttle/commits.jsonl), the sole source for
    # the commit strip. Host-scoped like /sessions.
    get("/commits/composite", CommitsController, :composite)
    get("/commits", CommitsController, :show)
    # The words behind a minute: excerpts from a session's harness transcript,
    # for the temporal views' hover. HOST-routed rather than owner-routed — a
    # transcript lives on the machine that ran the session, named by `host` or
    # by this host's session ledger.
    get("/moment", MomentController, :show)
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
    get("/file", FileController, :show)
    # Exact native JSONL bytes. Kept outside the JSON pipeline like `/file` so
    # arbitrary harness bytes are relayed without content negotiation.
    get("/transcript/raw", TranscriptController, :raw)
  end

  # The served frontend's bare-root document. Static assets are served by
  # `Plug.Static` in the endpoint (it skips `/`); this serves `index.html` so the
  # daemon hosts the board itself — one `shuttle` process, API + UI.
  scope "/", ShuttleWeb do
    get("/", SpaController, :index)
  end
end
