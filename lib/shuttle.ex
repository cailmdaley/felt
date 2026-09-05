defmodule Shuttle do
  @moduledoc """
  Shuttle — OTP-supervised orchestrator for felt constitution workers.

  The daemon polls the felt tree, dispatches one tmux worker per eligible
  fiber, and serves a snapshot surface and agent-API for dashboards and other
  consumers. The supervision tree (`Shuttle.Application`) starts the poller,
  the per-worker watchers, the remote registries, and the HTTP endpoint.
  """

  @doc """
  The daemon's version — reported as `mix_vsn` by `GET /api/v1/version`.

  Single-sourced from `mix.exs`'s `version:`, which CI stamps with the release
  tag. Read from the OTP application spec, not from `Mix.Project`: a Mix
  release ships no Mix, so `Mix.Project.config/0` would raise in the artifact
  this function exists to identify. The `.app` file is generated from that same
  `version:` and travels inside the release, so the app spec is the one place
  the value is readable everywhere the daemon runs.
  """
  @spec version() :: String.t()
  def version do
    case Application.spec(:shuttle, :vsn) do
      vsn when is_list(vsn) -> List.to_string(vsn)
      # Only reachable if the :shuttle app isn't loaded — it always is under a
      # release, `mix test`, and `mix run`. Better an honest "unknown" than a
      # crash in the endpoint that reports build identity.
      _ -> "unknown"
    end
  end

  @doc """
  The daemon's host-local state directory: `$SHUTTLE_DATA_DIR`, else
  `~/.shuttle`.

  One resolver for every host-local file the daemon keeps — `sessions.jsonl`,
  `commits.jsonl`, `events.jsonl`, the remote caches. Per-file override env
  vars (`SHUTTLE_SESSIONS_FILE`, `SHUTTLE_COMMITS_FILE`,
  `SHUTTLE_EVENTS_FILE`) are consulted by their own modules *ahead* of this.
  """
  @spec data_dir() :: String.t()
  def data_dir do
    System.get_env("SHUTTLE_DATA_DIR") || Path.join(System.user_home!(), ".shuttle")
  end

  @doc """
  The port the local daemon's HTTP surface binds (and is reached on).

  `SHUTTLE_PORT` else 4000 — the same resolution
  `Shuttle.Application.configure_endpoint/0` uses to bind, read from the
  environment so it is answerable before (or without) the endpoint config.
  """
  @spec daemon_port() :: pos_integer()
  def daemon_port do
    case System.get_env("SHUTTLE_PORT") do
      value when is_binary(value) and value != "" -> String.to_integer(value)
      _ -> 4000
    end
  end
end

