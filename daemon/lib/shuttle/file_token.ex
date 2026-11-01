defmodule Shuttle.FileToken do
  @moduledoc """
  Cheap change fingerprint for a file: `{mtime, size}`, or `nil` when it does
  not exist or is not a regular file.

  Every append-only source the daemon serves (the hook stream, the session and
  commit ledgers, a harness transcript) moves this token on each write and on a
  rotation by rename, so it is what the HTTP validators and the per-file caches
  key on. A missing file's `nil` is itself a stable token — a host that has
  never written the file 304s forever, correctly.

  POSIX seconds (`time: :posix`): two writes inside one second that leave the
  size unchanged are indistinguishable, which an append-only file cannot do.
  """

  @spec of(term()) :: {integer(), non_neg_integer()} | nil
  def of(path) when is_binary(path) do
    case File.stat(path, time: :posix) do
      {:ok, %File.Stat{type: :regular, mtime: mtime, size: size}} -> {mtime, size}
      _ -> nil
    end
  end

  def of(_path), do: nil
end
