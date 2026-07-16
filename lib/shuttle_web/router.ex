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

    get("/workers/*fiber_id", WorkerController, :show)
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
    post("/reserve", ReserveController, :create)
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
    get("/agents", AgentsController, :show)
    get("/version", VersionController, :show)
    post("/fiber/create", FiberController, :create)
    get("/fiber/host", FiberHostController, :show)
    # Bake an astra.yaml to MyST mdast (owner-routed): the ASTRA paper render's
    # backend. Shells out to priv/mystra/bake.mjs on the owning host. JSON-native,
    # so it lives in the :api pipeline (unlike /file, which serves raw bytes).
    get("/astra", AstraController, :show)
    get("/felt-stores", FeltStoresController, :show)
    post("/felt-stores", FeltStoresController, :create)
    post("/cache/bust", CacheBustController, :create)
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
  end

  # The served frontend's bare-root document. Static assets are served by
  # `Plug.Static` in the endpoint (it skips `/`); this serves `index.html` so the
  # daemon hosts the board itself — one `shuttle` process, API + UI.
  scope "/", ShuttleWeb do
    get("/", SpaController, :index)
  end
end
