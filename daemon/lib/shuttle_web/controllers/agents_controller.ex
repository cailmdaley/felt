defmodule ShuttleWeb.AgentsController do
  @moduledoc """
  The agent registry over HTTP.

      GET  /api/v1/agents          the effective registry, as a JSON array
      POST /api/v1/agents/effort   set or clear one agent's default-effort override

  The read shells `felt shuttle agents --json` — felt owns the registry; the
  daemon embeds none of it. External consumers (the board's agent picker, the
  settings page) fetch this instead of reading any registry file off disk.

  felt unavailable / unparseable degrades to an empty array with a 200 rather
  than a 500: the picker tolerates an empty list (it falls back to a free-text
  agent name) and the rest of the board must keep loading.

  **Owner-routed via `Shuttle.OriginRouter`** on `?origin=`. The registry is a
  per-host fact — the built-in layer travels with that host's felt binary and
  the user layer is a file in its home — so "which agents can this host run"
  can only be answered by that host. Without an origin it is this daemon's own
  registry, which is every existing caller's question.

  ## Writing

  `POST /agents/effort` takes `{id, effort, origin?}` and shells `felt shuttle
  agents effort <id> <effort>`, or `--reset` when `effort` is null. felt is the
  only writer of the `overrides` grammar in `agents.json`; nothing here composes
  JSON. The write is owner-routed like the read, and answers the way the fleet
  verbs do: 200 `%{ok, host, output}` with felt's own line, 400 carrying felt's
  refusal verbatim (unknown agent, a level outside `effort_levels`), 503 when
  felt could not be run at all.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2, relay_json: 3]

  alias Shuttle.{OriginRouter, Poller}

  require Logger

  @cli_timeout_ms 15_000

  def show(conn, params) do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/agents", params))

      :local ->
        json(conn, list_agents())

      # A registry is a per-host fact, so an origin this daemon cannot place has
      # no answer here. Degrading would serve THIS host's agents under another
      # machine's name, which is worse than an error on a picker.
      {:error, {:unknown_origin, origin}} ->
        conn |> put_status(400) |> json(%{error: OriginRouter.unknown_origin_message(origin)})
    end
  end

  def effort(conn, %{"id" => id} = params) when is_binary(id) and id != "" do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_json(conn, OriginRouter.forward(remote, "/api/v1/agents/effort", params), fn name,
                                                                                           reason ->
          %{ok: false, error: "forward to #{name} failed: #{inspect(reason)}"}
        end)

      :local ->
        case Map.fetch(params, "effort") do
          {:ok, nil} ->
            run_cli(conn, ["shuttle", "agents", "effort", id, "--reset"])

          {:ok, level} when is_binary(level) and level != "" ->
            run_cli(conn, ["shuttle", "agents", "effort", id, level])

          _ ->
            bad_request(conn, "effort is required — a level, or null to reset")
        end

      {:error, {:unknown_origin, origin}} ->
        bad_request(conn, OriginRouter.unknown_origin_message(origin))
    end
  end

  def effort(conn, _params), do: bad_request(conn, "id is required")

  # felt refusing the request is a 400 in its own words; felt not being
  # runnable is a 503, because nothing the caller sent is wrong.
  defp run_cli(conn, args) do
    case Shuttle.Felt.run(args, timeout_ms: @cli_timeout_ms) do
      {:ok, output} ->
        json(conn, %{ok: true, host: Poller.own_host_id(), output: String.trim(output)})

      {:command_error, :timeout, _output} ->
        unavailable(
          conn,
          "felt did not answer within #{div(@cli_timeout_ms, 1000)}s on this host."
        )

      {:command_error, 127, _output} ->
        unavailable(conn, "felt is not on this daemon's PATH, so it cannot run that verb.")

      {:command_error, _status, output} ->
        bad_request(conn, String.trim(output))

      {:error, reason} ->
        unavailable(conn, "could not run felt: #{reason}")
    end
  end

  defp bad_request(conn, message) do
    conn |> put_status(400) |> json(%{ok: false, error: message})
  end

  defp unavailable(conn, message) do
    conn |> put_status(503) |> json(%{ok: false, error: message, unavailable: true})
  end

  defp list_agents do
    with {:ok, output} <- Shuttle.Felt.run(["shuttle", "agents", "--json"]),
         {:ok, records} when is_list(records) <- Jason.decode(output) do
      records
    else
      error ->
        Logger.warning("GET /api/v1/agents: felt shuttle agents failed: #{inspect(error)}")
        []
    end
  end
end
