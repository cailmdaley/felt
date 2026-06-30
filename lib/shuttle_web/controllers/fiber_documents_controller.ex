defmodule ShuttleWeb.FiberDocumentsController do
  @moduledoc """
  Agent-API endpoint for daemon-local fiber document reads.

  `GET /api/v1/fibers` returns the fibers visible to this daemon's configured
  felt stores. `GET /api/v1/fibers/:id` resolves a SINGLE fiber by canonical id
  — the per-fiber lookup used to open a card without fetching every fiber — and
  is OWNER-ROUTED: a remote-owned fiber's body is fetched from the owning daemon
  over the SSH tunnel (see `show/2`), never assumed present in a local git
  mirror. The `fiber` payload is felt JSON, intentionally leaving document
  parsing semantics with felt and the reader.

  Query params (both actions):
    * `body=true`    — include each fiber's markdown body.

  `GET /api/v1/fibers` only:
    * `shuttle=true` — the owner-only kanban feed: return ONLY the fibers THIS
      daemon owns — a `shuttle:` block AND `shuttle.host == own_host_id`. A
      viewer reads this endpoint as a REMOTE origin and concatenates each
      owner's answer (never merges, because no fiber is authoritatively present
      on two hosts); a fiber pinned to another host belongs to that host's feed,
      never this one's git mirror. Also narrows the cross-tunnel transfer to the
      few hundred owned shuttle fibers. Omitted/unknown => unfiltered (every
      fiber, unowned included) — the content/search/graph readers, not the
      kanban feed.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.OriginRouter
  alias Shuttle.Poller.Snapshot

  def index(conn, params) do
    with_body? = Map.get(params, "body") in ["1", "true", true]
    shuttle_only? = Map.get(params, "shuttle") in ["1", "true", true]

    case list_fibers(with_body?, shuttle_only?) do
      {:ok, body} ->
        json(conn, body)

      {:error, errors} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "felt_list_failed", stores: errors})
    end
  end

  @doc """
  `GET /api/v1/fibers/:id` — resolve one fiber by canonical id. The id is a
  wildcard splat so nested ids (`ai-futures/portolan/foo`) arrive as path
  segments; rejoin with `/`. Returns the same envelope shape as `index/2` with
  zero or one fiber, so Portolan reuses the list-response parser. A missing
  fiber is a 200 with `fibers: []`, not a 404 — the caller treats an empty list
  as "not here", same as scanning the full list would.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** Only the
  daemon that owns a fiber's host can read its body off that host's filesystem.
  The composite board stamps each fiber with its `origin`; the detail panel
  carries that origin back here. A local-owned fiber is read here; a remote-owned
  fiber forwards to the owning daemon's identical `/api/v1/fibers/:id` (origin
  stripped) over the SSH tunnel and relays the JSON verbatim. This is the ONLY
  correct source for a remote constitution's body — git-mirror replication is
  incidental and must never be relied on for availability.
  """
  def show(conn, %{"id" => id_segments} = params) do
    id = id_segments |> List.wrap() |> Enum.join("/")
    with_body? = Map.get(params, "body") in ["1", "true", true]

    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_show(
          conn,
          OriginRouter.forward_get(remote, fibers_show_path(id), %{
            "body" => to_string(with_body?)
          })
        )

      :local ->
        show_local(conn, id, with_body?)
    end
  end

  defp show_local(conn, id, with_body?) do
    case Shuttle.FiberDocuments.get(id, with_body: with_body?) do
      {:ok, body} ->
        json(conn, body)

      {:error, errors} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "felt_show_failed", stores: errors})
    end
  end

  # Rebuild the owning daemon's `/api/v1/fibers/:id` path, encoding each id
  # segment so the remote's wildcard splat reconstructs the same canonical id.
  defp fibers_show_path(id) do
    encoded =
      id
      |> String.split("/")
      |> Enum.map_join("/", &URI.encode(&1, fn c -> URI.char_unreserved?(c) end))

    "/api/v1/fibers/" <> encoded
  end

  # Relay the owning remote's JSON + status verbatim, so a remote "fiber not
  # here" reads as that, not a tunnel error.
  defp relay_show(conn, {:forwarded, status, content_type, body}) do
    conn
    # `nil` charset → relay verbatim; avoids doubling the remote's own charset
    # (see FileController.relay/2 — a doubled charset breaks image rendering).
    |> put_resp_content_type(content_type, nil)
    |> send_resp(status, body)
  end

  defp relay_show(conn, {:error, {:forward_failed, name, reason}}) do
    conn
    |> put_status(:bad_gateway)
    |> json(%{error: "forward to #{name} failed: #{inspect(reason)}"})
  end

  @doc """
  `GET /api/v1/fibers/composite` — the unified cross-host kanban board.

  Concatenates this daemon's local owner feed (read directly from felt, with any
  poller-known runtime liveness overlaid) with each remote daemon's cached owner
  feed (`Shuttle.RemoteFiberRegistry`, which stamps the remote's own liveness at
  the remote's serve time). The result is a flat per-fiber list where every
  fiber's liveness was resolved by its OWNING host — one observer per fiber, no
  cross-observer disagreement, so the kanban can classify directly without a
  second tmux read.

  Each fiber row carries an `origin` field (the owning host/remote name) so the
  view can route worker-badge focus and transitions without re-deriving owner
  from the `shuttle.host` block. `origins` reports per-origin staleness so the
  view can mark an unreachable remote without dropping its last-known cards.

  This is the local-composer counterpart of `/state/composite`: the kanban talks
  to ONE (local) Shuttle and sees local + every configured remote.
  """
  def composite(conn, _params) do
    {local_origin, local_owner_entries, local_stale} = local_feed()
    remote_feeds = Shuttle.RemoteFiberRegistry.feeds()

    fibers =
      Enum.map(local_owner_entries, &Map.put(&1, :origin, local_origin)) ++
        Enum.flat_map(remote_feeds, fn {name, feed} ->
          Enum.map(feed.fibers, &stamp_origin(&1, name))
        end)

    origins =
      remote_feeds
      |> Map.new(fn {name, feed} ->
        {name,
         %{
           kind: "remote",
           stale: feed.stale,
           last_polled_at: format_dt(feed.last_polled_at),
           last_error: render_error(feed.last_error),
           fiber_count: length(feed.fibers)
         }}
      end)
      |> Map.put(local_origin, %{
        kind: "local",
        stale: local_stale,
        fiber_count: length(local_owner_entries)
      })

    json(conn, %{
      host: local_origin,
      generated_at: DateTime.to_iso8601(DateTime.utc_now()),
      fibers: fibers,
      origins: origins
    })
  end

  # The local owner feed: same body as `GET /api/v1/fibers?shuttle=true`. Felt is
  # the authority for which local constitutions exist; the poller cache is only a
  # runtime overlay. That keeps board visibility independent from the poller's
  # narrower dispatch/cache lifecycle while preserving local tmux liveness when
  # the poller has it.
  defp local_feed do
    case list_fibers(false, true) do
      {:ok, %{host: host, fibers: entries}} -> {host, entries, false}
      {:ok, %{fibers: entries}} -> {own_host_id(), entries, false}
      {:error, _errors} -> {own_host_id(), [], true}
    end
  end

  # Remote entries arrive as raw decoded JSON (string keys); stamp origin with a
  # string key so the wire shape matches the atom-keyed local rows after JSON
  # encoding.
  defp stamp_origin(entry, origin) when is_map(entry), do: Map.put(entry, "origin", origin)

  defp own_host_id, do: Shuttle.Poller.own_host_id()

  defp format_dt(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_dt(_), do: nil

  defp render_error(nil), do: nil
  defp render_error(reason) when is_binary(reason), do: reason
  defp render_error(reason) when is_atom(reason), do: to_string(reason)
  defp render_error(reason), do: inspect(reason)

  defp list_fibers(false, true) do
    case Shuttle.FiberDocuments.list(with_body: false, shuttle_only: true) do
      {:ok, %{fibers: entries} = body} ->
        {:ok, %{body | fibers: overlay_runtime(entries)}}

      other ->
        other
    end
  end

  defp list_fibers(with_body?, shuttle_only?) do
    Shuttle.FiberDocuments.list(with_body: with_body?, shuttle_only: shuttle_only?)
  end

  defp overlay_runtime(entries) do
    index = Shuttle.Poller.runtime_index()
    Enum.map(entries, &Snapshot.put_runtime(&1, index))
  end
end
