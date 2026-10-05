defmodule Shuttle do
  @moduledoc """
  Shuttle — OTP-supervised orchestrator for felt constitution workers.

  The daemon polls the felt tree, dispatches one worker per eligible
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
  `~/.shuttle`. The variable is trimmed and a leading `~` or `~/` is expanded
  to the home directory; it is otherwise neither cleaned nor made absolute, so
  the socket-path checks in `Shuttle.Host` see what the operator wrote.

  One resolver for every host-local file the daemon keeps — `sessions.jsonl`,
  `commits.jsonl`, `events.jsonl`, the remote caches, the class-default
  socket. Per-file override env vars (`SHUTTLE_SESSIONS_FILE`,
  `SHUTTLE_COMMITS_FILE`, `SHUTTLE_EVENTS_FILE`) are consulted by their own
  modules *ahead* of this. The Go CLI's `shuttle.DataDir` applies the same
  rule; `test/fixtures/data_dir/cases.json` holds both to it.
  """
  @spec data_dir() :: String.t()
  def data_dir do
    case String.trim(System.get_env("SHUTTLE_DATA_DIR", "")) do
      "" -> Path.join(System.user_home!(), ".shuttle")
      "~" -> System.user_home!()
      "~/" <> rest -> System.user_home!() <> "/" <> rest
      dir -> dir
    end
  end

  @doc """
  One host-local state file: `$<env_var>` when it names a path — trimmed, a
  blank value counting as unset, and otherwise taken as written — else `leaf`
  under `data_dir/0`. The Go CLI's `shuttleStatePath` (internal/shuttlecli/events.go)
  applies the same rule; `test/fixtures/data_dir/cases.json` holds both to it.
  """
  @spec state_path(String.t(), String.t()) :: String.t()
  def state_path(env_var, leaf) do
    case String.trim(System.get_env(env_var, "")) do
      "" -> Path.join(data_dir(), leaf)
      path -> path
    end
  end

  @doc """
  The address the daemon's HTTP surface listens on, as `tcp://127.0.0.1:PORT`
  or `unix:///path` — see `Shuttle.Host` for the resolution rule.

  The value `Shuttle.Application.configure_endpoint/0` bound at boot when it
  has run, so a host.json edited under a live daemon does not make it report
  an address it is not on; otherwise resolved fresh.
  """
  @spec listen() :: String.t()
  def listen do
    case Application.get_env(:shuttle, :listen) do
      value when is_binary(value) -> value
      _ -> Shuttle.Host.listen()
    end
  end

  @doc """
  This host's class (`Shuttle.Host`), as bound at boot when
  `Shuttle.Application.configure_endpoint/0` has run, otherwise read fresh.

  Frozen for the same reason `listen/0` is: the class decides where the daemon
  listens, so a daemon that re-read it live could report a class it is not
  running under.
  """
  @spec host_class() :: Shuttle.Host.class()
  def host_class do
    case Application.get_env(:shuttle, :host_class) do
      class when class in [:single_user, :shared_multi_user, :exposed] -> class
      _ -> Shuttle.Host.class()
    end
  end
end

