defmodule Shuttle.OriginRouter do
  @moduledoc """
  Owner-routing for the kanban write plane — the single forwarder behind every
  write endpoint.

  Every kanban mutation targets a fiber owned by exactly one daemon. The
  composite board (`GET /api/v1/fibers/composite`) stamps each fiber with its
  owning `origin`; a write carries that origin back so the local daemon can
  either act (origin is itself) or forward to the owning remote over the SSH
  tunnel. `/transition`, `/felt-edit`, `/lifecycle`, `/dispatch`, and
  `/attachments` all route through here, so owner-routing has ONE implementation that cannot drift
  per-verb (the same discipline `Shuttle.Transition` keeps for `invoke/2` +
  `http_error/1`). `/dispatch` carries the `user_message` + `resume_mode`
  in its forwarded body, so a remote-owned card's directive owner-routes intact.

    * `route/2` decides local vs remote from the carried origin.
    * `forward/4` relays a POST to the owning remote's identical path with
      `origin` omitted, returning the remote's verbatim `{:forwarded, status,
      body}` so the caller can relay it.

  Terminating in one hop: a fiber has exactly one owner, and the owner runs the
  forwarded request as local (its origin is `nil` after stripping), so it never
  re-forwards. No felt-store registration is needed in the forward — a remote
  only serves a fiber in its owner feed when it already owns the store, so the
  store is configured by construction by the time the kanban can route to it.

  Explicit origins are authoritative: an unknown origin is refused before any
  local lookup, read or write. Git mirrors and host-local paths can exist on
  multiple hosts, so local resolution cannot establish the intended destination.
  An absent origin means this daemon. `route_host/2` shares the same decision.
  """

  alias Shuttle.{Poller, RegistryCommon, Remote}

  # A forwarded write waits for the owner's longest Poller call plus transit, so
  # the owner always answers (even "still busy") before this hop gives up.
  @forward_transit_margin_ms 10_000
  # A forwarded read serves the owner's files and feeds, not a Poller call.
  @read_forward_timeout_ms 30_000
  @stream_connect_timeout_ms 15_000
  @file_range_limit 4 * 1024 * 1024
  @file_error_limit 64 * 1024

  @typedoc """
  Where a write should execute: `:local` runs the endpoint's own handler here;
  `{:remote, remote}` forwards to the owning daemon.
  """
  @type route_decision :: :local | {:remote, Remote.t()} | {:error, {:unknown_origin, String.t()}}

  @typedoc """
  Host-addressed requests use the same fail-closed decision as fiber requests.
  """
  @type host_route_decision :: route_decision()

  @doc """
  Decide whether a write for a fiber stamped with `origin` runs locally or
  forwards to a remote owner.

  `nil` / `""` / `"local"` / this daemon's own host id → `:local`.
  A configured remote → `{:remote, remote}`.
  Every other explicit origin → `{:error, {:unknown_origin, origin}}`.

  Opts (for tests / explicit wiring): `:own_host_id`, `:remotes`.
  """
  @spec route(String.t() | nil, keyword()) :: route_decision()
  def route(origin, opts \\ []), do: route_host(origin, opts)

  @doc """
  Route a host-addressed request, refusing an origin outside this daemon's fleet.

  `{:error, {:unknown_origin, name}}` for a non-empty origin that is neither
  this daemon nor a configured remote. `nil` / `""` / `"local"` / this host's
  own id are still `:local` — an unaddressed request means "here", which is
  every existing caller's meaning.
  """
  @spec route_host(String.t() | nil, keyword()) :: host_route_decision()
  def route_host(origin, opts \\ []) do
    own = Keyword.get(opts, :own_host_id) || Poller.own_host_id()

    if origin in [nil, "", "local", own] do
      :local
    else
      case Enum.find(RegistryCommon.configured_remotes(opts), &(&1.name == origin)) do
        %Remote{} = remote -> {:remote, remote}
        nil -> {:error, {:unknown_origin, origin}}
      end
    end
  end

  @doc """
  The sentence a refused host origin gets. One phrasing, so every endpoint says
  the same thing and names what this daemon can actually reach.
  """
  @spec unknown_origin_message(String.t(), keyword()) :: String.t()
  def unknown_origin_message(origin, opts \\ []) do
    own = Keyword.get(opts, :own_host_id) || Poller.own_host_id()
    known = [own | Enum.map(RegistryCommon.configured_remotes(opts), & &1.name)]

    "unknown origin #{inspect(origin)}: not in this daemon's fleet " <>
      "(known hosts: #{Enum.map_join(known, ", ", &inspect/1)})."
  end

  @doc """
  How long a forwarded write waits for the owner by default: the owner's longest Poller
  call (`Shuttle.Poller.dispatch_call_timeout_ms/0`) plus a transit margin. The
  owner therefore answers a slow launch itself, and a client waiting on this
  daemon must wait longer than this.
  """
  @spec default_forward_timeout_ms() :: pos_integer()
  def default_forward_timeout_ms,
    do: Poller.dispatch_call_timeout_ms() + @forward_transit_margin_ms

  @doc """
  Forward a write to the owning remote daemon's identical `path` (e.g.
  `"/api/v1/felt-edit"`). `payload` is the request body map; the `origin` key is
  stripped (string or atom) before sending, so the owner treats the fiber as
  local and runs its own handler.

  Returns `{:forwarded, status, body}` — the remote's verbatim response for the
  caller to relay — or `{:error, {:forward_failed, name, reason}}` when the
  tunnel POST fails. The body is left as the remote sent it (text or JSON); a
  caller that needs to rewrite it (e.g. `Shuttle.Transition` re-stamping
  `origin`) does so on top of this.

  Opts: `:forward_timeout_ms`.
  """
  @spec forward(Remote.t(), String.t(), map(), keyword()) ::
          {:forwarded, non_neg_integer(), String.t()} | {:error, term()}
  def forward(%Remote{} = remote, path, payload, opts \\ []) when is_map(payload) do
    client = forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, default_forward_timeout_ms())
    url = Remote.url_for(remote, path)
    body = payload |> Map.delete("origin") |> Map.delete(:origin) |> Jason.encode!()

    case client.post(url, body, "application/json", timeout) do
      {:ok, status, resp} -> {:forwarded, status, resp}
      {:error, reason} -> {:error, {:forward_failed, remote.name, reason}}
    end
  end

  @doc """
  Forward a GET to the owning remote daemon's identical `path` with `query`
  appended as a query string (the `origin` key stripped, so the owner serves the
  request as local). Used by owner-routed GETs that do not need request or
  response headers; file bytes with cache validators use `forward_file_get/4`.

  Returns `{:forwarded, status, content_type, body}` — the remote's raw bytes and
  content type for the caller to relay verbatim — or `{:error, {:forward_failed,
  name, reason}}` on a tunnel failure. The body is binary-safe (images, PDFs),
  unlike the text-only feed `get/2`. File bytes that need conditional headers use
  `forward_file_get/5`.

  Opts: `:forward_timeout_ms`.
  """
  @spec forward_get(Remote.t(), String.t(), map(), keyword()) ::
          {:forwarded, non_neg_integer(), String.t(), binary()} | {:error, term()}
  def forward_get(%Remote{} = remote, path, query, opts \\ []) when is_map(query) do
    client = forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, @read_forward_timeout_ms)
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = Remote.url_for(remote, path) <> "?" <> URI.encode_query(stripped)

    case client.get_file(url, timeout) do
      {:ok, status, content_type, body} -> {:forwarded, status, content_type, body}
      {:error, reason} -> {:error, {:forward_failed, remote.name, reason}}
    end
  end

  @doc """
  Open a flow-controlled GET to an owner, stripping `origin` from the query.

  Returns the client's opaque stream id or transport error without buffering
  the response. A client without `stream_get/4` returns
  `{:error, :stream_not_supported}`. Events go to `:owner` (the caller by
  default); `:req_headers` defaults to `[]` and `:connect_timeout_ms` to 15 s.
  The caller owns cancellation through `forward_client().stream_cancel/1`.
  """
  @spec forward_stream(Remote.t(), String.t(), map(), keyword()) ::
          {:ok, Shuttle.RemoteRegistry.Client.stream_id()} | {:error, term()}
  def forward_stream(%Remote{} = remote, path, query, opts \\ []) when is_map(query) do
    client = forward_client()
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = Remote.url_for(remote, path) <> "?" <> URI.encode_query(stripped)

    if Code.ensure_loaded?(client) and function_exported?(client, :stream_get, 4) do
      client.stream_get(
        url,
        Keyword.get(opts, :req_headers, []),
        Keyword.get(opts, :owner, self()),
        Keyword.get(opts, :connect_timeout_ms, @stream_connect_timeout_ms)
      )
    else
      {:error, :stream_not_supported}
    end
  end

  @doc """
  Forward a file GET with conditional and range request headers, retaining the
  owner's representation, range, and validator headers for the caller. A 206
  or 416 crosses the same tunnel with its byte metadata, and a 304 remains a
  bodyless response. Single ranges are shortened to at most four MiB before
  the request, including when the owner has no open-ended range cap. Invalid
  ranges retain the owner's ignore/416 semantics. Error bodies are truncated
  to 64 KiB after receipt; the transport still buffers them. Full GETs and
  If-Range fallbacks to 200 retain whole-response buffering.

  Clients without `get_file/3` use their binary-safe `get_file/2` callback and
  return no response headers. Both transport callback shapes are supported;
  callers still receive a body and can compare its content locally. With
  `method: :head`, use `head_file/3` and omit range headers; an unsupported
  client fails instead of substituting a body-reading GET.
  """
  @spec forward_file_get(Remote.t(), String.t(), map(), [{String.t(), String.t()}], keyword()) ::
          {:forwarded, non_neg_integer(), [{String.t(), String.t()}], String.t(), binary()}
          | {:error, term()}
  def forward_file_get(%Remote{} = remote, path, query, req_headers, opts \\ [])
      when is_map(query) and is_list(req_headers) do
    client = forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, @read_forward_timeout_ms)
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = Remote.url_for(remote, path) <> "?" <> URI.encode_query(stripped)

    Code.ensure_loaded?(client)

    response =
      case Keyword.get(opts, :method, :get) do
        :head ->
          headers =
            Enum.reject(req_headers, fn {name, _} ->
              String.downcase(name) in ["range", "if-range"]
            end)

          if function_exported?(client, :head_file, 3),
            do: client.head_file(url, headers, timeout),
            else: {:error, :head_not_supported}

        :get ->
          if function_exported?(client, :get_file, 3),
            do: client.get_file(url, bounded_file_headers(req_headers), timeout),
            else: client.get_file(url, timeout)
      end

    case response do
      {:ok, status, headers, content_type, body} when is_list(headers) ->
        {headers, body} = limit_file_error(status, headers, body)
        {:forwarded, status, headers, content_type, body}

      {:ok, status, content_type, body} ->
        {headers, body} = limit_file_error(status, [], body)
        {:forwarded, status, headers, content_type, body}

      {:error, reason} ->
        {:error, {:forward_failed, remote.name, reason}}
    end
  end

  defp bounded_file_headers(headers) do
    # Multiple Range fields are invalid; leave them intact for the owner to
    # ignore rather than turning them into a valid range request.
    if Enum.count(headers, fn {name, _} -> String.downcase(name) == "range" end) == 1 do
      Enum.map(headers, fn {name, value} ->
        if String.downcase(name) == "range",
          do: {name, bounded_file_range(value)},
          else: {name, value}
      end)
    else
      headers
    end
  end

  defp bounded_file_range(value) do
    case Regex.run(~r/\Abytes=(\d*)-(\d*)\z/i, String.trim(value)) do
      [_, "", suffix] when suffix != "" ->
        "bytes=-#{min(String.to_integer(suffix), @file_range_limit)}"

      [_, first, ""] when first != "" ->
        first = String.to_integer(first)
        "bytes=#{first}-#{first + @file_range_limit - 1}"

      [_, first, last] when first != "" and last != "" ->
        first = String.to_integer(first)
        last = String.to_integer(last)

        if last >= first,
          do: "bytes=#{first}-#{min(last, first + @file_range_limit - 1)}",
          else: value

      _ ->
        value
    end
  end

  defp limit_file_error(status, headers, body)
       when status >= 400 and byte_size(body) > @file_error_limit do
    headers = Enum.reject(headers, fn {name, _} -> String.downcase(name) == "content-length" end)
    headers = [{"content-length", Integer.to_string(@file_error_limit)} | headers]
    {headers, body |> binary_part(0, @file_error_limit) |> :binary.copy()}
  end

  defp limit_file_error(_status, headers, body), do: {headers, body}

  @doc """
  The cross-host transport module — the ONE place `:write_forward_client` is
  resolved, so a test stubs every cross-host request at a single point.

  Public so a caller that needs the transport without a forward reads it here
  rather than re-reading the config key.
  """
  @spec forward_client() :: module()
  def forward_client do
    Shuttle.Env.app(:write_forward_client, Shuttle.RemoteRegistry.Client.Default)
  end
end
