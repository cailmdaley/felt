defmodule ShuttleWeb.FiberChangeController do
  @moduledoc """
  Bake a constitution's change on open, `POST /api/v1/fibers/<id>/change`, and
  list the PRs it follows, `GET /api/v1/changes/<id>`.

  The board's Change page posts here when it opens. The owning daemon shells
  `shuttle change <id> --cache --json [--pr N]`, which bakes the change the
  fiber's `shuttle.change` names (else its project's branch as it stands) into
  this host's cache, writing nothing in the felt store. The page then reads the
  bundle through the ordinary owner-routed `/file`.

  Body: `{ "origin"?: "...", "pr"?: N }`. Owner-routed via
  `Shuttle.OriginRouter` like `/file`: only the owner has the checkout, so a
  remote-owned fiber forwards to the owner's identical route and its answer is
  relayed verbatim.

  Answers 200 `{path, report}` with Shuttle's validation and coverage
  report; 422 `{error}` with Shuttle's one-line reason when the bake fails (not
  a Git repository, no base, a `gh` failure); 404 when the fiber is not on this
  host; 503 when Shuttle could not run.

  The GET shells `shuttle change <id> --list --json`, reading each PR in the
  fiber's `shuttle.change.prs` from GitHub without fetching or writing, and
  answers 200 `{prs: [...]}` in the order named; a PR gh cannot read carries its
  `error`. Its failures map as the bake's.

  Phoenix globs only end a route, so the bake's route is `POST /fibers/*id` and
  the last segment must be `change`.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_json: 2]

  alias Shuttle.{FeltStores, OriginRouter}
  alias ShuttleWeb.RelayHelpers

  @cli_timeout_ms 120_000

  def create(conn, %{"id" => segments} = params) when is_list(segments) do
    case Enum.split(segments, -1) do
      {[_ | _] = id, ["change"]} -> bake(conn, Enum.join(id, "/"), params)
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def index(conn, %{"id" => segments} = params) do
    id = Enum.join(segments, "/")

    case OriginRouter.route(Map.get(params, "origin")) do
      {:error, {:unknown_origin, origin}} ->
        RelayHelpers.unknown_origin(conn, origin)

      {:remote, remote} ->
        RelayHelpers.relay_bytes(
          conn,
          OriginRouter.forward_get(remote, list_path(id), %{},
            forward_timeout_ms: @cli_timeout_ms + 5_000
          )
        )

      :local ->
        with {:ok, %{store: store, fiber_id: address}} <- FeltStores.resolve_request(id),
             {:ok, output} <-
               Shuttle.CLI.run_in_store(store, ["change", address, "--list", "--json"],
                 timeout_ms: @cli_timeout_ms
               ),
             {:ok, prs} when is_list(prs) <- Jason.decode(output) do
          json(conn, %{prs: prs})
        else
          {:ok, _} ->
            error(conn, 502, "shuttle change --list answered without a list")

          {:error, %Jason.DecodeError{}} ->
            error(conn, 502, "shuttle change --list answered without a list")

          other ->
            respond(other, conn)
        end
    end
  end

  defp bake(conn, id, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:error, {:unknown_origin, origin}} ->
        RelayHelpers.unknown_origin(conn, origin)

      {:remote, remote} ->
        relay_json(
          conn,
          OriginRouter.forward(remote, change_path(id), Map.take(params, ["pr"]),
            forward_timeout_ms: @cli_timeout_ms + 5_000
          )
        )

      :local ->
        case pr_args(params["pr"]) do
          {:ok, pr} -> bake_local(conn, id, pr)
          {:error, reason} -> error(conn, 400, reason)
        end
    end
  end

  # One bake per fiber and PR at a time: a page reopened while its bake runs shares the run.
  defp bake_local(conn, id, pr) do
    Shuttle.SingleFlight.run({:change_bake, id, pr}, fn ->
      with {:ok, %{store: store, fiber_id: address}} <- FeltStores.resolve_request(id) do
        Shuttle.CLI.run_in_store(store, ["change", address, "--cache", "--json" | pr],
          timeout_ms: @cli_timeout_ms
        )
      end
    end)
    |> respond(conn)
  end

  defp change_path(id), do: "/api/v1/fibers/" <> encode(id) <> "/change"
  defp list_path(id), do: "/api/v1/changes/" <> encode(id)

  defp encode(id) do
    id
    |> String.split("/")
    |> Enum.map_join("/", &URI.encode(&1, fn c -> URI.char_unreserved?(c) end))
  end

  defp pr_args(nil), do: {:ok, []}
  defp pr_args(pr) when is_integer(pr) and pr > 0, do: {:ok, ["--pr", Integer.to_string(pr)]}

  defp pr_args(pr) when is_binary(pr) do
    case Integer.parse(pr) do
      {n, ""} -> pr_args(n)
      _ -> {:error, "pr must be a positive PR number"}
    end
  end

  defp pr_args(_), do: {:error, "pr must be a positive PR number"}

  defp respond({:ok, output}, conn) do
    case Jason.decode(output) do
      {:ok, %{"path" => path} = report} ->
        json(conn, %{path: path, report: report})

      _ ->
        conn |> put_status(502) |> json(%{error: "shuttle change answered without a bundle path"})
    end
  end

  defp respond({:command_error, :timeout, _output}, conn),
    do: error(conn, 503, "shuttle change did not finish within #{div(@cli_timeout_ms, 1000)}s")

  defp respond({:command_error, 127, _output}, conn),
    do: error(conn, 503, "shuttle is not on this daemon's PATH")

  defp respond({:command_error, _status, output}, conn), do: error(conn, 422, reason(output))
  defp respond({:error, :not_found, reason}, conn), do: error(conn, 404, reason)
  defp respond({:error, reason}, conn) when is_binary(reason), do: error(conn, 503, reason)
  defp respond({:error, _kind, reason}, conn), do: error(conn, 503, reason)

  # A refused story prints its JSON report before the error; the error is the reason.
  defp reason(output) do
    case String.split(output, "\n}\n") do
      [_report, error] -> String.trim(error)
      _ -> String.trim(output)
    end
  end

  defp error(conn, status, message), do: conn |> put_status(status) |> json(%{error: message})
end