defmodule Shuttle.Application do
  @moduledoc """
  OTP application entrypoint.
  """

  use Application

  require Logger

  # Optional children, in start order. Each is gated by an app-config flag that
  # defaults to on here and is set nowhere else but config/test.exs, which turns
  # them off so the suite drives them explicitly. The endpoint starts before
  # these children so it binds before slow store, event-stream, follower seed,
  # or bridge initialization.
  @optional_children [
    {:start_tailnet_peers, Shuttle.TailnetPeers},
    {:start_tailnet_dial, Shuttle.TailnetDial},
    {:start_remote_registry, Shuttle.RemoteRegistry},
    {:start_remote_fiber_registry, Shuttle.RemoteFiberRegistry},
    {:start_remote_temporal_registry, Shuttle.RemoteTemporalRegistry},
    {:start_event_stream, Shuttle.EventStream},
    {:start_log_rotator, Shuttle.LogRotator},
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
    configure_log_level()

    # The time zone database, set again at runtime. A release carries
    # `config :elixir, :time_zone_database` (config/config.exs) in its
    # sys.config; this call keeps `tz` wired on every boot path, config-loading
    # or not, so DateTime.shift_zone/2 never falls back to the UTC-only DB.
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

    Shuttle.Readiness.begin_boot()

    # The host identity, resolved exactly once and before any child starts:
    # every caller — the endpoint's first requests, the Poller, the owned-feed
    # filter — reads this frozen value and none shells felt for it. A daemon
    # felt cannot name does not boot.
    Shuttle.Poller.freeze_daemon_host_id!()

    case Supervisor.start_link(child_specs(), strategy: :one_for_one, name: Shuttle.Supervisor) do
      {:ok, pid} ->
        duration_ms = Shuttle.Readiness.mark_ready()
        Logger.info("Shuttle ready after #{duration_ms}ms")
        {:ok, pid}

      other ->
        other
    end
  end

  @doc false
  def child_specs do
    core = [
      {Task.Supervisor, name: Shuttle.TaskSupervisor},
      {DynamicSupervisor, strategy: :one_for_one, name: Shuttle.WatcherSupervisor},
      Shuttle.Meeting.Control,
      # Owns the ETS table past sessions' bridge URLs are cached in, keyed on
      # each transcript's {mtime, size}. Pure cache: a restart costs one
      # re-read per session, never a wrong answer.
      Shuttle.SessionLink,
      # Owns the ETS table for the session-to-fiber peer index; ledger appends
      # invalidate it by file token without persistent_term global GC.
      Shuttle.Messaging.SessionFiberCache,
      # Owns the ETS table of large files' content digests, keyed on each
      # file version. Pure cache: a restart costs one re-read per file.
      ShuttleWeb.FileDigests,
      ShuttleWeb.PeerGateThrottle
    ]

    optional =
      for {flag, mod} <- @optional_children,
          Application.get_env(:shuttle, flag, true),
          do: optional_child(mod)

    # The endpoint binds before any synchronous child that may walk stores,
    # seed events.jsonl or reconcile Tailnet bridges. Its start callback logs
    # "listening" only after the adapter's listener has actually started.
    endpoint =
      Supervisor.child_spec(ShuttleWeb.Endpoint,
        start: {__MODULE__, :start_endpoint, []}
      )

    Enum.map(core, &Supervisor.child_spec(&1, [])) ++
      [endpoint] ++ Enum.map(optional, &Supervisor.child_spec(&1, []))
  end

  # The Poller takes the identity `start/2` froze rather than resolving its
  # own, so a supervisor restart of it keeps the same identity too.
  defp optional_child(Shuttle.Poller),
    do: {Shuttle.Poller, own_host_id: Shuttle.Poller.daemon_host_id()}

  defp optional_child(mod), do: mod

  # A graceful stop (SIGTERM → `init:stop/0`) calls this before any child is
  # terminated — the Poller does not trap exits, so its `terminate/2` never runs
  # — and this app stops first, being the last started. Touching the stop marker
  # here is what makes every asked-for restart (a deploy, `make stop`, a
  # supervisor restart) arm the next boot's quarantine; only a hard kill leaves
  # a heartbeat with no later marker for the next boot's
  # `Shuttle.DaemonHeartbeat` verdict. The stop scripts also touch the marker
  # before they signal, so a filesystem that stalls this touch cannot matter.
  @impl true
  def prep_stop(state) do
    Shuttle.DaemonHeartbeat.mark_stopped(Shuttle.DaemonHeartbeat.default_path())
    state
  end

  # The endpoint child invokes this immediately after Phoenix has successfully
  # started its listener, before any potentially slow optional child starts.
  @doc false
  def restrict_bound_socket do
    server? = Keyword.get(Application.get_env(:shuttle, ShuttleWeb.Endpoint, []), :server, true)

    case Application.get_env(:shuttle, :listen) do
      "unix://" <> path when server? -> Shuttle.Host.restrict_bound_socket!(path)
      _ -> :ok
    end
  end

  # The log level, from `SHUTTLE_LOG_LEVEL` when it is set. The release bakes
  # `level: :info` into its sys.config (config/prod.exs), so this is the only
  # way to make a production daemon log its requests without rebuilding. An
  # unknown value keeps the configured level and says so.
  @doc false
  def configure_log_level(value \\ System.get_env("SHUTTLE_LOG_LEVEL")) do
    wanted = value |> to_string() |> String.trim() |> String.downcase()
    levels = Logger.levels() ++ [:all, :none]

    case Enum.find(levels, &(Atom.to_string(&1) == wanted)) do
      nil when wanted == "" ->
        :ok

      nil ->
        Logger.warning(
          "SHUTTLE_LOG_LEVEL=#{inspect(value)} is not a log level " <>
            "(#{Enum.map_join(levels, ", ", &Atom.to_string/1)}); keeping #{Logger.level()}"
        )

      level ->
        Logger.configure(level: level)
    end
  end

  @doc false
  def start_endpoint do
    case ShuttleWeb.Endpoint.start_link() do
      {:ok, _pid} = started ->
        restrict_bound_socket()

        if Keyword.get(Application.get_env(:shuttle, ShuttleWeb.Endpoint, []), :server, true) do
          listen = Shuttle.listen()
          class = Shuttle.host_class()

          Logger.info(
            "Shuttle listening on #{listen} (host class #{Shuttle.Host.class_name(class)})"
          )
        end

        started

      other ->
        other
    end
  end

  # Resolve everything the HTTP endpoint needs to bind, at RUNTIME.
  #
  # A release bakes the EVALUATED compile-time config into the artifact
  # (config/prod.exs → releases/*/sys.config), so a value decided in a config
  # file travels to every host the tarball is unpacked on. Anything
  # machine-specific therefore has to be decided here instead — this function
  # is the daemon's runtime config layer, and it always runs.
  #
  # Each value falls back individually, so an explicitly-configured one still
  # wins — config/test.exs's `server: false` and port 4002 survive untouched.
  # The listen address itself comes from `Shuttle.Host`; the config's port is
  # only the lowest-ranked input to its single-user default.
  @doc false
  def configure_endpoint do
    if System.get_env("SHUTTLE_PEER_UID") do
      Logger.warning(
        "SHUTTLE_PEER_UID is set; it overrides the effective uid when shared TCP peer gating is active"
      )
    end

    existing = Application.get_env(:shuttle, ShuttleWeb.Endpoint, [])
    http = Keyword.get(existing, :http, [])
    server? = Keyword.get(existing, :server, true)

    %{class: class, listen: listen} = Shuttle.Host.resolve!(Keyword.get(http, :port, 4000))

    bind =
      case listen do
        {:tcp, ip, port} ->
          [ip: ip, port: port]

        # thousand_island requires port 0 alongside a `{:local, path}` ip.
        # The socket directory is only touched by a daemon that will bind it;
        # the test endpoint (`server: false`) must not create or unlink
        # anything under a developer's data dir.
        {:unix, path} ->
          bound_path = if server?, do: Shuttle.Host.prepare_unix_socket!(path), else: path
          [ip: {:local, bound_path}, port: 0]
      end

    listen_string = Shuttle.Host.format_listen(listen)

    {peer_gate, peer_gate_expected_uid, peer_gate_uid_source} =
      configure_peer_gate(class, listen, listen_string, server?)

    Application.put_env(:shuttle, :listen, listen_string)
    Application.put_env(:shuttle, :host_class, class)
    Application.put_env(:shuttle, :peer_gate, peer_gate)
    Application.put_env(:shuttle, :peer_gate_expected_uid, peer_gate_expected_uid)
    Application.put_env(:shuttle, :peer_gate_uid_source, peer_gate_uid_source)

    merged =
      Keyword.merge(existing,
        http: Keyword.merge(http, bind),
        adapter: Keyword.get(existing, :adapter, Bandit.PhoenixAdapter),
        url: Keyword.get(existing, :url, host: "localhost"),
        server: server?,
        secret_key_base: secret_key_base(existing)
      )

    Application.put_env(:shuttle, ShuttleWeb.Endpoint, merged)
  end

  defp configure_peer_gate(:exposed, {:tcp, _ip, _port}, listen_string, true) do
    raise ArgumentError,
          "refusing to listen on #{listen_string} for host class exposed: exposed hosts serve only the unix socket; the front proxy must dial the socket"
  end

  defp configure_peer_gate(:shared_multi_user, {:tcp, _ip, _port}, listen_string, true) do
    proc_root = Application.get_env(:shuttle, :proc_net_root, "/proc")

    unless Shuttle.ProcNetTcp.readable?(proc_root) do
      raise ArgumentError,
            "refusing to listen on #{listen_string} for host class shared-multi-user: " <>
              "uid peer gating requires readable /proc/net/tcp; drop the tcp:// listen so the " <>
              "class's unix socket is used, or declare the host single-user"
    end

    {uid, source} = Shuttle.Host.expected_peer_uid_config!()

    {"uid", uid, Atom.to_string(source)}
  end

  defp configure_peer_gate(_class, _listen, _listen_string, _server?), do: {"none", nil, nil}

  # The endpoint's signing key.
  #
  # Generated per boot when nothing supplies one. That is not a compromise, it
  # is the correct choice here: this endpoint is JSON-only, bound to 127.0.0.1,
  # with no Plug.Session, no cookies, and no LiveView — nothing signed by this
  # key needs to survive a restart. An ephemeral key is strictly safer than a
  # persisted one and needs no file, no permissions, and no migration — and,
  # unlike a key shipped as a source literal, is no vulnerability the day
  # anything signed appears.
  #
  # If signed state ever must outlive a restart, the upgrade is local to this
  # function: persist to ~/.config/shuttle/secret_key_base with 0600 on first boot.
  defp secret_key_base(existing) do
    Keyword.get(existing, :secret_key_base) ||
      System.get_env("SHUTTLE_SECRET_KEY_BASE") ||
      Base.encode64(:crypto.strong_rand_bytes(48))
  end
end
