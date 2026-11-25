defmodule ShuttleWeb.FileController do
  @moduledoc """
  Serve file/asset bytes by absolute path: `GET /api/v1/file?path=…&origin=…`,
  report-relative assets via `GET /api/v1/file-assets/:origin/*path`, and
  metadata-only change probes via `GET /api/v1/file-info?path=…&origin=…`.

  Reader pages and overview thumbnails fetch HTML, text, and native media
  bytes from their owning host. The fiber route supplies markdown; this file
  route supplies embeds, opened links, and relative assets. Only the owning
  daemon can read its host's filesystem.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/kill` and
  `/felt-edit`.** The composite board stamps each fiber with its `origin`; the
  reader carries that origin back. A local-owned path is read here; a
  remote-owned path forwards to the owning daemon's identical `/file` (origin
  stripped) and relays its bytes, content type, range
  metadata, and cache validators (`OriginRouter.forward_file_get/5`). Every
  file and asset response, including errors and remote relays, receives a CSP
  sandbox and `nosniff` from the endpoint's `ShuttleWeb.FileSecurityPlug`.

  **Path contract.** `path` must be ABSOLUTE — the reader resolves a fiber's
  `:::{embed} <rel>` against the fiber's own directory client-side before
  calling, and an absolute embed (a paper build outside `.felt/`) is passed
  through as-is. There is deliberately no felt-store sandbox: the constitution
  wants paper builds outside any store to render, and the trust model is the
  localhost/trusted-cluster daemon the rest of the API already assumes (it shells
  out to felt over arbitrary stores). The report-asset route restores the leading
  slash omitted by URL paths, then uses this same owner-routing and absolute-path
  validation. A relative path is a 400; `/file` returns 404 for a missing file,
  while `/file-info` reports `exists: false`; neither 500s the reader.

  **A sent path falls back to its copy.** Sending a file copies it, from the
  sender's own process, into the host's copy store (`Shuttle.SentFiles`
  reads each send's `copies`). A local path is served from the file itself
  when this daemon can read it, so a sent report that is still being rewritten
  stays live and its relative figures resolve; otherwise from the copy the
  newest send of that path took (`Shuttle.EventStream.sent_copy/2`). Only a
  path with neither answers 404, or 403 when the file is there but this
  daemon cannot read it. The content type is always the requested path's.

  **No open can hang a request.** macOS holds an open of a file in a folder
  it keeps from launchd processes while a consent prompt nobody sees waits,
  and a stalled mount holds every open beneath it. Before `/file` touches a
  path, `ShuttleWeb.FolderAccess` says whether opens in its folder return; a
  folder whose opens hang answers 403 within the probe's deadline the first
  time and at once after. `/file-info` never opens a file: it answers from
  `stat` and adds `readable: false` when the file's mode bars this daemon or
  its folder is known to hang. The owner-routed leg relays the owner's answer.

  **Conditional and range reads on both owner legs.** Small GETs use a content
  digest. A whole GET of a larger document (up to 64 MiB, not media) uses its
  digest too, read once per settled version by `ShuttleWeb.FileDigests`;
  other reads of files above one MiB use that remembered digest or a weak
  size/mtime/inode validator without reading their bytes. A whole GET never
  honours the weak validator once it has the digest, so a same-second rewrite
  cannot be answered 304. Small HEADs omit the digest rather than read the body.
  `If-None-Match` can return a bodyless 304; byte ranges return 206 or 416,
  and `If-Range` dates can authorize a range while weak entity tags cannot. The
  owner-routed leg forwards these request headers and relays the owner's
  validators and range metadata. `/file-info` remains available for
  metadata-only probes used by other artifact types.

  **A page loaded into a frame** (`Sec-Fetch-Dest: iframe`, an HTML path) is
  read whole from its owner and served with the UI bundle's
  `framed-runtime.js` at its head, so WebKit can free it (see
  `with_framed_runtime/2`).
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [relay_bytes: 2, relay_file_bytes: 2]

  alias Shuttle.OriginRouter

  @digest_limit 1024 * 1024
  @hash_limit 64 * 1024 * 1024
  @range_limit 4 * 1024 * 1024

  @media_types %{
    ".mp3" => "audio/mpeg",
    ".wav" => "audio/wav",
    ".m4a" => "audio/mp4",
    ".aac" => "audio/aac",
    ".ogg" => "audio/ogg",
    ".oga" => "audio/ogg",
    ".flac" => "audio/flac",
    ".opus" => "audio/ogg",
    ".mp4" => "video/mp4",
    ".m4v" => "video/x-m4v",
    ".mov" => "video/quicktime",
    ".webm" => "video/webm"
  }

  # POSIX mtime (per `time: :posix`) is seconds since 1970; Erlang's gregorian
  # seconds count from year 0. `http_date/1` uses
  # this offset to convert between the two, without ever touching a timezone.
  @gregorian_epoch_offset :calendar.datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}})

  def show(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    if framed_page?(conn, path),
      do: serve_framed(conn, path, Map.get(params, "origin")),
      else: serve(conn, path, Map.get(params, "origin"))
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  defp serve(conn, path, origin) do
    case OriginRouter.route(origin) do
      {:error, {:unknown_origin, origin}} ->
        ShuttleWeb.RelayHelpers.unknown_origin(conn, origin)

      {:remote, remote} ->
        relay_file_bytes(
          conn,
          OriginRouter.forward_file_get(
            remote,
            "/api/v1/file",
            %{"path" => path},
            conditional_headers(conn),
            method: if(head_request?(conn), do: :head, else: :get)
          )
        )

      :local ->
        serve_local(conn, path)
    end
  end

  # An HTML page the browser loads into a frame, such as a deck framed inside a
  # report. The board injects its runtime into the documents it frames itself,
  # but not into the frames those documents hold. WebKit never frees a
  # document whose script asked a lone tag or class query, so the page gets
  # the bundle's `framed-runtime.js` at its head, which asks such queries as
  # lists. A page that cannot be read whole is served as it is. Browsers send
  # `Sec-Fetch-Dest` only to trustworthy origins, so over plain http to a
  # tailnet host a report-relative asset with no header counts as framed.
  defp framed_page?(conn, path) do
    framed? =
      case get_req_header(conn, "sec-fetch-dest") do
        [dest] -> dest in ["iframe", "frame"]
        [] -> conn.assigns[:report_asset] == true
        _ -> false
      end

    framed? and conn.method == "GET" and not head_request?(conn) and
      get_req_header(conn, "range") == [] and MIME.from_path(path) == "text/html"
  end

  defp serve_framed(conn, path, origin) do
    with {:ok, runtime} <-
           Shuttle.FS.read(Path.join(ShuttleWeb.Assets.dist(), "framed-runtime.js")),
         {:ok, body} <- framed_body(path, origin) do
      page = with_framed_runtime(body, runtime)
      etag = weak_etag(page)

      conn =
        conn
        |> put_resp_header("cache-control", "no-cache")
        |> put_resp_header("vary", "sec-fetch-dest")
        |> put_resp_header("etag", etag)

      if not_modified?(conn, etag, nil),
        do: send_resp(conn, 304, ""),
        else: conn |> put_resp_content_type(MIME.from_path(path)) |> send_resp(200, page)
    else
      {:relay, forwarded} -> relay_file_bytes(conn, forwarded)
      {:resolved, resolution} -> serve_resolved(conn, path, resolution)
      _ -> serve(conn, path, origin)
    end
  end

  # The page's whole body, else what to serve instead: the owner's answer to
  # relay, or a local path's resolution, so the path is resolved only once.
  defp framed_body(path, origin) do
    case OriginRouter.route(origin) do
      {:remote, remote} ->
        case OriginRouter.forward_file_get(remote, "/api/v1/file", %{"path" => path}, []) do
          {:forwarded, 200, _headers, _content_type, body}
          when is_binary(body) and byte_size(body) <= @hash_limit ->
            {:ok, body}

          {:forwarded, 200, _headers, _content_type, _body} ->
            :error

          forwarded ->
            {:relay, forwarded}
        end

      :local ->
        if Path.type(path) == :absolute, do: framed_local(path), else: :error

      _ ->
        :error
    end
  end

  defp framed_local(path) do
    case resolve(path) do
      {:ok, source, %File.Stat{size: size}} = found when size <= @hash_limit ->
        case Shuttle.FS.read(source) do
          {:ok, body} -> {:ok, body}
          {:error, _reason} -> {:resolved, found}
        end

      resolution ->
        {:resolved, resolution}
    end
  end

  @doc false
  # After the head's opening tag, else the html element's, else the doctype, so
  # the page keeps its rendering mode and the script runs before its own.
  def with_framed_runtime(page, runtime) do
    script =
      "<script data-shuttle-framed-runtime>" <>
        String.replace(runtime, "</", "<\\/") <> "</script>"

    at =
      Enum.find_value(
        [~r/<head\b[^>]*>/i, ~r/<html\b[^>]*>/i, ~r/<!doctype\b[^>]*>/i],
        0,
        fn tag ->
          case Regex.run(tag, page, return: :index) do
            [{start, length}] -> start + length
            nil -> nil
          end
        end
      )

    binary_part(page, 0, at) <> script <> binary_part(page, at, byte_size(page) - at)
  end

  @doc """
  Serve a report-relative asset under an owner-prefixed URL.

  The route wildcard omits the filesystem root; restoring it here sends the
  path through `/file`'s owner routing, absolute-path validation, and byte
  serving unchanged.
  """
  def asset(conn, %{"origin" => origin, "path" => segments})
      when is_binary(origin) and is_list(segments) and segments != [] do
    conn
    |> assign(:report_asset, true)
    |> show(%{"origin" => origin, "path" => Path.join(["/" | segments])})
  end

  def asset(conn, _params), do: show(conn, %{})

  @doc """
  Return cheap metadata for a file without reading its bytes.

  The board uses this metadata probe for browser-native artifacts that are not
  rendered through the live text/HTML reader. A missing path is a successful response
  with `exists: false`, so a report that is still being written can be detected
  when it appears without treating an expected absence as a transport error.
  """
  def info(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:error, {:unknown_origin, origin}} ->
        ShuttleWeb.RelayHelpers.unknown_origin(conn, origin)

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
    if Path.type(path) != :absolute,
      do: relative_path(conn),
      else: info_json(conn, info_for(path))
  end

  # A file's metadata without opening it: its own when this daemon may read
  # it, else its sent copy's, else what is known of it.
  defp info_for(path) do
    local =
      if ShuttleWeb.FolderAccess.cached(path) == :hangs,
        do: {:unreadable, nil},
        else: info_stat(path)

    case {local, sent_copy(path)} do
      {{:ok, stat}, _copy} -> stat_info(stat)
      {_local, {:ok, _stored, stat}} -> stat_info(stat)
      {{:unreadable, nil}, nil} -> %{exists: true, readable: false}
      {{:unreadable, stat}, nil} -> Map.put(stat_info(stat), :readable, false)
      {:missing, nil} -> %{exists: false}
    end
  end

  defp info_stat(path) do
    case Shuttle.FS.stat(path, time: :posix) do
      {:ok, %File.Stat{type: :regular, access: access} = stat}
      when access in [:read, :read_write] ->
        {:ok, stat}

      {:ok, %File.Stat{type: :regular} = stat} ->
        {:unreadable, stat}

      _ ->
        :missing
    end
  end

  defp stat_info(stat), do: %{exists: true, modified_at: stat.mtime, size: stat.size}

  defp info_json(conn, body) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> json(body)
  end

  defp serve_local(conn, path) do
    if Path.type(path) != :absolute,
      do: relative_path(conn),
      else: serve_resolved(conn, path, resolve(path))
  end

  defp relative_path(conn), do: conn |> put_status(400) |> json(%{error: "path must be absolute"})

  defp serve_resolved(conn, path, {:ok, source, stat}),
    do: serve_with_validators(conn, {path, source}, stat)

  defp serve_resolved(conn, _path, {:unreadable, reason}) do
    conn
    |> put_status(403)
    |> json(%{error: "owner could not read file", detail: unreadable_detail(reason)})
  end

  defp serve_resolved(conn, _path, :missing), do: file_not_found(conn)

  # Where an absolute local path's bytes come from, decided once per request:
  # the regular file itself when this daemon can open it, else the copy the
  # newest send of that path took. Nothing in a folder whose opens hang is
  # touched.
  defp resolve(path) do
    case ShuttleWeb.FolderAccess.verdict(path) do
      :hangs ->
        sent_copy(path) || {:unreadable, :timeout}

      :returns ->
        case Shuttle.FS.stat(path, time: :posix) do
          {:ok, %File.Stat{type: :regular} = stat} ->
            case Shuttle.FS.open(path, [:read]) do
              {:ok, fd} ->
                Shuttle.FS.close(fd)
                {:ok, path, stat}

              {:error, reason} ->
                sent_copy(path) || {:unreadable, reason}
            end

          _ ->
            sent_copy(path) || :missing
        end
    end
  end

  # The newest retained send's copy of `path`, a regular file inside the copy
  # store and no link out of it.
  defp sent_copy(path) do
    with stored when is_binary(stored) <- Shuttle.EventStream.sent_copy(Path.expand(path)),
         {:ok, %File.Stat{type: :regular} = stat} <- Shuttle.FS.lstat(stored, time: :posix) do
      {:ok, stored, stat}
    else
      _ -> nil
    end
  end

  defp unreadable_detail(:timeout),
    do: "opening it did not finish within #{ShuttleWeb.FolderAccess.deadline_ms()} ms"

  defp unreadable_detail(reason), do: "opening it failed: #{reason}"

  # `file` is the requested path, which names the representation (its content
  # type and media handling), and the source its bytes are read from: the
  # path itself or its sent copy.
  defp serve_with_validators(conn, {path, source} = file, stat) do
    cond do
      stat.size > @digest_limit ->
        metadata = ~s(W/"stat-#{stat.mtime}-#{stat.size}-#{stat.inode}")

        etag =
          case large_digest(conn, path, source, stat) do
            nil -> metadata
            digest -> ~s(W/"sha256-#{digest}")
          end

        serve_representation(conn, file, nil, stat.mtime, stat.size, etag)

      head_request?(conn) ->
        serve_representation(conn, file, nil, stat.mtime, stat.size, nil)

      true ->
        # Hash and serve the same small snapshot, including same-second rewrites.
        case Shuttle.FS.read(source) do
          {:ok, body} ->
            serve_representation(conn, file, body, stat.mtime, byte_size(body), weak_etag(body))

          {:error, _reason} ->
            file_not_found(conn)
        end
    end
  end

  # A large document a reader polls whole is named by its content digest, read
  # once per settled version (`ShuttleWeb.FileDigests`), so an unchanged poll is
  # a 304 instead of the whole file again. Media and ranged reads stay bounded:
  # they use a remembered digest when there is one and never read to make one.
  defp large_digest(conn, path, source, stat) do
    whole_document? =
      not head_request?(conn) and get_req_header(conn, "range") == [] and
        stat.size <= @hash_limit and
        not Map.has_key?(@media_types, String.downcase(Path.extname(path)))

    if whole_document? do
      case ShuttleWeb.FileDigests.digest(source, stat) do
        {:ok, digest} -> digest
        :error -> nil
      end
    else
      ShuttleWeb.FileDigests.lookup(source, stat)
    end
  end

  defp serve_representation(conn, file, body, mtime, size, etag) do
    conn =
      conn
      |> put_resp_header("last-modified", http_date(mtime))
      |> put_resp_header("cache-control", "public, max-age=300")

    conn = if etag, do: put_resp_header(conn, "etag", etag), else: conn

    cond do
      not_modified?(conn, etag, mtime) ->
        send_resp(conn, 304, "")

      head_request?(conn) ->
        send_full(conn, file, nil, size)

      true ->
        case requested_range(conn, etag, mtime, size) do
          {:partial, first, last} -> send_partial(conn, file, body, size, first, last)
          :unsatisfiable -> send_unsatisfiable(conn, file, size)
          :ignore -> send_full(conn, file, body, size)
        end
    end
  end

  defp send_full(conn, {path, source}, body, size) do
    conn =
      conn
      |> representation_headers(path)
      |> put_resp_header("content-length", Integer.to_string(size))

    cond do
      head_request?(conn) -> send_resp(conn, 200, "")
      is_binary(body) -> send_resp(conn, 200, body)
      true -> send_file(conn, 200, source, 0, size)
    end
  end

  defp send_partial(conn, {path, source}, body, size, first, last) do
    length = last - first + 1

    conn =
      conn
      |> representation_headers(path)
      |> put_resp_header("content-range", "bytes #{first}-#{last}/#{size}")
      |> put_resp_header("content-length", Integer.to_string(length))

    if is_binary(body) do
      send_resp(conn, 206, binary_part(body, first, length))
    else
      send_file(conn, 206, source, first, length)
    end
  end

  # Plug.Head rewrites conn.method to GET; Bandit and the test adapter retain
  # the wire method so HEAD can skip all representation-body I/O.
  defp head_request?(%{adapter: {_, %{method: "HEAD"}}}), do: true
  defp head_request?(conn), do: conn.method == "HEAD"

  defp send_unsatisfiable(conn, {path, _source}, size) do
    conn
    |> representation_headers(path)
    |> put_resp_header("content-range", "bytes */#{size}")
    |> put_resp_header("content-length", "0")
    |> send_resp(416, "")
  end

  defp representation_headers(conn, path) do
    conn =
      case Map.fetch(@media_types, String.downcase(Path.extname(path))) do
        {:ok, content_type} -> put_resp_content_type(conn, content_type, nil)
        :error -> put_resp_content_type(conn, MIME.from_path(path))
      end

    # A page loaded into a frame is served with the framed runtime at its head.
    conn =
      if MIME.from_path(path) == "text/html",
        do: put_resp_header(conn, "vary", "sec-fetch-dest"),
        else: conn

    put_resp_header(conn, "accept-ranges", "bytes")
  end

  defp file_not_found(conn), do: conn |> put_status(404) |> json(%{error: "file not found"})

  defp requested_range(conn, etag, mtime, size) do
    case get_req_header(conn, "range") do
      [range] ->
        if if_range_matches?(conn, etag, mtime), do: parse_byte_range(range, size), else: :ignore

      _ ->
        :ignore
    end
  end

  defp if_range_matches?(conn, etag, mtime) do
    case get_req_header(conn, "if-range") do
      [] ->
        true

      [value] ->
        value = String.trim(value)

        if strong_entity_tag?(value) and strong_entity_tag?(etag) do
          value == etag
        else
          case parse_http_date(value) do
            {:ok, date} -> date == mtime
            :error -> false
          end
        end

      _ ->
        false
    end
  end

  defp strong_entity_tag?(tag),
    do: String.starts_with?(tag, "\"") and String.ends_with?(tag, "\"")

  defp parse_http_date(value) do
    case :httpd_util.convert_request_date(String.to_charlist(value)) do
      {{year, month, day}, {hour, minute, second}} = datetime
      when year > 0 and month in 1..12 and day in 1..31 and hour in 0..23 and minute in 0..59 and
             second in 0..60 ->
        gregorian_seconds = :calendar.datetime_to_gregorian_seconds(datetime)
        {:ok, gregorian_seconds - @gregorian_epoch_offset}

      _ ->
        :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  defp parse_byte_range(range, size) do
    case Regex.run(~r/\Abytes=(\d*)-(\d*)\z/i, String.trim(range)) do
      [_, "", ""] ->
        :ignore

      [_, "", suffix] ->
        suffix_range(String.to_integer(suffix), size)

      [_, first, ""] ->
        first = String.to_integer(first)
        bounded_range(first, first + @range_limit - 1, size)

      [_, first, last] ->
        bounded_range(String.to_integer(first), String.to_integer(last), size)

      _ ->
        :ignore
    end
  end

  defp suffix_range(0, _size), do: :unsatisfiable
  defp suffix_range(_length, 0), do: :unsatisfiable

  defp suffix_range(length, size),
    do: {:partial, max(size - length, 0), size - 1}

  defp bounded_range(first, last, _size) when last < first, do: :ignore

  defp bounded_range(first, last, size) do
    if size == 0 or first >= size do
      :unsatisfiable
    else
      {:partial, first, min(last, size - 1)}
    end
  end

  # Only the ETag decides a 304. `If-Modified-Since` alone never does:
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
      candidate == "*" or (etag != nil and weak_tag(candidate) == weak_tag(etag))
    end)
  end

  defp weak_tag("W/" <> tag), do: tag
  defp weak_tag(tag), do: tag

  defp conditional_headers(conn) do
    ["if-none-match", "if-modified-since", "range", "if-range"]
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
