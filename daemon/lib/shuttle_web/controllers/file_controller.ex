defmodule ShuttleWeb.FileController do
  @moduledoc """
  Serve file/asset bytes by absolute path: `GET /api/v1/file?path=…&origin=…`,
  and metadata-only change probes via `GET /api/v1/file-info?path=…&origin=…`.

  The one genuine backend addition the standalone Shuttle UI needs. The fiber
  detail panel renders the daemon's raw markdown lean (`marked`), but a
  `:::{embed}` artifact and a relative image are file *bytes*, not markdown —
  this route delivers them. It is also what lets a remote-owned fiber's body and
  assets render: only the owning daemon can read its own host's filesystem.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/kill` and
  `/felt-edit`.** The composite board stamps each fiber with its `origin`; the
  panel carries that origin back. A local-owned path is read here; a
  remote-owned path forwards to the owning daemon's identical `/file` (origin
  stripped) over the SSH tunnel and relays its bytes, content type, and cache
  validators (`OriginRouter.forward_file_get/4`).

  **Path contract.** `path` must be ABSOLUTE — the panel resolves a fiber's
  `:::{embed} <rel>` against the fiber's own directory client-side before
  calling, and an absolute embed (a paper build outside `.felt/`) is passed
  through as-is. There is deliberately no felt-store sandbox: the constitution
  wants paper builds outside any store to render, and the trust model is the
  localhost/trusted-cluster daemon the rest of the API already assumes (it shells
  out to felt over arbitrary stores). A relative path is a 400; `/file` returns
  404 for a missing file, while `/file-info` reports `exists: false`; neither
  500s the panel.

  **Conditional reads on both owner legs.** A file response carries a weak
  `ETag` (a SHA-256 digest of the served bytes) and `Last-Modified` (from mtime),
  and honors `If-None-Match` / `If-Modified-Since` with a bodyless 304. The
  owner-routed leg forwards those request headers and relays the owner's
  validators, so an unchanged remote file also costs a header exchange. A peer
  without conditional-GET support still returns 200; the board compares the
  returned content fingerprint before changing its view. `/file-info` remains
  available for metadata-only probes used by other artifact types.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [relay_bytes: 2, relay_file_bytes: 2, file_token: 1]

  alias Shuttle.OriginRouter

  # POSIX mtime (per `time: :posix`) is seconds since 1970; Erlang's gregorian
  # seconds count from year 0. `http_date/1` uses
  # this offset to convert between the two, without ever touching a timezone.
  @gregorian_epoch_offset :calendar.datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}})

  def show(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_file_bytes(
          conn,
          OriginRouter.forward_file_get(
            remote,
            "/api/v1/file",
            %{"path" => path},
            conditional_headers(conn)
          )
        )

      :local ->
        serve_local(conn, path)
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  @doc """
  Return cheap metadata for a file without reading its bytes.

  The board uses this metadata probe for browser-native artifacts that are not
  rendered through the live text/HTML reader. A missing path is a successful response
  with `exists: false`, so a report that is still being written can be detected
  when it appears without treating an expected absence as a transport error.
  """
  def info(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(
          conn,
          OriginRouter.forward_get(remote, "/api/v1/file-info", %{"path" => path})
        )

      :local ->
        serve_info(conn, path)
    end
  end

  def info(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  defp serve_info(conn, path) do
    with_regular_file(conn, path,
      found: fn mtime, size ->
        info_json(conn, %{exists: true, modified_at: mtime, size: size})
      end,
      missing: fn -> info_json(conn, %{exists: false}) end
    )
  end

  defp info_json(conn, body) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> json(body)
  end

  defp serve_local(conn, path) do
    with_regular_file(conn, path,
      found: fn mtime, size -> serve_with_validators(conn, path, mtime, size) end,
      missing: fn -> conn |> put_status(404) |> json(%{error: "file not found"}) end
    )
  end

  # The head both local legs share: reject a relative path, then stat it and
  # dispatch on "is a regular file". Only what happens at each outcome differs
  # (bytes + validators vs. a metadata JSON; 404 vs. `exists: false`).
  defp with_regular_file(conn, path, found: found, missing: missing) do
    if Path.type(path) != :absolute do
      conn |> put_status(400) |> json(%{error: "path must be absolute"})
    else
      case file_token(path) do
        {mtime, size} -> found.(mtime, size)
        nil -> missing.()
      end
    end
  end

  # Hash and serve the same bytes so a rewrite is visible even when its size
  # and filesystem timestamp are unchanged.
  defp serve_with_validators(conn, path, mtime, _size) do
    case File.read(path) do
      {:ok, body} ->
        etag = weak_etag(body)
        last_modified = http_date(mtime)

        conn =
          conn
          |> put_resp_header("etag", etag)
          |> put_resp_header("last-modified", last_modified)
          |> put_resp_header("cache-control", "public, max-age=300")

        if not_modified?(conn, etag, mtime) do
          send_resp(conn, 304, "")
        else
          conn
          |> put_resp_content_type(MIME.from_path(path))
          |> send_resp(200, body)
        end

      {:error, _reason} ->
        conn |> put_status(404) |> json(%{error: "file not found"})
    end
  end

  # Only the content digest decides a 304. `If-Modified-Since` alone never does:
  # whole-second timestamps can't see a same-second rewrite, and a false 304
  # freezes a report that is being rewritten while someone reads it.
  defp not_modified?(conn, etag, _mtime) do
    case get_req_header(conn, "if-none-match") do
      [value | _] -> etag_matches?(value, etag)
      [] -> false
    end
  end

  defp etag_matches?(header, etag) do
    String.split(header, ",")
    |> Enum.any?(fn candidate ->
      candidate = String.trim(candidate)
      candidate == "*" or weak_tag(candidate) == weak_tag(etag)
    end)
  end

  defp weak_tag("W/" <> tag), do: tag
  defp weak_tag(tag), do: tag

  defp conditional_headers(conn) do
    ["if-none-match", "if-modified-since"]
    |> Enum.flat_map(fn name -> Enum.map(get_req_header(conn, name), &{name, &1}) end)
  end

  defp weak_etag(body) do
    digest = :crypto.hash(:sha256, body) |> Base.encode16(case: :lower)
    ~s(W/"sha256-#{digest}")
  end

  @weekdays {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
  @months {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

  # Formatted by hand rather than via `:httpd_util.rfc1123_date/1`: that
  # function treats its argument as LOCAL time and converts it to GMT using the
  # node's own offset, which would silently shift a UTC `mtime` — the exact bug
  # this function exists to avoid (verified against a live node: it does not
  # round-trip `:httpd_util.convert_request_date/1`, its own parser).
  defp http_date(mtime) do
    {{year, month, day}, {hour, minute, second}} =
      :calendar.gregorian_seconds_to_datetime(mtime + @gregorian_epoch_offset)

    weekday = :calendar.day_of_the_week(year, month, day)

    :io_lib.format("~s, ~2..0B ~s ~4..0B ~2..0B:~2..0B:~2..0B GMT", [
      elem(@weekdays, weekday - 1),
      day,
      elem(@months, month - 1),
      year,
      hour,
      minute,
      second
    ])
    |> to_string()
  end
end
