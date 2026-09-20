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
  """

  def client, do: Application.get_env(:shuttle, :codex_app_client, Shuttle.CodexApp)
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
    Application.get_env(:shuttle, :app_workers_dir, Path.join(Shuttle.data_dir(), "app-workers"))
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
    with :ok <- update(id, %{"launch_state" => "starting", "pending_prompt" => prompt}) do
      case client().start_turn(id, prompt, opts) do
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

  def deactivate(id) do
    update(id, %{"active" => false})
  end

  def claim(id, fiber, store) do
    :global.trans({{__MODULE__, id}, self()}, fn -> do_claim(id, fiber, store) end)
  end

  defp do_claim(id, fiber, store) do
    with {:ok, record} <- get(id),
         true <- record["active"] == true,
         true <- is_nil(record["fiber_id"]) or same_fiber?(record, fiber["id"], fiber["uid"]),
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

  def same_fiber?(record, fiber_id, uid) do
    if is_binary(uid) and is_binary(record["uid"]),
      do: record["uid"] == uid,
      else: record["fiber_id"] == fiber_id
  end
end
