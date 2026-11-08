defmodule ShuttleWeb.TemporalComposite do
  @moduledoc """
  Shared assembly for the cross-host temporal composites
  (`/activity/composite`, `/sessions/composite`, `/commits/composite`,
  `/sent-files/all/composite`).

  Each composite is the same shape as the kanban's
  `GET /api/v1/fibers/composite`: this host's live local read, concatenated
  with each remote's read of the same feed from `Shuttle.RemoteTemporalRegistry`,
  every item stamped with the origin it came from, plus an `origins` block
  reporting per-origin freshness. The origins block is **verbatim the fibers
  composite's** — `kind` / `stale` / `last_polled_at` (only while stale) /
  `last_error` — so the
  UI's staleness rendering is one implementation, not four. Each remote's
  fields describe the feed this composite served, not the remote as a whole.

  Asking the registry for a feed is what refreshes it: a request is the only
  thing that makes the hub fetch from its remotes (see the registry's
  moduledoc for the freshness gate and the bounded wait).

  The honesty contract lives in that block. A remote whose daemon is
  unreachable keeps serving its last-good data, marked `stale: true` with the
  time it was last seen; the view grays it rather than dropping it. That is the
  whole feature: a disconnect must not erase two weeks of history from the
  screen.

  ## Validators

  Every composite answers behind a weak ETag
  (`ShuttleWeb.RelayHelpers.json_with_validator/3`) over everything its body
  is a function of (`validator/2`): the request's parameters, the local
  sources' file tokens, and the state of each remote entry it merges. A 304
  skips the local read, which is the expensive half.

  A fleet with no remotes configured yields local data and a single local
  origin. Nothing here can 500 — the registry read degrades to an empty map
  when the registry is not running.
  """

  alias Shuttle.RemoteTemporalRegistry

  @doc """
  Every remote's view of `feed` (refreshing the ones past the freshness gate),
  or `%{}` when the registry is not running.
  """
  def remote_entries(feed) do
    RemoteTemporalRegistry.entries(feed)
  catch
    :exit, _ -> %{}
  end

  @doc """
  A composite's validator parts: this host's id, `local` (the request's
  parameters and the local sources' file tokens), and each remote's name with
  every field of its view the body reads. The remote's etag stands for its
  items; a remote that sent none contributes the items themselves. `last_polled_at` enters only while the remote
  is stale, as it does the origins block, so a fresh fleet's routine polls
  leave the validator alone.
  """
  def validator(local, entries) do
    remotes =
      entries
      |> Enum.map(fn {name, entry} ->
        {name, entry.etag || entry.items, entry.window,
         stale_since(entry.stale, entry.last_polled_at), entry.stale, entry.last_error}
      end)
      |> Enum.sort()

    {Shuttle.Poller.own_host_id(), local, remotes}
  end

  @doc """
  Build the `origins` block.

  `local_extra` and `remote_extra.(name, entry)` contribute the per-composite
  fields (activity adds each origin's covered `window`, the others add nothing).
  """
  def origins(entries, local_extra \\ %{}, remote_extra \\ fn _name, _entry -> %{} end) do
    entries
    |> Map.new(fn {name, entry} ->
      {name,
       Map.merge(
         %{
           kind: "remote",
           stale: entry.stale,
           last_polled_at: stale_since(entry.stale, entry.last_polled_at),
           last_error: render_error(entry.last_error)
         },
         remote_extra.(name, entry)
       )}
    end)
    |> Map.put(
      Shuttle.Poller.own_host_id(),
      Map.merge(%{kind: "local", stale: false, last_polled_at: nil, last_error: nil}, local_extra)
    )
  end

  @doc """
  Every remote's items, filtered to the window on `key` and stamped with the
  remote's name.
  """
  def remote_items(entries, key, from_ms, to_ms) do
    Enum.flat_map(entries, fn {name, entry} ->
      entry.items
      |> in_window(key, from_ms, to_ms)
      |> Enum.map(&stamp(&1, name))
    end)
  end

  @doc """
  Stamp an origin onto a decoded remote item (string keys, to match the wire
  shape the local atom-keyed maps encode to).
  """
  def stamp(item, origin) when is_map(item), do: Map.put(item, "host", origin)

  @doc """
  Read an item's epoch-ms timestamp under `key`, tolerating both atom and
  string key forms. `nil` when the item carries nothing readable — such an
  item is kept, never silently dropped by a window filter it cannot be judged
  against.
  """
  def item_ms(item, key) do
    case Map.get(item, key) || Map.get(item, to_string(key)) do
      value when is_integer(value) -> value
      _ -> nil
    end
  end

  @doc """
  Keep the items whose `key` timestamp falls in the window.

  The window is inclusive on both sides, and a `nil` upper bound is
  open-ended — the same encoding `Shuttle.Ledger.read_window/5` uses for
  the local half of the same request, so a controller that has no upper bound
  passes `nil` rather than a far-future sentinel.

  An item with no readable timestamp is kept: the feed cannot say when it
  happened, and dropping it would silently lose the record.
  """
  def in_window(items, key, from_ms, to_ms) do
    Enum.filter(items, fn item ->
      case item_ms(item, key) do
        nil -> true
        ms -> ms >= from_ms and (is_nil(to_ms) or ms <= to_ms)
      end
    end)
  end

  @doc """
  An origin's `last_polled_at` as the origins blocks carry it: the ISO-8601
  instant its data dates from while it is stale, nil while it is fresh. A
  fresh origin's poll instant moves every few seconds and is nothing a viewer
  draws, so it stays out of the body and its validator.
  """
  def stale_since(true, last_polled_at), do: format_dt(last_polled_at)
  def stale_since(_stale, _last_polled_at), do: nil

  @doc "ISO-8601 or nil."
  def format_dt(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  def format_dt(_), do: nil

  @doc "Render an error reason as a string, matching the fibers composite."
  def render_error(nil), do: nil
  def render_error(reason) when is_binary(reason), do: reason
  def render_error(reason) when is_atom(reason), do: to_string(reason)
  def render_error(reason), do: inspect(reason)
end
