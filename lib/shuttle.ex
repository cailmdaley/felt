defmodule Shuttle do
  @moduledoc """
  Shuttle — OTP-supervised orchestrator for felt constitution workers.

  The daemon polls the felt tree, dispatches one tmux worker per eligible
  fiber, and serves a snapshot surface and agent-API for dashboards and other
  consumers. The supervision tree (`Shuttle.Application`) starts the poller,
  the per-worker watchers, the remote registries, and the HTTP endpoint.
  """

  @doc """
  Returns the current version.
  """
  @spec version() :: String.t()
  def version, do: "0.1.0"
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
    # In escript mode, Mix compile-time config (config/dev.exs) is not loaded
    # into the application environment automatically — and what IS baked in was
    # evaluated on the build machine. Resolve the endpoint's binding, server
    # flag, and signing key here, at runtime.
    configure_endpoint()

    # Same escript-config gap applies to the time zone database: the
    # `config :elixir, :time_zone_database` line in config/config.exs is not
    # loaded in the daemon escript, so DateTime.shift_zone/2 (cron scheduling)
    # would fall back to the UTC-only DB. Set it explicitly at runtime; this is
    # the load-bearing wiring for `tz` in the escript daemon.
    Calendar.put_time_zone_database(Tz.TimeZoneDatabase)

    # Boot stamp for /api/v1/version's `booted_at`. Load-bearing for deploy
    # verification: the escript loads modules LAZILY from the file on disk, so
    # a not-yet-referenced module (Shuttle.BuildInfo) can load from a freshly
    # deployed escript while the long-booted Poller keeps running old code —
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
  # `mix escript.build` bakes the EVALUATED compile-time config into the
  # artifact, so a value decided in config/dev.exs travels to every host that
  # escript is copied to. Anything machine-specific therefore has to be decided
  # here instead — this function is the daemon's runtime config layer, and it
  # always runs.
  #
  # It used to early-return whenever `:server` was already set. Since
  # config/dev.exs sets `server: true`, that made the whole body dead in every
  # escript build (and SHUTTLE_PORT dead with it). Each value now falls back
  # individually, so an explicitly-configured one still wins — config/test.exs's
  # `server: false` and port 4002 survive untouched.
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
