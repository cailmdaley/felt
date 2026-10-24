defmodule ShuttleWeb.TranscriptSearchController do
  @moduledoc """
  Agent-API endpoint:
  `GET /api/v1/transcripts/search?q=&session=&fiber=&since=&harness=&limit=`

  Full-text search over every Claude Code, Codex and Pi transcript on this
  host. The index and the ranking live in the CLI; this route runs
  `shuttle transcript search <q> --json --no-index` and relays its document unchanged:
  `{query, index, hits, errors}`.

  `session` is repeatable and `fiber` is a single id, `since` is `30d` or a date, `harness` is `claude|codex|pi`,
  `limit` is clamped to 100. Every value travels as its own argv element,
  and the query follows a `--` so one that begins with a dash is a query, not
  a flag.

  LOCAL HOST ONLY. There is no owner-routing and no remote fan-out: a remote
  daemon's transcripts are searched on that daemon. Widening this to the
  tunnel is a deliberate follow-up.

  A CLI failure is a JSON error, never a crash: 400 for a missing query or an
  invalid argument, 502 when the CLI fails or prints something that is not the
  contract, 504 when it outlives the bound. Indexing belongs to the background
  `Shuttle.TranscriptIndexer`; searches never start a corpus scan. The CLI's
  actionable missing-index message is preserved in the error detail.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  @default_limit 20
  @max_limit 100
  @harnesses ~w(claude codex pi)
  @timeout_ms 120_000

  def show(conn, params) do
    with {:ok, query} <- query_param(params),
         {:ok, flags} <- flags(params) do
      run(conn, query, flags)
    else
      {:error, message} -> conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp run(conn, query, flags) do
    args = ["transcript", "search", "--json", "--no-index"] ++ flags ++ ["--", query]

    case Shuttle.CLI.run(args, timeout_ms: @timeout_ms) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"hits" => hits} = doc} when is_list(hits) ->
            json(conn, doc)

          _ ->
            Logger.warning("GET /api/v1/transcripts/search: unexpected CLI output")
            fail(conn, 502, "shuttle transcript search printed no search document", output)
        end

      {:command_error, :timeout, _output} ->
        fail(conn, 504, "transcript search timed out", "")

      {:command_error, status, output} ->
        Logger.warning("GET /api/v1/transcripts/search: shuttle exited #{status}")
        fail(conn, 502, "shuttle transcript search exited #{status}", output)

      {:error, message} ->
        fail(conn, 502, message, "")
    end
  end

  defp fail(conn, status, message, detail) do
    conn
    |> put_status(status)
    |> json(%{error: message, detail: detail |> String.trim() |> String.slice(0, 2000)})
  end

  defp query_param(params) do
    case params |> Map.get("q", "") |> scalar() |> String.trim() do
      "" -> {:error, "q is required"}
      query -> {:ok, query}
    end
  end

  defp flags(params) do
    with {:ok, harness} <- harness_flag(params["harness"]) do
      sessions = params |> Map.get("session") |> List.wrap() |> Enum.map(&scalar/1)

      {:ok,
       Enum.flat_map(sessions, &value_flag("--session", &1)) ++
         value_flag("--fiber", scalar(params["fiber"])) ++
         value_flag("--since", scalar(params["since"])) ++
         harness ++
         ["--limit", Integer.to_string(limit(params["limit"]))]}
    end
  end

  defp harness_flag(value) do
    case scalar(value) do
      "" -> {:ok, []}
      h when h in @harnesses -> {:ok, ["--harness", h]}
      other -> {:error, "harness must be one of #{Enum.join(@harnesses, ", ")}, got #{other}"}
    end
  end

  defp value_flag(flag, value) do
    case String.trim(value) do
      "" -> []
      v -> [flag <> "=" <> v]
    end
  end

  defp limit(value) do
    case Integer.parse(scalar(value)) do
      {n, _} when n > 0 -> min(n, @max_limit)
      _ -> @default_limit
    end
  end

  # Query values arrive as strings, or as lists/maps when a client repeats or
  # nests a key; only the first string is meaningful for a scalar parameter.
  defp scalar(value) when is_binary(value), do: value
  defp scalar([first | _]), do: scalar(first)
  defp scalar(_), do: ""
end
