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
    with_rpc("thread/resume", params, fn result -> thread_from(result) end)
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
      &thread_from/1
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
      {:ok, thread} ->
        interrupt_thread(id, thread)

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        case resume_thread(id) do
          {:ok, thread} ->
            interrupt_thread(id, thread)

          {:error, {:peer, error}} = result ->
            if confirmed_missing?(error, id), do: {:error, :thread_missing}, else: result

          {:error, _} = error ->
            error
        end

      {:error, _} = error ->
        error
    end
  end

  def state(id) do
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
      {:ok, %{"thread" => thread}} -> thread_state(thread)
      {:ok, thread} -> thread_state(thread)
      {:error, _} -> :unknown
    end
  end

  defp with_rpc(method, params, mapper) do
    with {:ok, client} <- client(),
         {:ok, result} <- Transport.request(client, method, params),
         do: mapper.(result)
  end

  defp client do
    case Process.whereis(@client) do
      nil ->
        opts = Application.get_env(:shuttle, :codex_app_transport_opts, [])

        case Transport.start_link(Keyword.put(opts, :name, @client)) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, reason} -> {:error, {:transport, reason}}
        end

      pid ->
        {:ok, pid}
    end
  end

  defp thread_options(opts) do
    %{}
    |> maybe_put("cwd", opts[:cwd])
    |> maybe_put("model", opts[:model])
    |> maybe_put("approvalPolicy", opts[:approval_policy])
    |> maybe_put("approvalsReviewer", opts[:approvals_reviewer])
    |> maybe_put("runtimeWorkspaceRoots", workspace_roots(opts))
    |> maybe_put("serviceName", opts[:service_name])
  end

  defp workspace_roots(opts) do
    roots = [opts[:cwd], opts[:felt_store] | List.wrap(opts[:runtime_workspace_roots])]
    roots = roots |> Enum.filter(&is_binary/1) |> Enum.uniq()
    if roots == [], do: nil, else: roots
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp thread_from(%{"thread" => thread}) when is_map(thread), do: {:ok, thread}
  defp thread_from(_), do: {:error, {:transport, :malformed_response}}

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

  defp thread_state(thread) do
    case get_in(thread, ["status", "type"]) do
      "active" -> :running
      "idle" -> :idle
      "notLoaded" -> :unknown
      "missing" -> :missing
      _ -> :unknown
    end
  end

  defp ensure_project(opts) do
    case opts[:project_id] do
      id when is_binary(id) and id != "" ->
        {:ok, id}

      _ ->
        cwd = opts[:cwd]

        if is_binary(cwd) and Path.type(cwd) == :absolute do
          cwd = Path.expand(cwd)

          case find_project(cwd, nil, MapSet.new()) do
            {:ok, id} -> {:ok, id}
            :missing -> create_project(cwd)
            {:error, _} = error -> error
          end
        else
          {:error, {:transport, :missing_absolute_cwd}}
        end
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
