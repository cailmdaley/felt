defmodule Shuttle.CodexApp do
  @moduledoc false

  alias Shuttle.CodexApp.Transport

  @client __MODULE__.Client

  def start_thread(opts \\ []) do
    with {:ok, project_id} <- ensure_project(opts),
         {:ok, client} <- client(),
         {:ok, result} <-
           Transport.request(
             client,
             "thread/start",
             Map.put(thread_options(opts), "projectId", project_id)
           ) do
      case thread_from(result) do
        {:ok, thread} -> {:ok, Map.put_new(thread, "projectId", project_id)}
        error -> error
      end
    end
  end

  def resume_thread(id, opts \\ []) do
    params = opts |> thread_options() |> Map.put("threadId", id)
    with_rpc("thread/resume", params, fn result -> thread_from(result, id) end)
  end

  def name_thread(id, name) when is_binary(id) and is_binary(name) do
    with {:ok, client} <- client(),
         {:ok, _result} <-
           Transport.request(
             client,
             "thread/name/set",
             %{"threadId" => id, "name" => name},
             2_000
           ),
         do: :ok
  end

  def read_thread(id, opts \\ []) do
    with_rpc(
      "thread/read",
      %{"threadId" => id, "includeTurns" => Keyword.get(opts, :include_turns, false)},
      &thread_from(&1, id)
    )
  end

  def start_turn(id, text, opts \\ []) when is_binary(text) do
    params =
      %{
        "threadId" => id,
        "input" => [%{"type" => "text", "text" => text}]
      }
      |> maybe_put("cwd", opts[:cwd])
      |> maybe_put("model", opts[:model])
      |> maybe_put("runtimeWorkspaceRoots", workspace_roots(opts))
      |> maybe_put("effort", opts[:effort])

    with_rpc("turn/start", params, fn
      %{"turn" => turn} when is_map(turn) -> {:ok, turn}
      _ -> {:error, {:transport, :malformed_turn_response}}
    end)
  end

  def interrupt(id, turn_id) when is_binary(id) and is_binary(turn_id) do
    with_rpc("turn/interrupt", %{"threadId" => id, "turnId" => turn_id}, fn _ -> :ok end)
  end

  def interrupt(id) when is_binary(id) do
    case read_thread(id, include_turns: true) do
      {:ok, %{"status" => %{"type" => "notLoaded"}}} ->
        resume_for_interrupt(id)

      {:ok, thread} ->
        interrupt_thread(id, thread)

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        resume_for_interrupt(id)

      {:error, _} = error ->
        error
    end
  end

  def state(id), do: thread_read_status(id).state

  @doc """
  The thread's ownership state and board phase. An idle thread whose spawned
  agents are still running is `"working"`, not `"waiting"`: the App Server
  marks the parent idle the moment its turn ends, while each spawned agent is
  its own loaded thread naming the parent in `parentThreadId` and staying
  `active` until it finishes. Only an idle thread with no active descendant
  is the human's move. When the children cannot be read, the thread stays
  `"waiting"`.
  """
  def status(id) do
    case thread_read_status(id) do
      %{phase: "waiting"} = status ->
        if live_descendants?(id), do: %{status | phase: "working"}, else: status

      status ->
        status
    end
  end

  defp thread_read_status(id) do
    result =
      with {:ok, client} <- client(),
           do:
             Transport.request(
               client,
               "thread/read",
               %{"threadId" => id, "includeTurns" => false},
               2_000
             )

    case result do
      {:ok, %{"thread" => thread}} ->
        thread_status(thread, id)

      {:ok, thread} ->
        thread_status(thread, id)

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        %{state: :not_loaded, phase: nil}

      {:error, _} ->
        %{state: :unknown, phase: nil}
    end
  end

  # Loaded threads are the only ones that can be running, so the scan reads
  # each loaded thread once and follows `parentThreadId` up from every active
  # one; a grandchild spawned by a child counts.
  defp live_descendants?(id) do
    deadline = System.monotonic_time(:millisecond) + 2_000

    with {:ok, client} <- client(),
         {:ok, ids} <- loaded_thread_ids(client, nil, [], MapSet.new(), deadline) do
      threads =
        for tid <- ids, tid != id, thread = loaded_thread(client, tid, deadline), do: thread

      parents = Map.new(threads, &{&1["id"], &1["parentThreadId"]})

      Enum.any?(threads, fn thread ->
        get_in(thread, ["status", "type"]) == "active" and
          descends_from?(thread["parentThreadId"], id, parents, MapSet.new())
      end)
    else
      _ -> false
    end
  end

  defp loaded_thread_ids(client, cursor, acc, seen, deadline) do
    params = if cursor, do: %{"cursor" => cursor}, else: %{}

    case child_request(client, "thread/loaded/list", params, deadline) do
      {:ok, %{"data" => ids} = page} when is_list(ids) ->
        acc = acc ++ Enum.filter(ids, &is_binary/1)

        case page["nextCursor"] do
          next when is_binary(next) and next != "" and next != cursor ->
            if MapSet.member?(seen, next),
              do: :error,
              else: loaded_thread_ids(client, next, acc, MapSet.put(seen, next), deadline)

          _ ->
            {:ok, acc}
        end

      _ ->
        :error
    end
  end

  defp loaded_thread(client, tid, deadline) do
    case child_request(
           client,
           "thread/read",
           %{"threadId" => tid, "includeTurns" => false},
           deadline
         ) do
      {:ok, %{"thread" => %{"id" => ^tid} = thread}} -> thread
      _ -> nil
    end
  end

  # One budget for the whole scan, not one timeout per loaded thread: a
  # busy App Server must not stall a worker's heartbeat for N RPC timeouts.
  defp child_request(client, method, params, deadline) do
    case deadline - System.monotonic_time(:millisecond) do
      remaining when remaining > 0 -> Transport.request(client, method, params, remaining)
      _ -> {:error, :timeout}
    end
  end

  defp descends_from?(parent, id, _parents, _seen) when parent == id, do: true

  defp descends_from?(parent, id, parents, seen) when is_binary(parent) do
    if MapSet.member?(seen, parent),
      do: false,
      else: descends_from?(Map.get(parents, parent), id, parents, MapSet.put(seen, parent))
  end

  defp descends_from?(_parent, _id, _parents, _seen), do: false

  defp with_rpc(method, params, mapper) do
    with {:ok, client} <- client(),
         {:ok, result} <- Transport.request(client, method, params),
         do: mapper.(result)
  end

  defp client do
    case Process.whereis(@client) do
      nil ->
        opts = Shuttle.Env.app(:codex_app_transport_opts, [])

        case Transport.start_link(Keyword.put(opts, :name, @client)) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, _reason} -> {:error, :app_server_unavailable}
        end

      pid ->
        {:ok, pid}
    end
  end

  defp thread_options(opts) do
    %{}
    |> maybe_put("cwd", opts[:cwd])
    |> maybe_put("model", opts[:model])
    |> maybe_put("runtimeWorkspaceRoots", workspace_roots(opts))
  end

  # The worker's checkout and the felt store it reports to.
  defp workspace_roots(opts) do
    roots = [opts[:cwd], opts[:felt_store]] |> Enum.filter(&is_binary/1) |> Enum.uniq()
    if roots == [], do: nil, else: roots
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp thread_from(%{"thread" => thread}) when is_map(thread), do: {:ok, thread}
  defp thread_from(_), do: {:error, {:transport, :malformed_response}}

  defp thread_from(%{"thread" => %{"id" => id} = thread}, id), do: {:ok, thread}

  defp thread_from(%{"thread" => %{"id" => _other}}, _expected_id),
    do: {:error, {:transport, :thread_identity_mismatch}}

  defp thread_from(_response, _id), do: {:error, {:transport, :malformed_response}}

  defp interrupt_thread(id, %{"turns" => turns} = thread) when is_list(turns) do
    case Enum.find(
           turns,
           &match?(
             %{"id" => turn_id, "status" => status}
             when is_binary(turn_id) and status in ["inProgress", "running"],
             &1
           )
         ) do
      %{"id" => turn_id} -> interrupt(id, turn_id)
      nil -> if(thread_state(thread) == :idle, do: :ok, else: {:error, :active_turn_unresolved})
    end
  end

  defp interrupt_thread(_id, _thread), do: {:error, {:transport, :malformed_thread_response}}

  defp resume_for_interrupt(id) do
    case resume_thread(id) do
      {:ok, thread} ->
        interrupt_thread(id, thread)

      {:error, {:peer, error}} = result ->
        if confirmed_missing?(error, id), do: {:error, :thread_missing}, else: result

      {:error, _} = error ->
        error
    end
  end

  defp thread_status(%{"id" => other}, expected) when other != expected,
    do: %{state: :unknown, phase: nil}

  defp thread_status(thread, _id) when is_map(thread) do
    phase =
      case thread["status"] do
        %{"type" => "idle"} ->
          "waiting"

        %{"type" => "systemError"} ->
          "attention"

        %{"type" => "active"} = status ->
          flags = List.wrap(status["activeFlags"])

          cond do
            "waitingOnApproval" in flags -> "attention"
            "waitingOnUserInput" in flags -> "attention"
            true -> "working"
          end

        _ ->
          nil
      end

    %{state: thread_state(thread), phase: phase}
  end

  defp thread_status(_, _), do: %{state: :unknown, phase: nil}

  defp thread_state(thread) do
    case get_in(thread, ["status", "type"]) do
      "active" -> :running
      "idle" -> :idle
      "notLoaded" -> :not_loaded
      "missing" -> :missing
      _ -> :unknown
    end
  end

  # The App Server project whose roots include the worker's cwd, created on
  # first use.
  defp ensure_project(opts) do
    cwd = opts[:cwd]

    if is_binary(cwd) and Path.type(cwd) == :absolute do
      cwd = Shuttle.Env.expand(cwd)

      case find_project(cwd, nil, MapSet.new()) do
        {:ok, id} -> {:ok, id}
        :missing -> create_project(cwd)
        {:error, _} = error -> error
      end
    else
      {:error, {:transport, :missing_absolute_cwd}}
    end
  end

  defp create_project(cwd) do
    key = :crypto.hash(:sha256, cwd) |> Base.encode16(case: :lower)

    params = %{
      "idempotencyKey" => "felt-shuttle-" <> key,
      "name" => Path.basename(cwd),
      "roots" => [%{"path" => cwd}]
    }

    with_rpc("project/create", params, fn
      %{"project" => %{"id" => id}} when is_binary(id) -> {:ok, id}
      _ -> {:error, {:transport, :malformed_project_response}}
    end)
  end

  defp find_project(cwd, cursor, seen) do
    params = %{"limit" => 100, "cursor" => cursor}

    with_rpc("project/list", params, fn response -> find_project_page(response, cwd, seen) end)
  end

  defp find_project_page(%{"data" => projects} = response, cwd, seen) when is_list(projects) do
    if Enum.all?(projects, &valid_project?/1) do
      case Enum.find(projects, fn project ->
             Enum.any?(project["roots"], &(&1["path"] == cwd))
           end) do
        %{"id" => id} ->
          {:ok, id}

        nil ->
          case response["nextCursor"] do
            next when is_binary(next) and next != "" ->
              if MapSet.member?(seen, next),
                do: {:error, {:transport, :invalid_project_pagination}},
                else: find_project(cwd, next, MapSet.put(seen, next))

            _ ->
              :missing
          end
      end
    else
      {:error, {:transport, :malformed_project_response}}
    end
  end

  defp find_project_page(_response, _cwd, _seen),
    do: {:error, {:transport, :malformed_project_response}}

  defp valid_project?(%{"id" => id, "roots" => roots}) when is_binary(id) and is_list(roots),
    do: Enum.all?(roots, &match?(%{"path" => path} when is_binary(path), &1))

  defp valid_project?(_), do: false

  defp confirmed_missing?(
         %{
           "code" => -32_600,
           "message" => "no rollout found for thread id " <> id
         },
         id
       ),
       do: true

  defp confirmed_missing?(_error, _id), do: false
end
