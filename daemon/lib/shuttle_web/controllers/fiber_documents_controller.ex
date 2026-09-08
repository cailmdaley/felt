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
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2, etag_hash: 1, if_none_match?: 2]
  import ShuttleWeb.TemporalComposite, only: [format_dt: 1, render_error: 1]

  alias Shuttle.OriginRouter
  alias Shuttle.Poller.Snapshot

  def index(conn, params) do
    with_body? = Map.get(params, "body") in ["1", "true", true]
    shuttle_only? = Map.get(params, "shuttle") in ["1", "true", true]

    # The polled owner feed (`?shuttle=true` without bodies) is the hot path
    # remote viewers hit every 5s: serve it from the poller's in-memory cache
    # with a conditional-fetch etag. The body/content and non-shuttle variants
    # keep their direct `FiberDocuments.list/1` behavior.
    if shuttle_only? and not with_body? do
      serve_owner_feed(conn)
    else
      serve_direct(conn, with_body?, shuttle_only?)
    end
  end

  defp serve_direct(conn, with_body?, shuttle_only?) do
    case Shuttle.FiberDocuments.list(with_body: with_body?, shuttle_only: shuttle_only?) do
      {:ok, body} ->
        json(conn, body)

      {:error, errors} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "felt_list_failed", stores: errors})
    end
  end

  # The owner-only kanban feed, served ALWAYS from the poller's in-memory
  # document cache — never a live `felt ls` in the request path. A cold cache
  # returns an empty feed with `cache.state == "cold"` (200, not an error);
  # only an unavailable poller (down / call timeout — near-impossible now that
  # the reply is a pure state read) is a 503.
  #
  # Conditional fetch: a WARM response carries a strong `etag` computed from the
  # final stamped entries (any visible change changes it). A matching
  # `If-None-Match` short-circuits to 304 with an empty body, so an unchanged
  # feed costs the tunnel a header exchange instead of the full transfer.
  #
  # A COLD feed carries NO etag and never 304s: cold and warm-empty stamp
  # byte-identical entries (both `[]`), so an etag over entries alone would let a
  # zero-fiber host 304 forever with `cache.state` pinned "cold". Withholding the
  # etag while cold forces the first post-warm poll to deliver a fresh 200 (and a
  # fresh cache block). The `cache` metadata rides an `x-shuttle-cache` response
  # header on BOTH 200 and 304 so the client's `refreshed_at`/`state` never
  # freeze across a run of 304s (the 304 has no body to carry it).
  defp serve_owner_feed(conn) do
    case cached_owner_feed() do
      {:ok, body} ->
        # The store registry rides the owner feed so a viewer's `/felt-stores`
        # can serve this host's picker origin from its cached feed instead of a
        # live fetch that blinks out whenever this host is loaded.
        body = Map.put(body, :stores, ShuttleWeb.FeltStoresController.local_origin(body.host))
        conn = put_cache_header(conn, body)
        cold? = get_in(body, [:cache, :state]) == "cold"

        if cold? do
          json(conn, body)
        else
          etag = feed_etag({body.fibers, body.stores})
          conn = put_resp_header(conn, "etag", etag)

          if if_none_match?(conn, etag),
            do: send_resp(conn, 304, ""),
            else: json(conn, body)
        end

      :unavailable ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "poller_unavailable"})
    end
  end

  # The cache metadata block as a JSON `x-shuttle-cache` header, so a 304 (no
  # body) still carries `state`/`refreshed_at`/`entries`/`last_refresh_ms`.
  defp put_cache_header(conn, %{cache: cache}) when is_map(cache) do
    put_resp_header(conn, "x-shuttle-cache", Jason.encode!(cache))
  end

  defp put_cache_header(conn, _body), do: conn

  # Strong etag over the stamped entries and the store-registry block only (not
  # `generated_at` or the cache timestamps, which change every tick without the
  # feed changing) — a registry edit must invalidate too, or a viewer's picker
  # would 304 against a stale store list. SHA-256, hex, truncated —
  # collision-resistant enough for a cache validator.
  defp feed_etag(payload), do: ~s("#{etag_hash(payload)}")

  @doc """
  `GET /api/v1/fibers/:id` — resolve one fiber by canonical id. The id is a
  wildcard splat so nested ids (`ai-futures/portolan/foo`) arrive as path
  segments; rejoin with `/`. Returns the same envelope shape as `index/2` with
  zero or one fiber, so the client reuses the list-response parser. A missing
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

  **A caller that names no origin does not get the mirror.** Not every caller
  holds one: a `[[wikilink]]` opens a fiber the board never carded, so it has no
  composite row to read an origin off. Rather than serve this host's git copy of
  work another daemon owns — the same mistake the feed made until `5669fc7`, and
  worse here because the panel then routes its saves by the origin this envelope
  reports — the local lookup reads the copy it has, sees `shuttle.host` naming
  someone else, and forwards there. The answer therefore always comes from the
  owner, whoever asked and however little they knew.

  The forward carries `routed=1`, which suppresses a second self-route on the
  far side. One hop, always: two daemons whose git copies disagree about `host:`
  cannot bounce a request between them.
  """
  def show(conn, %{"id" => id_segments} = params) do
    id = id_segments |> List.wrap() |> Enum.join("/")
    with_body? = Map.get(params, "body") in ["1", "true", true]
    routed? = Map.get(params, "routed") in ["1", "true", true]

    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, forward_show(remote, id, with_body?))

      :local ->
        show_local(conn, id, with_body?, routed?)
    end
  end

  defp show_local(conn, id, with_body?, routed?) do
    case Shuttle.FiberDocuments.get(id, with_body: with_body?) do
      {:ok, body} ->
        case owning_remote(body, routed?) do
          nil -> json(conn, body)
          remote -> relay_bytes(conn, forward_show(remote, id, with_body?))
        end

      {:error, errors} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "felt_show_failed", stores: errors})
    end
  end

  defp forward_show(remote, id, with_body?) do
    OriginRouter.forward_get(remote, fibers_show_path(id), %{
      "body" => to_string(with_body?),
      "routed" => "1"
    })
  end

  # The remote that owns the fiber we just read locally, or nil to answer here.
  #
  # nil covers every case where this daemon IS the right answer: an already-
  # routed request, a fiber we own, an ownerless one, a miss, and a `host:`
  # naming no configured remote (`OriginRouter.route/1`'s documented degrade —
  # an orphaned host is better served by the mirror than by nothing, since no
  # daemon in the fleet claims it).
  defp owning_remote(_body, true), do: nil

  defp owning_remote(%{fibers: [entry | _]}, _routed?), do: entry_owner(entry)
  defp owning_remote(_body, _routed?), do: nil

  defp entry_owner(entry) do
    host =
      entry
      |> fetch_either(:fiber, "fiber")
      |> fetch_either(:shuttle, "shuttle")
      |> fetch_either(:host, "host")

    with true <- is_binary(host) and host != "",
         false <- host == Shuttle.Poller.own_host_id(),
         {:remote, remote} <- OriginRouter.route(host) do
      remote
    else
      _ -> nil
    end
  end

  defp fetch_either(map, atom_key, string_key) when is_map(map),
    do: Map.get(map, atom_key) || Map.get(map, string_key)

  defp fetch_either(_, _, _), do: nil

  # Rebuild the owning daemon's `/api/v1/fibers/:id` path, encoding each id
  # segment so the remote's wildcard splat reconstructs the same canonical id.
  defp fibers_show_path(id) do
    encoded =
      id
      |> String.split("/")
      |> Enum.map_join("/", &URI.encode(&1, fn c -> URI.char_unreserved?(c) end))

    "/api/v1/fibers/" <> encoded
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
    {local_origin, local_owner_entries, local_stale, local_cache} = local_feed()
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
           fiber_count: length(feed.fibers),
           # The owning host's own cache-freshness block (cold/partial/fresh +
           # refreshed_at), so the board can render "warming / stale as of T"
           # rather than a binary badge. nil until the remote serves it.
           cache: Map.get(feed, :cache)
         }}
      end)
      |> Map.put(local_origin, %{
        kind: "local",
        stale: local_stale,
        fiber_count: length(local_owner_entries),
        cache: local_cache
      })

    json(conn, %{
      host: local_origin,
      generated_at: DateTime.to_iso8601(DateTime.utc_now()),
      fibers: fibers,
      origins: origins
    })
  end

  # The local owner feed: same rows as `GET /api/v1/fibers?shuttle=true`, served
  # from the poller's document cache. A cold cache yields an empty feed marked
  # stale (the board shows "warming" rather than dropping the local column); an
  # unavailable poller is stale too. The cache's own `cache.state` metadata
  # rides through as the staleness signal.
  defp local_feed do
    case cached_owner_feed() do
      {:ok, %{host: host, fibers: entries} = body} ->
        {host, entries, cold?(body), Map.get(body, :cache)}

      :unavailable ->
        {own_host_id(), [], true, nil}
    end
  end

  # The local column is "stale" while its cache has not warmed to a full "fresh"
  # tick — cold (no poll yet) or partial (a store served from last-known rows).
  defp cold?(%{cache: %{state: state}}), do: state != "fresh"
  defp cold?(_), do: false

  # Remote entries arrive as raw decoded JSON (string keys); stamp origin with a
  # string key so the wire shape matches the atom-keyed local rows after JSON
  # encoding.
  defp stamp_origin(entry, origin) when is_map(entry), do: Map.put(entry, "origin", origin)

  defp own_host_id, do: Shuttle.Poller.own_host_id()

  # The owner-only kanban feed (`GET /api/v1/fibers?shuttle=true`) — the path
  # remote viewers poll every 5s over the SSH tunnel. Served ALWAYS from the
  # poller's in-memory document cache (microseconds), never a LIVE `felt ls` per
  # store (5-12s on an overloaded shared login node, which blows the viewer's 8s
  # timeout and paints a spurious staleness badge). There is no live fallback:
  # the reply is a pure read of GenServer state, so a cold cache is an empty
  # feed marked `cache.state == "cold"`, not a filesystem walk.
  #
  # The cached rows are ALREADY owner-filtered and runtime-stamped, but the cache
  # does NOT carry the parked/held overlay, so we map `Snapshot.put_held/2` over
  # them here. We do NOT re-apply `put_runtime` — the cache already did.
  #
  # Only an unreachable poller (down / not started / call timeout — near-
  # impossible for a pure state read) yields `:unavailable`, which the callers
  # turn into a 503 (owner-feed endpoint) or a stale-marked empty local column
  # (composite board).
  defp cached_owner_feed do
    case Shuttle.Poller.cached_fiber_documents(felt_stores: Shuttle.FeltStores.configured_hosts()) do
      {:ok, %{fibers: entries} = body} ->
        held = Shuttle.Poller.parked_index()
        {:ok, %{body | fibers: Enum.map(entries, &Snapshot.put_held(&1, held))}}

      _ ->
        :unavailable
    end
  catch
    # Poller down / not started / call timeout → the caller decides (503 / stale).
    :exit, _ -> :unavailable
  end
end
