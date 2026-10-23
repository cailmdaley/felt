defmodule Shuttle.AppWorkers do
  @moduledoc """
  Durable ownership of Codex app conversations launched by this daemon.

  `session_uuid` is the continuation identity used by Shuttle, equal to
  `thread_id` for app workers. `transcript_session_uuid` names the native
  transcript, which may differ for a fork. Backend operations always address
  the thread; transcript and activity joins use the native transcript id.

  A conversation survives its turns and daemon restarts. Its ownership record
  remains active while it waits for a phone reply; only an explicit stop or
  completed handoff releases it. Captures are recorded before their first turn
  and can subsequently be claimed by exactly one fiber.

  `backend_host` and `backend_endpoint` pin the owner on both surfaces. Native
  Go messaging reads only those two fields from this private JSON projection;
  it never writes records. Missing owner evidence requires explicit operator
  repair, never automatic binding to the current host or socket. Shared
  `app_worker_owners.json` fixtures enforce the reader contract.
  """

  def client, do: Shuttle.Env.app(:codex_app_client, Shuttle.CodexApp)

  @doc "Checks the recorded App Server owner before any native operation on an owned thread."
  def check_endpoint(id) when is_binary(id) do
    with {:ok, record} <- get(id), do: check_endpoint(record)
  end

  def check_endpoint(record) when is_map(record),
    do:
      check_owner(
        record,
        Shuttle.Poller.own_host_id(),
        Shuttle.CodexApp.Transport.default_socket()
      )

  def check_endpoint(_), do: {:error, :ownership_record_unreadable}

  @doc "Read-only owner projection shared with native messaging through app_worker_owners.json fixtures."
  def check_owner(record, host, endpoint) when is_map(record) do
    with :ok <- check_owner_host(record, host), do: check_owner_endpoint(record, endpoint)
  end

  def check_owner(_, _, _), do: {:error, :ownership_record_unreadable}

  defp check_owner_host(record, current_host) do
    case record["backend_host"] do
      host when is_binary(host) and host != "" ->
        if host == current_host, do: :ok, else: {:error, :app_host_changed}

      _ ->
        {:error, :app_host_unrecorded}
    end
  end

  defp check_owner_endpoint(record, current_endpoint) do
    case record["backend_endpoint"] do
      endpoint when is_binary(endpoint) and endpoint != "" ->
        if endpoint == current_endpoint, do: :ok, else: {:error, :app_endpoint_changed}

      _ ->
        # No endpoint means no evidence of the conversation owner. Keep the
        # record and assignment; an operator must repair it explicitly.
        {:error, :app_endpoint_unrecorded}
    end
  end

  def check_known_endpoint(id) do
    case get(id) do
      {:ok, record} ->
        check_endpoint(record)

      {:error, :not_found} ->
        case File.lstat(record_path(id)) do
          {:error, :enoent} -> :ok
          _ -> {:error, :ownership_record_unreadable}
        end
    end
  end

  def call(id, operation, args \\ []) do
    with :ok <- check_endpoint(id), do: apply(client(), operation, [id | args])
  end

  def status(id) do
    case call(id, :status) do
      %{state: _, phase: _} = status ->
        status

      {:error, reason} ->
        update(id, %{"backend_error" => inspect(reason)})
        %{state: :unknown, phase: nil}
    end
  end

  def state(id) do
    case call(id, :state) do
      {:error, _} -> :unknown
      state -> state
    end
  end

  def ref(id), do: "codex-app:" <> id
  def id("codex-app:" <> id), do: id
  def id(_), do: nil
  def app?(session), do: is_binary(id(session))

  def transcript_id(thread_id) do
    case get(thread_id) do
      {:ok, record} -> record["transcript_session_uuid"] || thread_id
      _ -> thread_id
    end
  end

  def root do
    Shuttle.Env.app(:app_workers_dir, Path.join(Shuttle.data_dir(), "app-workers"))
  end

  def get(id) when is_binary(id) do
    with true <- Regex.match?(~r/^[A-Za-z0-9_-]+$/, id),
         {:ok, bytes} <- File.read(Path.join(root(), id <> ".json")),
         {:ok, record} <- Jason.decode(bytes) do
      {:ok, record}
    else
      _ -> {:error, :not_found}
    end
  end

  def put(%{"session_uuid" => id} = record) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/, id) do
      path = Path.join(root(), id <> ".json")
      tmp = path <> ".#{System.unique_integer([:positive])}.tmp"

      with :ok <- File.mkdir_p(root()),
           :ok <- File.chmod(root(), 0o700),
           :ok <- File.write(tmp, "", [:exclusive]),
           :ok <- File.chmod(tmp, 0o600),
           :ok <- File.write(tmp, Jason.encode!(record)),
           :ok <- File.rename(tmp, path) do
        :ok
      else
        error ->
          File.rm(tmp)
          error
      end
    else
      {:error, :invalid_session_id}
    end
  end

  def active do
    Path.wildcard(Path.join(root(), "*.json"))
    |> Enum.flat_map(fn path ->
      case File.read(path) do
        {:ok, bytes} ->
          case Jason.decode(bytes) do
            {:ok, %{"active" => true} = record} -> [record]
            _ -> []
          end

        _ ->
          []
      end
    end)
  end

  def for_fiber(fiber_id, uid \\ nil) do
    Enum.find(active(), fn record ->
      same_fiber?(record, fiber_id, uid)
    end)
  end

  def update(id, values) do
    :global.trans({{__MODULE__, id}, self()}, fn ->
      with {:ok, record} <- get(id), do: put(Map.merge(record, values))
    end)
  end

  def start_turn(id, prompt, opts) do
    with :ok <- check_endpoint(id),
         :ok <- update(id, %{"launch_state" => "starting", "pending_prompt" => prompt}) do
      result =
        with {:ok, turn} <- call(id, :start_turn, [prompt, opts]),
             do: Shuttle.CodexApp.validate_started_turn(turn)

      case result do
        {:ok, turn} = result ->
          :ok =
            update(id, %{
              "launch_state" => "running",
              "pending_prompt" => nil,
              "last_error" => nil,
              "turn_id" => turn["id"]
            })

          result

        {:error, reason} ->
          :ok = update(id, %{"launch_state" => "blocked", "last_error" => inspect(reason)})
          {:error, {:app_launch_failed, id, reason}}
      end
    end
  end

  def reserve_resume(id, fiber_id, uid, store) do
    :global.trans({{__MODULE__, id}, self()}, fn ->
      with {:ok, record} <- get(id),
           :ok <- check_endpoint(record),
           true <- same_fiber?(record, fiber_id, uid) and record["felt_store"] == store,
           false <- record["active"] == true,
           :ok <- put(Map.merge(record, %{"active" => true, "launch_state" => "starting"})) do
        :ok
      else
        true -> {:error, :already_running}
        false -> {:error, :session_owner_mismatch}
        error -> error
      end
    end)
  end

  @doc "Reloads a durably owned app thread only when the native server confirms it is not loaded."
  def recover(id, fiber_id, uid, store) do
    :global.trans({{__MODULE__, id}, self()}, fn ->
      with true <- valid_id?(id),
           true <- nonempty?(fiber_id) and nonempty?(store) and valid_optional_uid?(uid),
           {:ok, record} <- get(id),
           true <- owned_by?(record, id, fiber_id, uid, store),
           :ok <- check_endpoint(record),
           {:ok, thread} <- native_thread_before_recovery(id),
           result <- reload_if_not_loaded(id, thread) do
        result
      else
        false -> {:error, :session_owner_mismatch}
        {:error, _} = error -> error
        _ -> {:error, :session_owner_mismatch}
      end
    end)
  end

  defp owned_by?(record, id, fiber_id, uid, store) when is_map(record) do
    record["active"] == true and record["session_uuid"] == id and
      record["thread_id"] == id and record["felt_store"] == store and
      same_fiber?(record, fiber_id, uid) and
      is_binary(uid) == is_binary(record["uid"])
  end

  defp owned_by?(_record, _id, _fiber_id, _uid, _store), do: false

  defp native_thread_before_recovery(id) do
    case call(id, :read_thread) do
      {:ok, %{"id" => ^id, "status" => %{"type" => type}} = thread}
      when type in ["active", "idle", "notLoaded"] ->
        {:ok, thread}

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        {:ok, %{"id" => id, "status" => %{"type" => "notLoaded"}}}

      {:ok, _} ->
        {:error, :native_thread_unverified}

      {:error, _} = error ->
        error

      _ ->
        {:error, :native_thread_unverified}
    end
  end

  defp reload_if_not_loaded(_id, %{"status" => %{"type" => type}})
       when type in ["active", "idle"],
       do: :ok

  defp reload_if_not_loaded(id, %{"status" => %{"type" => "notLoaded"}}) do
    case call(id, :resume_thread, [[]]) do
      {:ok, %{"id" => ^id, "status" => %{"type" => type}}}
      when type in ["active", "idle"] ->
        :ok

      {:ok, _} ->
        {:error, :native_thread_unverified}

      {:error, _} = error ->
        error

      _ ->
        {:error, :native_thread_unverified}
    end
  end

  defp reload_if_not_loaded(_id, _thread), do: {:error, :native_thread_unverified}

  defp nonempty?(value), do: is_binary(value) and value != ""
  defp valid_optional_uid?(nil), do: true
  defp valid_optional_uid?(uid), do: nonempty?(uid)

  def deactivate(id) do
    update(id, %{"active" => false})
  end

  def claim(id, fiber, store) do
    :global.trans({{__MODULE__, id}, self()}, fn -> do_claim(id, fiber, store) end)
  end

  @doc """
  Claims an app conversation already known to Shuttle, or adopts a conversation
  verified by the connected native App Server.

  Adoption reads the exact thread before it writes ownership. It never resumes
  the thread or starts a turn: a conversation already working keeps its turn.
  The record creation and any competing claim share the thread lock, so one
  fiber remains the sole owner.
  """
  def claim_or_adopt(id, fiber, store, opts \\ []) do
    if valid_id?(id) do
      case claim(id, fiber, store) do
        {:error, :not_found} -> adopt(id, fiber, store, opts)
        result -> result
      end
    else
      {:error, :invalid_session_id}
    end
  end

  defp adopt(id, fiber, store, opts) do
    with {:ok, %{"id" => ^id} = thread} <- client().read_thread(id),
         true <- get_in(thread, ["status", "type"]) in ["active", "idle"] do
      :global.trans({{__MODULE__, id}, self()}, fn ->
        case get(id) do
          {:ok, _record} ->
            do_claim(id, fiber, store)

          {:error, :not_found} ->
            # `get/1` deliberately does not disclose a malformed private
            # record as a different public read result. Adoption needs the
            # stronger answer: only an absent path may become a new owner.
            case File.lstat(record_path(id)) do
              {:error, :enoent} ->
                put(%{
                  "session_uuid" => id,
                  "thread_id" => id,
                  "transcript_session_uuid" => thread["sessionId"] || id,
                  "project_id" => thread["projectId"],
                  "backend_host" => Shuttle.Poller.own_host_id(),
                  "backend_endpoint" => Shuttle.CodexApp.Transport.default_socket(),
                  "cwd" => thread["cwd"],
                  "fiber_id" => fiber["id"],
                  "uid" => fiber["uid"],
                  "felt_store" => store,
                  "agent_id" => Keyword.get(opts, :agent_id),
                  "active" => true,
                  "launch_state" => "running",
                  "started_at" => DateTime.to_iso8601(DateTime.utc_now())
                })

              _ ->
                {:error, :ownership_record_unreadable}
            end
        end
      end)
    else
      false -> {:error, :native_thread_unverified}
      _ -> {:error, :native_thread_unverified}
    end
  end

  defp do_claim(id, fiber, store) do
    with {:ok, record} <- get(id),
         :ok <- check_endpoint(record),
         true <- record["active"] == true,
         true <-
           is_nil(record["fiber_id"]) or
             (same_fiber?(record, fiber["id"], fiber["uid"]) and
                record["felt_store"] in [nil, store]),
         :ok <-
           put(
             Map.merge(record, %{
               "fiber_id" => fiber["id"],
               "uid" => fiber["uid"],
               "felt_store" => store
             })
           ) do
      :ok
    else
      false -> {:error, :already_claimed}
      error -> error
    end
  end

  defp valid_id?(id), do: is_binary(id) and Regex.match?(~r/^[A-Za-z0-9_-]+$/, id)
  defp record_path(id), do: Path.join(root(), id <> ".json")

  def same_fiber?(record, fiber_id, uid) do
    if is_binary(uid) and is_binary(record["uid"]),
      do: record["uid"] == uid,
      else: record["fiber_id"] == fiber_id
  end
end