defmodule Shuttle.Application do
  @moduledoc """
  OTP application entrypoint.
  """

  use Application

  # Optional children, in start order. Each is gated by an app-config flag that
  # defaults to on; config/test.exs turns most of them off so the suite drives
  # them explicitly. Note that :start_waiting_tracker and
  # :start_remote_temporal_registry have no prod config entry at all — they ride
  # the inline `true` default. The endpoint is deliberately NOT in this list.
  @optional_children [
    {:start_remote_registry, Shuttle.RemoteRegistry},
    {:start_remote_fiber_registry, Shuttle.RemoteFiberRegistry},
    {:start_remote_temporal_registry, Shuttle.RemoteTemporalRegistry},
    {:start_waiting_tracker, Shuttle.WaitingTracker},
    {:start_poller, Shuttle.Poller}
  ]

  @impl true
  def start(_type, _args) do
    # A release bakes its compile-time config (config/prod.exs) into
    # releases/*/sys.config, EVALUATED on the build machine — so anything
    # decided there travels with the artifact to every host it lands on.
    # Resolve the endpoint's binding, server flag, and signing key here, at
    # runtime.
    configure_endpoint()

    # The time zone database, set again at runtime. In the escript era this
    # call was the only thing setting it — escript boot loaded no compile-time
    # config, so `config :elixir, :time_zone_database` (config/config.exs) never
    # arrived and DateTime.shift_zone/2 (cron scheduling) fell back to the
    # UTC-only DB. A release does carry that key in its sys.config, so the
    # config path now works too; the call stays because it costs nothing and
    # keeps `tz` wired on every boot path, config-loading or not.
    Calendar.put_time_zone_database(Tz.TimeZoneDatabase)

    # Boot stamp for /api/v1/version's `booted_at`. Load-bearing for deploy
    # verification: the release boots :interactive (nothing sets `-mode
    # embedded`), so modules load LAZILY from bin/rel/lib/*/ebin — a
    # not-yet-referenced module (Shuttle.BuildInfo) can load out of a freshly
    # rebuilt release while the long-booted Poller keeps running old code —
    # the compile-time git_sha then reports the NEW build from an OLD daemon.
    # Boot time can't lie that way: a deploy is only verified when git_sha
    # matches AND booted_at is newer than the deploy started.
    Application.put_env(:shuttle, :booted_at, DateTime.utc_now())

    children = [
      {Task.Supervisor, name: Shuttle.TaskSupervisor},
      {DynamicSupervisor, strategy: :one_for_one, name: Shuttle.WatcherSupervisor},
      # Owns the ETS table the per-session token folds are cached in. Pure
      # cache: a restart costs one re-read per session, never a wrong number.
      Shuttle.TokenSpend
    ]

    optional =
      for {flag, mod} <- @optional_children,
          Application.get_env(:shuttle, flag, true),
          do: mod

    # The endpoint is unconditional and last. The test env keeps it from
    # listening with `server: false` (config/test.exs), not by omitting the
    # child — the Phoenix.ConnTest modules need it in the tree.
    children = children ++ optional ++ [ShuttleWeb.Endpoint]

    Supervisor.start_link(children, strategy: :one_for_one, name: Shuttle.Supervisor)
  end

  # Resolve everything the HTTP endpoint needs to bind, at RUNTIME.
  #
  # A release bakes the EVALUATED compile-time config into the artifact
  # (config/prod.exs → releases/*/sys.config), so a value decided in a config
  # file travels to every host the tarball is unpacked on. Anything
  # machine-specific therefore has to be decided here instead — this function
  # is the daemon's runtime config layer, and it always runs.
  #
  # It used to early-return whenever `:server` was already set. Since the
  # daemon's own config (config/dev.exs then, config/prod.exs now) sets
  # `server: true`, that made the whole body dead in every daemon build (and
  # SHUTTLE_PORT dead with it). Each value now falls back individually, so an
  # explicitly-configured one still wins — config/test.exs's `server: false`
  # and port 4002 survive untouched.
  @doc false
  def configure_endpoint do
    existing = Application.get_env(:shuttle, ShuttleWeb.Endpoint, [])
    http = Keyword.get(existing, :http, [])

    port =
      case System.get_env("SHUTTLE_PORT") do
        value when is_binary(value) and value != "" -> String.to_integer(value)
        _ -> Keyword.get(http, :port, 4000)
      end

    merged =
      Keyword.merge(existing,
        http: Keyword.merge([ip: {127, 0, 0, 1}], Keyword.put(http, :port, port)),
        adapter: Keyword.get(existing, :adapter, Bandit.PhoenixAdapter),
        url: Keyword.get(existing, :url, host: "localhost"),
        server: Keyword.get(existing, :server, true),
        secret_key_base: secret_key_base(existing)
      )

    Application.put_env(:shuttle, ShuttleWeb.Endpoint, merged)
  end

  # The endpoint's signing key.
  #
  # Generated per boot when nothing supplies one. That is not a compromise, it
  # is the correct choice here: this endpoint is JSON-only, bound to 127.0.0.1,
  # with no Plug.Session, no cookies, and no LiveView — nothing signed by this
  # key needs to survive a restart. An ephemeral key is strictly safer than a
  # persisted one and needs no file, no permissions, and no migration. The
  # previous behavior shipped a fixed key as a source literal: inert today, a
  # real vulnerability the day anything signed appears.
  #
  # If signed state ever must outlive a restart, the upgrade is local to this
  # function: persist to ~/.config/felt/secret_key_base with 0600 on first boot.
  defp secret_key_base(existing) do
    Keyword.get(existing, :secret_key_base) ||
      System.get_env("SHUTTLE_SECRET_KEY_BASE") ||
      Base.encode64(:crypto.strong_rand_bytes(48))
  end
end
