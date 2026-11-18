defmodule ShuttleWeb.BoardController do
  @moduledoc """
  The family board: this host's record feed, a family's composed records, and
  the fleet's per-thread marks, each reaching back `Shuttle.Board.retention_ms/0`.
  """
  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 3, json_with_validator: 3, bad_param: 2, rotating_file_tokens: 1]

  alias Shuttle.{Board, BoardFamily, CommitLedger, EventStream, Poller, RemoteTemporalRegistry}
  alias Shuttle.{SessionLedger, ThreadMarks}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def family(conn, params) do
    now = System.system_time(:millisecond)
    all? = params["all"] == "true"
    default = now - if(all?, do: 6, else: 24) * 3_600_000

    cond do
      not all? and params["fiber"] in [nil, ""] and params["session"] in [nil, ""] ->
        conn |> put_status(400) |> json(%{error: "fiber or session is required"})

      true ->
        with {:ok, since_ms} <- integer_param(params, "since_ms", default: default),
             {:ok, {entries, _, _}} <- thread_inputs() do
          host = Poller.own_host_id()
          sessions = BoardFamily.session_index(entries, host)

          case BoardFamily.prepare(entries, sessions, host, params) do
            nil ->
              json(conn, %{
                family: nil,
                viewer: nil,
                records: [],
                reach_ms: Board.retention_ms(),
                waiting: %{}
              })

            context ->
              reach = now - Board.retention_ms()
              since_ms = max(since_ms, reach)

              remote =
                RemoteTemporalRegistry.entries_nowait(:board)
                |> Map.values()
                |> Enum.flat_map(& &1.items)
                |> Enum.filter(&(is_integer(&1["received_at"]) and &1["received_at"] >= reach))

              local = Board.all_since(reach)

              records =
                Enum.filter(local, &(&1["timestamp"] >= since_ms)) ++
                  Enum.filter(remote, &(&1["received_at"] >= since_ms))

              json(
                conn,
                context
                |> BoardFamily.compose_prepared(records)
                |> Map.put(:reach_ms, Board.retention_ms())
                |> Map.put(:waiting, BoardFamily.waiting(local ++ remote))
              )
          end
        else
          {:error, {:bad_param, key}} -> bad_param(conn, key)
          {:error, reason} -> conn |> put_status(503) |> json(%{error: reason})
        end
    end
  end

  @doc """
  `GET /api/v1/board/marks` — every thread's launches and commits over the
  board's reach, from this host's session and commit ledgers and each remote's,
  joined by `Shuttle.ThreadMarks`:

      {"reach_ms": 1209600000,
       "marks": {"01KTS…": {"launches": [1786203000000], "commits": [1786203600000]}},
       "origins": {...}}

  The window starts on a minute boundary, so a repeat read within the minute is
  answered by its validator.
  """
  def marks(conn, _params) do
    reach = Board.retention_ms()
    minute = 60_000
    since_ms = div(System.system_time(:millisecond), minute) * minute - reach
    sessions = Composite.remote_entries(:sessions)
    commits = Composite.remote_entries(:commits)
    own = Shuttle.Poller.own_host_id()

    validator =
      {since_ms,
       Composite.validator(rotating_file_tokens(SessionLedger.default_path()), sessions),
       Composite.validator(rotating_file_tokens(CommitLedger.default_path()), commits)}

    json_with_validator(conn, validator, fn ->
      session_rows =
        SessionLedger.read_since(since_ms) ++
          Enum.flat_map(sessions, fn {_name, entry} ->
            Composite.in_window(entry.items, :at, since_ms, nil)
          end)

      commit_rows =
        Enum.map(CommitLedger.read_between(since_ms, nil), &Composite.stamp(&1, own)) ++
          Composite.remote_items(commits, :at, since_ms, nil)

      %{
        reach_ms: reach,
        marks:
          ThreadMarks.compose(session_rows, commit_rows, own, EventStream.session_bindings()),
        origins: Composite.origins(Map.merge(sessions, commits))
      }
    end)
  end

  @doc """
  `POST /api/v1/board/holdings` — appends what the installed board reports it
  holds, a JSON object, as one line of `<data dir>/tmp/board-holdings.jsonl`.
  The line's `time` is this host's local time to the second, as the sampled
  footprint of the board's page is stamped, so the two join on it.
  """
  def holdings(conn, _params) do
    path = Path.join([Shuttle.data_dir(), "tmp", "board-holdings.jsonl"])
    time = NaiveDateTime.to_iso8601(NaiveDateTime.local_now())
    line = Jason.encode!(Map.put(conn.body_params, "time", time)) <> "\n"

    with :ok <- Shuttle.FS.mkdir_p(Path.dirname(path)),
         :ok <- Shuttle.FS.write(path, line, [:append]) do
      json(conn, %{ok: true})
    else
      {:error, reason} -> conn |> put_status(500) |> json(%{error: inspect(reason)})
    end
  end

  defp thread_inputs do
    Poller.thread_inputs()
  catch
    :exit, _ -> {:error, :poller_unavailable}
  end

  def show(conn, params) do
    with {:ok, since_ms} <- integer_param(params, "since_ms", default: 0) do
      records = Board.all_since(since_ms)
      json_with_validator(conn, {since_ms, records}, fn -> %{records: records} end)
    else
      {:error, {:bad_param, key}} -> bad_param(conn, key)
    end
  end
end
