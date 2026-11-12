defmodule Shuttle.RuntimeDocuments do
  @moduledoc """
  Small operator and binding documents, read at most once per second.

  Cache fills and daemon writes serialize per path. A completed write invalidates
  the snapshot before any later reader proceeds. External edits enter within
  one second; kernel evidence and authorization checks use fresh filesystem IO.
  """
  alias Shuttle.{Env, FS, RuntimeCache}

  def read(path) do
    case RuntimeCache.peek(key(path)) do
      {:ok, result} -> result
      :miss -> locked(path, fn -> load(path) end)
    end
  end

  defp load(path) do
    result = RuntimeCache.fetch(key(path), 1_000, fn -> FS.read(path) end)

    case result do
      {:error, reason} when reason not in [:enoent, :enotdir] -> RuntimeCache.delete(key(path))
      _ -> :ok
    end

    result
  end

  def change(path, fun) do
    locked(path, fn ->
      try do
        fun.()
      after
        RuntimeCache.delete(key(path))
      end
    end)
  end

  defp key(path), do: {__MODULE__, path}
  defp locked(path, fun), do: Shuttle.Lock.transaction(Env.scope_key(key(path)), fun)
end
