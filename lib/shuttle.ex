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

  @impl true
  def start(_type, _args) do
    # In escript mode, Mix compile-time config (config/dev.exs) is not loaded
    # into the application environment automatically. Ensure the HTTP endpoint
    # has what it needs to bind. If the config is already present (Mix test /
    # Mix run context), this is a no-op.
    maybe_configure_endpoint()

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
      {Phoenix.PubSub, name: Shuttle.PubSub},
      {Task.Supervisor, name: Shuttle.TaskSupervisor},
      {DynamicSupervisor, strategy: :one_for_one, name: Shuttle.WatcherSupervisor}
    ]

    children =
      if Application.get_env(:shuttle, :start_remote_registry, true) do
        children ++ [Shuttle.RemoteRegistry]
      else
        children
      end

    children =
      if Application.get_env(:shuttle, :start_remote_fiber_registry, true) do
        children ++ [Shuttle.RemoteFiberRegistry]
      else
        children
      end

    children =
      if Application.get_env(:shuttle, :start_waiting_tracker, true) do
        children ++ [Shuttle.WaitingTracker]
      else
        children
      end

    children =
      if Application.get_env(:shuttle, :start_poller, true) do
        children ++ [Shuttle.Poller]
      else
        children
      end

    children =
      if Application.get_env(:shuttle, :start_endpoint, true) do
        children ++ [ShuttleWeb.Endpoint]
      else
        children
      end

    Supervisor.start_link(children, strategy: :one_for_one, name: Shuttle.Supervisor)
  end

  # Ensure the HTTP endpoint has its :http binding config.
  #
  # In escript mode the runtime application env doesn't have values from
  # config/dev.exs, so we seed them from the SHUTTLE_PORT env var (default 4000).
  # When running under Mix (tests, `mix run`), the env is already populated and
  # this is a no-op.
  # Ensure the HTTP endpoint has what it needs to bind.
  #
  # In the common case (dev.exs loaded in escript mode), config/dev.exs already
  # sets server: true. This fallback handles edge cases where config is absent
  # (e.g., custom environments, future release builds, test harness overrides).
  # The SHUTTLE_PORT env var overrides the port.
  defp maybe_configure_endpoint do
    existing = Application.get_env(:shuttle, ShuttleWeb.Endpoint, [])

    # Only patch when there is no explicit :server setting in the existing config.
    # If :server is set (to true or false), that is authoritative — test.exs sets
    # server: false and we must not override it. When dev.exs is loaded (server:
    # true, http: [...]), this is a no-op via the first branch too.
    if Keyword.has_key?(existing, :server) do
      :ok
    else
      port =
        existing
        |> Keyword.get(:http, [])
        |> Keyword.get(:port, System.get_env("SHUTTLE_PORT", "4000") |> String.to_integer())

      secret_key_base =
        Keyword.get(
          existing,
          :secret_key_base,
          System.get_env(
            "SHUTTLE_SECRET_KEY_BASE",
            "shuttlelocaldevkeybaseshuttlelocaldevkeybaseshuttlelocaldevkeybase"
          )
        )

      merged =
        Keyword.merge(existing,
          http: [ip: {127, 0, 0, 1}, port: port],
          adapter: Keyword.get(existing, :adapter, Bandit.PhoenixAdapter),
          pubsub_server: Shuttle.PubSub,
          url: Keyword.get(existing, :url, [host: "localhost"]),
          server: true,
          secret_key_base: secret_key_base
        )

      Application.put_env(:shuttle, ShuttleWeb.Endpoint, merged)
    end
  end
end
