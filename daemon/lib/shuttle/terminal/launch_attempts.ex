defmodule Shuttle.Terminal.LaunchAttempts do
  @moduledoc "Durable worker-name reservations covering launches whose replies or runtime writes can be lost."

  alias Shuttle.FS

  defp path(name) do
    key = :crypto.hash(:sha256, name) |> Base.encode16(case: :lower)
    Path.join([Shuttle.data_dir(), "terminals", "launch-attempts", key])
  end

  def pending?(name) do
    target = path(name)

    case FS.read(target) do
      {:ok, script} ->
        if FS.stat(script) == {:error, :enoent} do
          FS.rm(target)
          false
        else
          true
        end

      {:error, :enoent} ->
        false

      {:error, _} ->
        true
    end
  end

  # The caller holds the terminal's name lock. The record lands before any
  # backend mutation, and a successful reply does not retire the reservation.
  def record(name, script) do
    target = path(name)

    with :ok <- FS.mkdir_p(Path.dirname(target)),
         :ok <- FS.write_atomic(target, script) do
      :ok
    end
  end

  # Retirement requires confirmed absence or a confirmed launch refusal.
  def clear(name) do
    target = path(name)

    case FS.read(target) do
      {:ok, script} ->
        with :ok <- remove(script), do: remove(target)

      {:error, :enoent} ->
        :ok

      error ->
        error
    end
  end

  defp remove(path) do
    case FS.rm(path) do
      {:error, :enoent} -> :ok
      result -> result
    end
  end
end
