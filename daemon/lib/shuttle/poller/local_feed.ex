defmodule Shuttle.Poller.LocalFeed do
  @moduledoc """
  The last warm owner feed on disk, so a restarting daemon's board keeps its
  local rows while the document cache warms.

  `Shuttle.RemoteFiberRegistry` keeps each remote's feed under
  `$SHUTTLE_DATA_DIR/remote-fibers/<host>.json`; this is the local origin's
  counterpart, `$SHUTTLE_DATA_DIR/local-fibers/<host>.json`, written with the
  same atomic tmp-and-rename (`Shuttle.RegistryCommon.persist/4`).

  The Poller writes the owner feed's base rows (owner-filtered, sorted, before
  any runtime overlay) whenever a warm cache changes them, and reads the file
  once at boot. Those rows reach readers only through
  `Shuttle.Poller.cached_fiber_documents/2` with `last_known: true`, and only
  while the cache is cold; the runtime overlay is stamped over them live, as
  over warm rows. Dispatch never reads them: it works from the document cache,
  which stays empty until the first poll.

  A missing, unreadable, malformed or other-version file loads as no rows.
  """

  alias Shuttle.RegistryCommon

  @version 1

  @doc "Write `entries` as `host`'s last-known owner feed."
  @spec persist(String.t(), [map()]) :: :ok
  def persist(host, entries) do
    RegistryCommon.persist(dir(), host, %{version: @version, fibers: entries}, "LocalFeed")
  end

  @doc "`host`'s last-known owner feed rows, atom-keyed like the cache's entries."
  @spec load(String.t()) :: [map()]
  def load(host) do
    with {:ok, raw} <- Shuttle.FS.read(path(host)),
         {:ok, %{"version" => @version, "fibers" => fibers}} when is_list(fibers) <-
           Jason.decode(raw) do
      Enum.map(fibers, &atomize/1)
    else
      _ -> []
    end
  rescue
    _ -> []
  end

  # An entry's top-level keys are atoms (`felt_store`, `path`, `fiber`, `dir`,
  # `report_path`, `orchestrator`); the fiber inside is felt JSON, string-keyed
  # either way. A key that names no existing atom is a foreign file.
  defp atomize(%{} = entry), do: Map.new(entry, fn {k, v} -> {String.to_existing_atom(k), v} end)

  defp dir, do: Path.join(Shuttle.data_dir(), "local-fibers")

  defp path(host), do: Path.join(dir(), "#{RegistryCommon.safe_name(host)}.json")
end
