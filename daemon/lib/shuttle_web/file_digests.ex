defmodule ShuttleWeb.FileDigests do
  @moduledoc """
  Content digests of large files, remembered per file version.

  `/file` names a small file by the SHA-256 of its bytes. A large file's
  bytes are read once per version instead of on every request: the digest is
  remembered under `{path, size, mtime, ctime, inode}`, but only for a file
  that has been still for two seconds when it is read. A later write moves
  the file's ctime, which no writer can set, to a later second, so a
  remembered digest never stands for different bytes. A file still being
  written is hashed but not remembered.

  Pure cache: a restart costs one re-read per file, never a wrong answer. The
  table holds at most 512 versions and is emptied when it fills.
  """

  use GenServer

  @table :shuttle_file_digests
  @settle_seconds 2
  @limit 512
  @chunk 1024 * 1024

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, nil}
  end

  @doc "The remembered digest of this version of `path`, if any."
  @spec lookup(String.t(), File.Stat.t()) :: String.t() | nil
  def lookup(path, %File.Stat{} = stat) do
    case :ets.lookup(@table, version(path, stat)) do
      [{_, digest}] -> digest
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc """
  The lowercase hex SHA-256 of `path`'s bytes for this version, read in
  one-MiB chunks and remembered when the file has settled.
  """
  @spec digest(String.t(), File.Stat.t(), integer()) :: {:ok, String.t()} | :error
  def digest(path, %File.Stat{} = stat, now \\ System.os_time(:second)) do
    case lookup(path, stat) do
      nil ->
        with {:ok, digest} <- hash(path) do
          if now - max(stat.mtime, stat.ctime) >= @settle_seconds,
            do: remember(path, stat, digest)

          {:ok, digest}
        end

      digest ->
        {:ok, digest}
    end
  end

  defp version(path, stat), do: {path, stat.size, stat.mtime, stat.ctime, stat.inode}

  defp remember(path, stat, digest) do
    if :ets.info(@table, :size) >= @limit, do: :ets.delete_all_objects(@table)
    :ets.insert(@table, {version(path, stat), digest})
  rescue
    ArgumentError -> :ok
  end

  defp hash(path) do
    case File.open(path, [:read, :binary, :raw]) do
      {:ok, file} ->
        try do
          hash_chunks(file, :crypto.hash_init(:sha256))
        after
          File.close(file)
        end

      {:error, _reason} ->
        :error
    end
  end

  defp hash_chunks(file, state) do
    case :file.read(file, @chunk) do
      {:ok, chunk} -> hash_chunks(file, :crypto.hash_update(state, chunk))
      :eof -> {:ok, :crypto.hash_final(state) |> Base.encode16(case: :lower)}
      {:error, _reason} -> :error
    end
  end
end
