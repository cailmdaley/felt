defmodule Shuttle.Terminal.LaunchAttempts do
  @moduledoc "Durable launch reservations, retired by exit evidence, confirmed absence, or explicit operator release."
  alias Shuttle.FS

  defp path(name) do
    key = :crypto.hash(:sha256, name) |> Base.encode16(case: :lower)
    Path.join([Shuttle.data_dir(), "terminals", "launch-attempts", key])
  end

  defp locked(name, fun), do: Shuttle.Terminal.with_lock({__MODULE__, path(name)}, fun)

  def pending?(name), do: match?({:ok, _}, get(name))

  def get(name) do
    locked(name, fn ->
      case FS.read(path(name)) do
        {:ok, raw} ->
          info = decode(name, raw)
          script = info["script"]

          if script_path?(script) and FS.stat(script) == {:error, :enoent} do
            FS.rm(path(name))
            :none
          else
            {:ok, Map.put(info, "age_seconds", age(info))}
          end

        {:error, :enoent} ->
          :none

        {:error, reason} ->
          {:ok, unknown(name, "Cannot read reservation: #{inspect(reason)}")}
      end
    end)
  end

  # This lands before the backend mutation; a lost reply or daemon crash keeps it.
  def record(name, script, facts \\ %{}) do
    locked(name, fn ->
      write(
        name,
        Map.merge(facts, %{
          "worker" => name,
          "script" => script,
          "recorded_at" => DateTime.to_iso8601(DateTime.utc_now()),
          "reason" => "A launch was attempted; its worker may still be running."
        })
      )
    end)
  end

  @doc "Prepared metadata is usable only for the exact live script recorded before launch."
  def prepared(name, runner) do
    case get(name) do
      {:ok, %{"dispatch" => dispatch, "script" => script}} when is_map(dispatch) ->
        with {:ok, procs} <- Shuttle.WorkerProcess.scan(runner),
             %{} = proc <- Shuttle.WorkerProcess.script_process(procs, script),
             %{} <- Shuttle.WorkerProcess.session_process([proc], name) do
          {:ok, dispatch}
        else
          _ ->
            if Shuttle.Terminal.status(runner, name) == :gone,
              do: :none,
              else: {:error, :execution_unproven}
        end

      _ ->
        :none
    end
  end

  def commit_dispatch(name, stamp) when is_binary(name) and is_binary(stamp) do
    locked(name, fn ->
      with {:ok, raw} <- FS.read(path(name)),
           %{"dispatch" => %{"dispatched_at" => ^stamp}} = info <- decode(name, raw) do
        write(name, Map.put(info, "dispatch_mirrored", stamp))
      else
        _ -> :ok
      end
    end)
  end

  def commit_dispatch(_, _), do: :ok

  def finish_dispatch(name, uuid) do
    locked(name, fn ->
      with {:ok, raw} <- FS.read(path(name)),
           %{
             "dispatch" => %{"dispatched_at" => stamp, "session_uuid" => expected},
             "dispatch_mirrored" => stamp
           } = info <- decode(name, raw),
           true <- expected in [nil, uuid] do
        write(name, Map.drop(info, ["dispatch", "dispatch_mirrored"]))
      else
        _ -> :ok
      end
    end)
  end

  @doc "Reservations that can hold a conversation before its harness appears."
  def for_conversation(uuid) do
    directory = Path.dirname(path(""))

    case FS.ls(directory) do
      {:ok, files} ->
        Enum.reduce_while(files, {:ok, []}, fn file, {:ok, found} ->
          with {:ok, raw} <- FS.read(Path.join(directory, file)),
               {:ok, %{"worker" => worker, "script" => script} = info} <- Jason.decode(raw),
               true <- is_binary(worker) and is_binary(script) do
            if info["conversation_uuid"] == uuid and FS.stat(script) != {:error, :enoent},
              do: {:cont, {:ok, [info | found]}},
              else: {:cont, {:ok, found}}
          else
            {:error, :enoent} -> {:cont, {:ok, found}}
            _ -> {:halt, {:error, :unknown}}
          end
        end)

      {:error, :enoent} ->
        {:ok, []}

      {:error, _} ->
        {:error, :unknown}
    end
  end

  def note(name, reason) do
    locked(name, fn ->
      with {:ok, raw} <- FS.read(path(name)),
           do:
             write(
               name,
               Map.put(
                 decode(name, raw),
                 "reason",
                 if(is_binary(reason), do: reason, else: inspect(reason))
               )
             )
    end)
  end

  # Confirmed absence/refusal authorizes record removal even with corrupt metadata.
  def clear(name) do
    locked(name, fn ->
      case FS.read(path(name)) do
        {:ok, raw} ->
          script = decode(name, raw)["script"]
          if script_path?(script), do: FS.rm(script)

        {:error, _} ->
          :ok
      end

      remove(path(name))
    end)
  end

  # An operator accepts possible duplication. The original script must survive.
  def release(name), do: locked(name, fn -> remove(path(name)) end)

  def message(info) do
    age =
      case age(info) do
        nil -> "age unknown"
        seconds -> "#{seconds}s old"
      end

    id = Shuttle.ULID.from_tmux(info["worker"]) || info["worker"]

    "Launch reserved for #{info["worker"]} (#{age}): #{info["reason"]} " <>
      "No running worker is confirmed. Releasing may create a duplicate worker. " <>
      "To accept that risk, run shuttle dispatch '#{id}' --release-launch-reservation on the owning host."
  end

  defp age(%{"recorded_at" => stamp}) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, at, _} -> max(DateTime.diff(DateTime.utc_now(), at), 0)
      _ -> nil
    end
  end

  defp age(_), do: nil

  defp decode(name, raw) do
    case Jason.decode(raw) do
      {:ok,
       %{"worker" => worker, "script" => script, "recorded_at" => stamp, "reason" => reason} =
           info}
      when is_binary(worker) and is_binary(script) and is_binary(stamp) and is_binary(reason) ->
        info

      _ ->
        info = unknown(name, "Reservation metadata is unreadable; its launch outcome is unknown.")
        if script_path?(raw), do: Map.put(info, "script", raw), else: info
    end
  end

  defp unknown(name, reason), do: %{"worker" => name, "recorded_at" => nil, "reason" => reason}

  defp write(name, info) do
    target = path(name)

    with :ok <- FS.mkdir_p(Path.dirname(target)),
         do: FS.write_atomic(target, Jason.encode!(info))
  end

  defp script_path?(script) when is_binary(script) do
    String.valid?(script) and not String.contains?(script, <<0>>) and
      Path.type(script) == :absolute and
      Regex.match?(~r/^shuttle-run-.+\.[0-9]+\.sh$/, Path.basename(script))
  end

  defp script_path?(_), do: false

  defp remove(path) do
    case FS.rm(path) do
      {:error, :enoent} -> :ok
      result -> result
    end
  end
end
