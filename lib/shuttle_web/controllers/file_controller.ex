defmodule ShuttleWeb.FileController do
  @moduledoc """
  Serve file/asset bytes by absolute path: `GET /api/v1/file?path=…&origin=…`.

  The one genuine backend addition the standalone Shuttle UI needs. The fiber
  detail panel renders the daemon's raw markdown lean (`marked`), but a
  `:::{embed}` artifact and a relative image are file *bytes*, not markdown —
  this route delivers them. It is also what lets a remote-owned fiber's body and
  assets render: only the owning daemon can read its own host's filesystem.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/kill` and
  `/felt-edit`.** The composite board stamps each fiber with its `origin`; the
  panel carries that origin back. A local-owned path is read here; a
  remote-owned path forwards to the owning daemon's identical `/file` (origin
  stripped) over the SSH tunnel and relays its bytes + content-type verbatim
  (`OriginRouter.forward_get/4`).

  **Path contract.** `path` must be ABSOLUTE — the panel resolves a fiber's
  `:::{embed} <rel>` against the fiber's own directory client-side before
  calling, and an absolute embed (a paper build outside `.felt/`) is passed
  through as-is. There is deliberately no felt-store sandbox: the constitution
  wants paper builds outside any store to render, and the trust model is the
  localhost/trusted-cluster daemon the rest of the API already assumes (it shells
  out to felt over arbitrary stores). A relative path is a 400; a missing file is
  a 404; neither 500s the panel.

  **Cache validators on the local-serve path.** The board re-mounts iframes
  pointed at this route on every panel open, which would otherwise refetch a
  multi-MB report in full each time. A local response carries a weak `ETag`
  (hashed from path + mtime + size) and `Last-Modified` (from mtime), honors
  `If-None-Match` / `If-Modified-Since` with a bodyless 304, and advertises
  `Cache-Control: public, max-age=300` so the browser skips the round trip
  entirely inside that window. The forwarded (remote-owned) leg relays the
  owning daemon's bytes verbatim via `relay_bytes/2` and carries no validators
  of its own here — a future pass could thread them through
  `OriginRouter.forward_get/4`, but that widens the relay contract for every
  other owner-routed GET, not just this one.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  alias Shuttle.OriginRouter

  # POSIX mtime (per `time: :posix`) is seconds since 1970; Erlang's gregorian
  # seconds count from year 0. Both `http_date/1` and `if_modified_since/2` use
  # this offset to convert between the two, without ever touching a timezone.
  @gregorian_epoch_offset :calendar.datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}})

  def show(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/file", %{"path" => path}))

      :local ->
        serve_local(conn, path)
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  defp serve_local(conn, path) do
    cond do
      Path.type(path) != :absolute ->
        conn |> put_status(400) |> json(%{error: "path must be absolute"})

      true ->
        case File.stat(path, time: :posix) do
          {:ok, %File.Stat{type: :regular, mtime: mtime, size: size}} ->
            serve_with_validators(conn, path, mtime, size)

          _ ->
            conn |> put_status(404) |> json(%{error: "file not found"})
        end
    end
  end

  defp serve_with_validators(conn, path, mtime, size) do
    etag = weak_etag(path, mtime, size)
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
      |> send_file(200, path)
    end
  end

  # `If-None-Match` wins when present (it's the precise check); `If-Modified-Since`
  # is the fallback a plain `curl`/browser sends on its own. Either one matching
  # is enough — this is a GET, so there is no lost-update race to protect against.
  defp not_modified?(conn, etag, mtime) do
    if_none_match(conn, etag) || if_modified_since(conn, mtime)
  end

  defp if_none_match(conn, etag) do
    case get_req_header(conn, "if-none-match") do
      [value | _] -> String.trim(value) == etag
      [] -> false
    end
  end

  defp if_modified_since(conn, mtime) do
    case get_req_header(conn, "if-modified-since") do
      [value | _] ->
        case :httpd_util.convert_request_date(String.to_charlist(value)) do
          {_date, _time} = since ->
            :calendar.datetime_to_gregorian_seconds(since) - @gregorian_epoch_offset >= mtime

          :bad_date ->
            false
        end

      [] ->
        false
    end
  end

  # Weak — derived from file metadata (path + mtime + size), not a hash of the
  # served bytes — matching `ShuttleWeb.RelayHelpers.json_with_validator/3`'s
  # rationale for its own weak etags.
  defp weak_etag(path, mtime, size) do
    hash =
      :crypto.hash(:sha256, :erlang.term_to_binary({path, mtime, size}))
      |> Base.encode16(case: :lower)
      |> binary_part(0, 32)

    ~s(W/"#{hash}")
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
