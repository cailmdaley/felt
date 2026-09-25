defmodule Shuttle.OriginRouter do
  @moduledoc """
  Owner-routing for the kanban write plane — the single forwarder behind every
  write endpoint.

  Every kanban mutation targets a fiber owned by exactly one daemon. The
  composite board (`GET /api/v1/fibers/composite`) stamps each fiber with its
  owning `origin`; a write carries that origin back so the local daemon can
  either act (origin is itself) or forward to the owning remote over the SSH
  tunnel. `/transition`, `/felt-edit`, `/lifecycle`, and `/dispatch` all route
  through here, so owner-routing has ONE implementation that cannot drift
  per-verb (the same discipline `Shuttle.Transition` keeps for `invoke/2` +
  `http_error/1`). `/dispatch` carries the STORE-3 `user_message` + `resume_mode`
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

  **Safety, and its limit.** An `origin` that matches no configured remote falls
  through to `:local`, where the endpoint's own resolution is the final arbiter
  — a mis-stamped origin degrades to a clean local "fiber not found" /
  availability error, never a silent wrong-host write.

  That argument holds for a **fiber-addressed** write and only for one. A fiber
  lives on exactly one host, so a local daemon asked for one it does not own
  answers "not found" and nothing happens. A **host-addressed** write — a
  config file, a store list, a tunnel job — has no such arbiter: every host has
  a `~/.config/felt/stores.json`, so degrading finds a perfectly good local file
  and writes it, under a UI header naming a different machine. Those endpoints
  use `route_host/2`, which refuses instead.
  """

  alias Shuttle.{Poller, RegistryCommon, Remote}

  require Logger

  @default_forward_timeout_ms 30_000

  @typedoc """
  Where a write should execute: `:local` runs the endpoint's own handler here;
  `{:remote, remote}` forwards to the owning daemon.
  """
  @type route_decision :: :local | {:remote, Remote.t()}

  @typedoc """
  `route_host/2`'s answer: the two above, plus the refusal a host-addressed
  endpoint needs when the named host is not one this daemon can reach.
  """
  @type host_route_decision :: route_decision() | {:error, {:unknown_origin, String.t()}}

  @doc """
  Decide whether a write for a fiber stamped with `origin` runs locally or
  forwards to a remote owner.

  `nil` / `""` / `"local"` / this daemon's own host id → `:local`. An origin
  matching a configured remote → `{:remote, remote}`. Any other (unknown)
  origin → `:local` (the endpoint's own resolution is the final arbiter — see
  the moduledoc's Safety note), but LOUDLY: a non-empty origin that
  reached here without matching local OR any configured remote is
  "remote-shaped" — the composite board only ever stamps an origin that is
  either this daemon or a name from `:remotes` — so this is either a stale
  remote list (a remote was renamed/removed since the board cached it) or a
  genuine misconfiguration, either of which deserves a log, not a silent
  degrade. `Logger.warning` rather than raising: silently falling to `:local`
  was already deliberately safe (never a wrong-host write), only the silence
  itself was the gap.

  Opts (for tests / explicit wiring): `:own_host_id`, `:remotes`.
  """
  @spec route(String.t() | nil, keyword()) :: route_decision()
  def route(origin, opts \\ []) do
    own = Keyword.get(opts, :own_host_id) || Poller.own_host_id()

    cond do
      origin in [nil, "", "local", own] ->
        :local

      true ->
        # Origin routing resolves the fleet through the ONE chokepoint
        # (`RegistryCommon.configured_remotes/1`) that the registries and the
        # felt-stores controller also use — so a remote this daemon polls for
        # visibility and a remote it routes writes to are guaranteed to agree,
        # both in where the list comes from and in how it parses.
        remotes = RegistryCommon.configured_remotes(opts)

        case Enum.find(remotes, &(&1.name == origin)) do
          %Remote{} = remote ->
            {:remote, remote}

          nil ->
            Logger.warning(
              "OriginRouter: origin #{inspect(origin)} matches neither this daemon " <>
                "(#{inspect(own)}) nor any configured remote " <>
                "(#{inspect(Enum.map(remotes, & &1.name))}) " <>
                "— degrading to :local; the endpoint's own resolution is the final arbiter."
            )

            :local
        end
    end
  end

  @doc """
  Route a **host-addressed** request, refusing an origin this daemon cannot
  place instead of degrading to local.

  The difference from `route/2` is one branch and it is the whole point. A
  fiber-addressed write can degrade safely, because the local daemon will not
  find a fiber it does not own. A host-addressed write cannot: every host has
  the files these endpoints touch, so a degraded origin does not fail — it
  succeeds, on the wrong machine, and answers 200. The realistic way to get
  there needs no exotic input at all: a settings page open on one host while
  the fleet file changes underneath, and the next save lands here.

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

    "unknown host #{inspect(origin)} — this daemon knows #{Enum.map_join(known, ", ", &inspect/1)}. " <>
      "Refusing rather than writing this host's own files under that name."
  end

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
    timeout = Keyword.get(opts, :forward_timeout_ms, @default_forward_timeout_ms)
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
    timeout = Keyword.get(opts, :forward_timeout_ms, @default_forward_timeout_ms)
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = Remote.url_for(remote, path) <> "?" <> URI.encode_query(stripped)

    case client.get_file(url, timeout) do
      {:ok, status, content_type, body} -> {:forwarded, status, content_type, body}
      {:error, reason} -> {:error, {:forward_failed, remote.name, reason}}
    end
  end

  @doc """
  Forward a file GET with conditional request headers and retain the response
  validators for the caller. The owner's `ETag`, `Last-Modified`, and cache
  policy can then reach the browser, while a 304 crosses the same tunnel as a
  bodyless response.

  Clients without `get_file/3` use their binary-safe `get_file/2` callback and
  return no response validators. This keeps older transport adapters functional;
  callers still receive a 200 body and can compare its content locally.
  """
  @spec forward_file_get(Remote.t(), String.t(), map(), [{String.t(), String.t()}], keyword()) ::
          {:forwarded, non_neg_integer(), [{String.t(), String.t()}], String.t(), binary()}
          | {:error, term()}
  def forward_file_get(%Remote{} = remote, path, query, req_headers, opts \\ [])
      when is_map(query) and is_list(req_headers) do
    client = forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, @default_forward_timeout_ms)
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = Remote.url_for(remote, path) <> "?" <> URI.encode_query(stripped)

    response =
      if Code.ensure_loaded?(client) and function_exported?(client, :get_file, 3) do
        client.get_file(url, req_headers, timeout)
      else
        client.get_file(url, timeout)
      end

    case response do
      {:ok, status, headers, content_type, body} when is_list(headers) ->
        {:forwarded, status, headers, content_type, body}

      {:ok, status, content_type, body} ->
        {:forwarded, status, [], content_type, body}

      {:error, reason} ->
        {:error, {:forward_failed, remote.name, reason}}
    end
  end

  @doc """
  The cross-host transport module — the ONE place `:write_forward_client` is
  resolved, so a test stubs every cross-host request at a single point.

  Public so a caller that needs the transport without a forward reads it here
  rather than re-reading the config key.
  """
  @spec forward_client() :: module()
  def forward_client do
    Application.get_env(:shuttle, :write_forward_client, Shuttle.RemoteRegistry.Client.Default)
  end
end
