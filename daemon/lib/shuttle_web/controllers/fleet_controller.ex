defmodule ShuttleWeb.FleetController do
  @moduledoc """
  The fleet as one row per remote: how it is configured, whether it is
  answering, and what it is running.

      GET  /api/v1/fleet            the fleet file, normalized, joined to live health
      POST /api/v1/fleet/remotes    add, replace or remove one remote
      POST /api/v1/tunnels          install or preview this host's tunnel jobs

  Three facts about a remote come from three different places, and keeping them
  apart is the point of this endpoint:

    * **Configured** — `felt shuttle remotes list --json`, which reports the
      file *normalized*: defaults applied, `url` derived from `port`, the
      tunnel manager resolved against this host's supervisor. That is what the
      daemon and the CLI actually act on, and it differs from the file's own
      text often enough to be worth showing on its own.
    * **Reachable** — `Shuttle.RemoteRegistry`'s cached poll result: stale or
      fresh, when it last answered, the last error, and where the recovery
      cascade currently stands. Never a fresh probe fired by this request: a
      settings page must not be able to make the fleet look healthier by being
      opened.
    * **Running** — the remote's own build stamp, off the snapshot it already
      serves. So "which host is on which build" is answered here rather than by
      a `/version` round trip per host.

  A remote can be configured and unreachable, reachable and on a stale build,
  or configured and never polled at all. The row says which; it does not
  collapse three claims into one green dot.

  ## Writing

  **Nothing ever re-encodes the fleet file from a model.** `POST /fleet/remotes`
  shells `felt shuttle remotes add|rm` rather than composing JSON here, so the
  grammar the two readers have to agree on is never implemented a third time.
  (The other way the file can change is `POST /api/v1/config/remotes`, which
  writes the exact bytes a human typed and validates them by running that same
  CLI against a copy — so it is not a third author of the grammar either.)
  That has a consequence worth stating plainly, because it is the reason the
  settings page also offers the raw file: `remotes add` is **add-or-replace,
  wholesale**, and it has no flag for `enabled`, `auth`, `ssh_flags`,
  `tunnel.label` or the per-entry timeouts. Re-adding an entry that carries one
  of those drops it. The structured form is for the common shape; the file is
  for everything else, and `Shuttle.ConfigFiles` serves it.

  `POST /tunnels` shells `felt shuttle tunnels install` for the same reason,
  and its `preview` action is the CLI's own `--dry-run`: it reports what would
  be written and which orphaned jobs would be pruned, touching nothing.

  Every verb here is **owner-routed via `Shuttle.OriginRouter`** — a fleet file
  describes the host whose daemon reads it, and a tunnel job belongs to the
  supervisor of the machine it forwards from.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2, relay_json: 3]
  import ShuttleWeb.TemporalComposite, only: [format_dt: 1, render_error: 1]

  alias Shuttle.{ConfigFiles, Felt, OriginRouter, Poller, Remotes}

  @registry_timeout_ms 1_500
  @cli_timeout_ms 60_000
  # The forward must outlast the work it forwards. `OriginRouter`'s default is
  # 30s and the CLI on the far side is given 60s, so a tunnel install that took
  # 40s used to surface here as "forward failed" while the jobs were being
  # written — a page telling you a write did not land when it did. The margin
  # covers the far side's own bound plus a slow hop.
  @forward_timeout_ms 90_000

  # ── Read ─────────────────────────────────────────────────────────────────

  def show(conn, params) do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/fleet", params))

      :local ->
        json(conn, local_fleet())

      {:error, {:unknown_origin, origin}} ->
        bad_request(conn, OriginRouter.unknown_origin_message(origin))
    end
  end

  defp local_fleet do
    health = registry_health()

    base = %{
      host: Poller.own_host_id(),
      supervisor: supervisor(),
      file: ConfigFiles.summary(:remotes)
    }

    case normalized_fleet() do
      {:ok, doc} ->
        Map.merge(base, %{
          error: nil,
          launchd_label_prefix: Map.get(doc, "launchd_label_prefix"),
          defaults: Map.get(doc, "defaults") || %{},
          remotes: doc |> Map.get("remotes", []) |> Enum.map(&join_row(&1, health))
        })

      {:error, message} ->
        # The fleet file is unparseable. The daemon itself degrades to an empty
        # fleet here (`Shuttle.Remotes` never raises on a typo), so the honest
        # row set is empty — but the reason has to reach the screen, or the page
        # would render "no remotes configured" over a file full of them.
        Map.merge(base, %{
          error: message,
          launchd_label_prefix: nil,
          defaults: %{},
          remotes: []
        })
    end
  end

  # `felt shuttle remotes list --json` is the validator as well as the reader,
  # so a non-zero exit here IS the diagnostic — relayed verbatim rather than
  # summarized, exactly as a refused config write is.
  defp normalized_fleet do
    case Felt.run(["shuttle", "remotes", "list", "--json"], timeout_ms: 15_000) do
      {:ok, ""} -> {:ok, %{"remotes" => []}}
      {:ok, output} -> decode_fleet(output)
      {:command_error, _status, output} -> {:error, String.trim(output)}
      {:error, reason} -> {:error, "could not run felt: #{reason}"}
    end
  end

  defp decode_fleet(output) do
    case Jason.decode(output) do
      {:ok, %{} = doc} -> {:ok, doc}
      # A host with no fleet file prints nothing but an empty document; a bare
      # array is the file's other accepted shape and reaches us the same way.
      {:ok, list} when is_list(list) -> {:ok, %{"remotes" => list}}
      _ -> {:error, "felt shuttle remotes list returned something that is not a fleet document"}
    end
  end

  defp join_row(%{"name" => name} = entry, health) do
    polled = Map.get(health, name)

    entry
    |> Map.put("health", if(polled, do: render_health(polled), else: unpolled()))
    |> Map.put("build", build_of(polled))
    |> Map.put("tunnel_label", tunnel_label(entry))
  end

  defp join_row(entry, _health), do: entry

  # Only a MANAGED tunnel has a job, so only a managed tunnel gets a label. A
  # `manager: "none"` entry is reached directly — naming a launchd label for it
  # would invite the reader to look for a job that correctly does not exist.
  # `felt shuttle remotes list` normalizes the manager but leaves a generated
  # label implicit, so it is derived here the way the installer derives it.
  defp tunnel_label(entry) do
    tunnel = Map.get(entry, "tunnel") || %{}

    case {Map.get(tunnel, "manager"), Map.get(tunnel, "label")} do
      {manager, _} when manager in [nil, "none"] -> nil
      {_, label} when is_binary(label) and label != "" -> label
      _ -> Remotes.label_for(Map.get(entry, "name"))
    end
  end

  # A remote the registry has no row for at all: configured since the daemon
  # last reloaded, or reloading disabled in a test. "Never polled" is not the
  # same claim as "polled and stale", and the row says so.
  defp unpolled do
    %{stale: true, last_polled_at: nil, last_error: nil, recovery: nil, polled: false}
  end

  # The registry's rows as it holds them — raw, because two different things are
  # read off one entry: its reachability and the build stamp buried in the last
  # good snapshot. Rendering here would throw the second away.
  defp registry_health do
    Shuttle.RemoteRegistry.snapshots(Shuttle.RemoteRegistry, @registry_timeout_ms)
  catch
    :exit, _ -> %{}
  end

  defp render_health(%{} = entry) do
    %{
      polled: true,
      stale: Map.get(entry, :stale, true),
      last_polled_at: format_dt(Map.get(entry, :last_polled_at)),
      last_error: render_error(Map.get(entry, :last_error)),
      recovery: render_recovery(Map.get(entry, :recovery))
    }
  end

  defp render_recovery(%{} = recovery) do
    %{
      state: recovery |> Map.get(:state, :healthy) |> to_string(),
      attempt: Map.get(recovery, :attempt, 0),
      last_error: render_error(Map.get(recovery, :last_error))
    }
  end

  defp render_recovery(_), do: nil

  # The remote's own build stamp, if its last good snapshot carried one. An
  # older daemon has no `build` key, which is a fact about that host worth
  # rendering as "unknown" rather than as this host's own build.
  defp build_of(%{} = entry) do
    entry
    |> Map.get(:snapshot)
    |> case do
      %{"build" => %{} = build} -> build
      %{build: %{} = build} -> build
      _ -> nil
    end
  end

  defp build_of(_), do: nil

  defp supervisor do
    case :os.type() do
      {:unix, :darwin} -> "launchd"
      {:unix, _} -> "systemd"
      _ -> "none"
    end
  end

  # ── Write: one remote ────────────────────────────────────────────────────

  def upsert(conn, %{"name" => name} = params) when is_binary(name) and name != "" do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        forward(conn, remote, "/api/v1/fleet/remotes", params)

      :local ->
        if truthy(Map.get(params, "remove")) do
          run_cli(conn, ["shuttle", "remotes", "rm", name])
        else
          run_cli(conn, ["shuttle", "remotes", "add", name] ++ add_flags(params))
        end

      {:error, {:unknown_origin, origin}} ->
        bad_request(conn, OriginRouter.unknown_origin_message(origin))
    end
  end

  def upsert(conn, _params) do
    bad_request(conn, "name is required")
  end

  # Only the flags the caller actually set are passed. `remotes add` persists a
  # SPARSE entry — it validates a normalized copy but writes what it was given,
  # so the file stays portable between a Mac hub and a Linux one. Sending a
  # flag we invented a default for would write that default into the file and
  # take the portability away.
  defp add_flags(params) do
    [
      string_flag(params, "url", "--url"),
      string_flag(params, "ssh", "--ssh"),
      string_flag(params, "display", "--display"),
      string_flag(params, "checkout", "--checkout"),
      string_flag(params, "tunnel_manager", "--tunnel-manager"),
      int_flag(params, "port", "--port"),
      int_flag(params, "remote_port", "--remote-port"),
      string_flag(params, "remote_socket", "--remote-socket"),
      bool_flag(params, "multiplex", "--multiplex")
    ]
    |> List.flatten()
  end

  defp string_flag(params, key, flag) do
    case Map.get(params, key) do
      value when is_binary(value) and value != "" -> [flag, String.trim(value)]
      _ -> []
    end
  end

  defp int_flag(params, key, flag) do
    case Map.get(params, key) do
      value when is_integer(value) and value > 0 -> [flag, Integer.to_string(value)]
      value when is_binary(value) and value != "" -> int_flag_from_string(value, flag)
      _ -> []
    end
  end

  defp int_flag_from_string(value, flag) do
    case Integer.parse(String.trim(value)) do
      {int, ""} when int > 0 -> [flag, Integer.to_string(int)]
      _ -> []
    end
  end

  defp bool_flag(params, key, flag) do
    if truthy(Map.get(params, key)), do: [flag], else: []
  end

  defp truthy(true), do: true
  defp truthy("true"), do: true
  defp truthy(_), do: false

  # ── Write: the tunnel jobs ───────────────────────────────────────────────

  def tunnels(conn, params) do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        forward(conn, remote, "/api/v1/tunnels", params)

      {:error, {:unknown_origin, origin}} ->
        bad_request(conn, OriginRouter.unknown_origin_message(origin))

      :local ->
        name = Map.get(params, "name")
        named = if is_binary(name) and name != "", do: [String.trim(name)], else: []

        case Map.get(params, "action", "preview") do
          "preview" ->
            run_cli(conn, ["shuttle", "tunnels", "install"] ++ named ++ ["--dry-run"])

          "install" ->
            run_cli(conn, ["shuttle", "tunnels", "install"] ++ named)

          other ->
            bad_request(conn, "unknown action #{inspect(other)} (known: preview, install)")
        end
    end
  end

  # ── Shared ───────────────────────────────────────────────────────────────

  # felt's own stdout is the answer. These verbs report what they did in lines
  # a human reads ("would install hub-a -> …"), and there is nothing this
  # controller could add by restating them as a structure.
  defp run_cli(conn, args) do
    case Felt.run(args, timeout_ms: @cli_timeout_ms) do
      {:ok, output} ->
        json(conn, %{ok: true, host: Poller.own_host_id(), output: String.trim(output)})

      # Same distinction the config plane makes: felt refusing the request is a
      # 400, felt not being runnable is a 503. A wedged CLI reported as "your
      # request was bad" sends someone to fix a correct one; and a timeout is
      # never evidence of absence — `remotes add` may well have landed.
      {:command_error, :timeout, _output} ->
        unavailable(
          conn,
          "felt did not answer within #{div(@cli_timeout_ms, 1000)}s on this host. " <>
            "It may or may not have finished — re-read the fleet before retrying."
        )

      {:command_error, 127, _output} ->
        unavailable(conn, "felt is not on this daemon's PATH, so it cannot run that verb.")

      {:command_error, _status, output} ->
        bad_request(conn, String.trim(output))

      {:error, reason} ->
        unavailable(conn, "could not run felt: #{reason}")
    end
  end

  defp forward(conn, remote, path, params) do
    relay_json(
      conn,
      OriginRouter.forward(remote, path, params, forward_timeout_ms: @forward_timeout_ms),
      fn name, reason ->
        %{ok: false, error: "forward to #{name} failed: #{inspect(reason)}"}
      end
    )
  end

  defp unavailable(conn, message) do
    conn |> put_status(503) |> json(%{ok: false, error: message, unavailable: true})
  end

  defp bad_request(conn, message) do
    conn |> put_status(400) |> json(%{ok: false, error: message})
  end
end
