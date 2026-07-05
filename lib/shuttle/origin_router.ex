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

  **Safety:** an `origin` that matches no configured remote falls through to
  `:local`, where the endpoint's own resolution is the final arbiter — a
  mis-stamped origin degrades to a clean local "fiber not found" / availability
  error, never a silent wrong-host write.
  """

  alias Shuttle.{Poller, RegistryCommon, Remote}

  require Logger

  @default_forward_timeout_ms 30_000

  @typedoc """
  Where a write should execute: `:local` runs the endpoint's own handler here;
  `{:remote, remote}` forwards to the owning daemon.
  """
  @type route_decision :: :local | {:remote, Remote.t()}

  @doc """
  Decide whether a write for a fiber stamped with `origin` runs locally or
  forwards to a remote owner.

  `nil` / `""` / `"local"` / this daemon's own host id → `:local`. An origin
  matching a configured remote → `{:remote, remote}`. Any other (unknown)
  origin → `:local` (the endpoint's own resolution is the final arbiter — see
  the moduledoc's Safety note), but LOUDLY now (C6): a non-empty origin that
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
        case find_remote(origin, opts) do
          %Remote{} = remote ->
            {:remote, remote}

          nil ->
            Logger.warning(
              "OriginRouter: origin #{inspect(origin)} matches neither this daemon " <>
                "(#{inspect(own)}) nor any configured remote (#{inspect(configured_remote_names(opts))}) " <>
                "— degrading to :local; the endpoint's own resolution is the final arbiter."
            )

            :local
        end
    end
  end

  defp configured_remote_names(opts), do: opts |> configured_remotes() |> Enum.map(& &1.name)

  defp find_remote(origin, opts) do
    opts
    |> configured_remotes()
    |> Enum.find(&(&1.name == origin))
  end

  # C6: the ONE place `:remotes` config is read and normalized for origin
  # routing — `RegistryCommon.normalize_remotes/1` is the same primitive
  # `Shuttle.RemoteRegistry`/`Shuttle.RemoteFiberRegistry` already use, so a
  # remote this daemon polls for visibility and a remote it routes writes to
  # are guaranteed to agree; before C6 this module (and
  # `ShuttleWeb.FeltStoresController`) called `Remote.from_config_list/1`
  # directly instead — two parse entry points that could drift if either
  # gained normalization the other didn't.
  defp configured_remotes(opts) do
    opts
    |> Keyword.get(:remotes, Application.get_env(:shuttle, :remotes, []))
    |> RegistryCommon.normalize_remotes()
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

  Opts: `:client` (transport stub), `:forward_timeout_ms`.
  """
  @spec forward(Remote.t(), String.t(), map(), keyword()) ::
          {:forwarded, non_neg_integer(), String.t()} | {:error, term()}
  def forward(%Remote{} = remote, path, payload, opts \\ []) when is_map(payload) do
    client = Keyword.get(opts, :client) || forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, @default_forward_timeout_ms)
    url = remote_url(remote, path)
    body = payload |> Map.delete("origin") |> Map.delete(:origin) |> Jason.encode!()

    case client.post(url, body, "application/json", timeout) do
      {:ok, status, resp} -> {:forwarded, status, resp}
      {:error, reason} -> {:error, {:forward_failed, remote.name, reason}}
    end
  end

  @doc """
  Forward a GET to the owning remote daemon's identical `path` with `query`
  appended as a query string (the `origin` key stripped, so the owner serves the
  fiber as local). Used by the file-bytes route (`/api/v1/file`): only the owning
  daemon can read its own host's filesystem, so a remote-owned embed/asset must
  be fetched from that daemon, not this one's git mirror.

  Returns `{:forwarded, status, content_type, body}` — the remote's raw bytes and
  content type for the caller to relay verbatim — or `{:error, {:forward_failed,
  name, reason}}` on a tunnel failure. The body is binary-safe (images, PDFs),
  unlike the text-only feed `get/2`.

  Opts: `:client` (transport stub), `:forward_timeout_ms`.
  """
  @spec forward_get(Remote.t(), String.t(), map(), keyword()) ::
          {:forwarded, non_neg_integer(), String.t(), binary()} | {:error, term()}
  def forward_get(%Remote{} = remote, path, query, opts \\ []) when is_map(query) do
    client = Keyword.get(opts, :client) || forward_client()
    timeout = Keyword.get(opts, :forward_timeout_ms, @default_forward_timeout_ms)
    stripped = query |> Map.delete("origin") |> Map.delete(:origin)
    url = remote_url(remote, path) <> "?" <> URI.encode_query(stripped)

    case client.get_file(url, timeout) do
      {:ok, status, content_type, body} -> {:forwarded, status, content_type, body}
      {:error, reason} -> {:error, {:forward_failed, remote.name, reason}}
    end
  end

  defp remote_url(%Remote{url: url}, path) do
    String.trim_trailing(url, "/") <> path
  end

  # The write-plane forward transport. One config key for every write endpoint's
  # cross-host POST, so a test stubs the whole forward plane at a single point.
  defp forward_client do
    Application.get_env(:shuttle, :write_forward_client, Shuttle.RemoteRegistry.Client.Default)
  end
end
