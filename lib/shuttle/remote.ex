defmodule Shuttle.Remote do
  @moduledoc """
  Configuration record for a remote Shuttle daemon this host polls for
  visibility.

  A remote is identified by `name` — the routing key everywhere. It must equal
  that daemon's own host id and the `shuttle.host` its fibers carry; origin
  stamping, `Shuttle.OriginRouter.route/2`, and `--remote NAME` all key off it.

  `url` is whatever local URL the SSH tunnel maps the remote daemon's
  `127.0.0.1:<remote_port>` to. Give a `port` and the URL derives from it
  (`http://127.0.0.1:<port>`); give a `url` outright for a remote reached
  without a locally-managed tunnel.

  Entries come from `Shuttle.Remotes` (the fleet file `~/.config/felt/remotes.json`)
  or from `config :shuttle, :remotes, [...]`. Each entry may be a map
  (string- or atom-keyed) or a keyword list.

  See [[constitution-shuttle-remote-dispatch]] for the cross-host contract:
  each daemon owns its host's `.felt/`, the hub is a viewer that composites
  snapshots over HTTP.
  """

  @enforce_keys [:name, :url]
  defstruct [
    :name,
    :url,
    :ssh,
    :display,
    :port,
    remote_port: 4_000,
    tunnel: %{manager: :launchd, multiplex: false, label: nil},
    enabled: true,
    poll_interval_ms: 5_000,
    request_timeout_ms: 2_000,
    stale_multiplier: 4
  ]

  @type tunnel :: %{
          manager: :launchd | :none,
          multiplex: boolean(),
          label: String.t() | nil
        }

  @type t :: %__MODULE__{
          name: String.t(),
          url: String.t(),
          ssh: String.t(),
          display: String.t(),
          port: pos_integer() | nil,
          remote_port: pos_integer(),
          tunnel: tunnel(),
          enabled: boolean(),
          poll_interval_ms: pos_integer(),
          request_timeout_ms: pos_integer(),
          stale_multiplier: pos_integer()
        }

  @default_remote_port 4_000

  @doc """
  Parses a single entry. Returns `nil` when the required fields are missing.

  Defaults:
    * `ssh` — `name` (the SSH destination usually IS the routing name; they
      diverge when ssh-config uses an alias)
    * `display` — `name`. Presentation only, never an address: two ways to name
      one origin is how a mis-stamped origin silently degrades to `:local`.
    * `url` — `http://127.0.0.1:<port>`
    * `remote_port` — 4000 (the daemon port on the far side of the tunnel)
    * `tunnel.manager` — `:launchd` on darwin, `:none` elsewhere (the same rule
      `cmd/shuttle_remotes.go` applies, so the installer and the daemon agree).
      `:none` skips the tunnel bounce in the recovery cascade and goes straight
      to the ssh check
    * `enabled` — true
    * `poll_interval_ms` — 5_000
    * `request_timeout_ms` — 2_000
    * `stale_multiplier` — 4 (entry becomes stale after
      `stale_multiplier × poll_interval_ms` without a successful poll ⇒
      20s at the 5s poll interval). Staleness is purely time-since-last-success,
      so this grace is the hysteresis: it tolerates a single 8s-timeout blip
      (and most double-blips) without flashing the badge, while still surfacing
      a genuine outage within ~20s.
  """
  @spec from_config(map() | keyword()) :: t() | nil
  def from_config(%__MODULE__{} = remote), do: remote

  def from_config(%{} = entry) do
    name = fetch(entry, :name)
    port = fetch(entry, :port)
    url = fetch(entry, :url) || derived_url(port)

    if is_binary(name) and name != "" and is_binary(url) and url != "" do
      %__MODULE__{
        name: name,
        url: url,
        ssh: string_or(fetch(entry, :ssh), name),
        display: string_or(fetch(entry, :display), name),
        port: port,
        remote_port: fetch(entry, :remote_port) || @default_remote_port,
        tunnel: tunnel_from(fetch(entry, :tunnel)),
        enabled: fetch(entry, :enabled) != false,
        poll_interval_ms: fetch(entry, :poll_interval_ms) || 5_000,
        request_timeout_ms: fetch(entry, :request_timeout_ms) || 2_000,
        stale_multiplier: fetch(entry, :stale_multiplier) || 4
      }
    end
  end

  def from_config(entry) when is_list(entry) do
    from_config(Map.new(entry))
  end

  def from_config(_), do: nil

  defp derived_url(port) when is_integer(port) and port > 0, do: "http://127.0.0.1:#{port}"
  defp derived_url(_), do: nil

  defp string_or(value, _fallback) when is_binary(value) and value != "", do: value
  defp string_or(_value, fallback), do: fallback

  defp tunnel_from(nil), do: %{manager: default_tunnel_manager(), multiplex: false, label: nil}

  defp tunnel_from(tunnel) when is_list(tunnel), do: tunnel_from(Map.new(tunnel))

  defp tunnel_from(%{} = tunnel) do
    %{
      manager: tunnel_manager(fetch(tunnel, :manager)),
      multiplex: fetch(tunnel, :multiplex) == true,
      label: string_or(fetch(tunnel, :label), nil)
    }
  end

  defp tunnel_from(_), do: %{manager: default_tunnel_manager(), multiplex: false, label: nil}

  defp tunnel_manager("launchd"), do: :launchd
  defp tunnel_manager(:launchd), do: :launchd
  defp tunnel_manager("none"), do: :none
  defp tunnel_manager(:none), do: :none
  defp tunnel_manager(_), do: default_tunnel_manager()

  # Mirrors `defaultTunnelManager()` in cmd/shuttle_remotes.go. A Mac hub manages
  # its tunnels with launchd; anywhere else there is no launchd, so a remote with
  # no explicit policy is assumed already reachable and the recovery cascade goes
  # straight to the ssh check instead of shelling a `launchctl` that cannot exist.
  # The two readers must agree: the Go installer decides which plists to write
  # from this same rule.
  #
  # Note the struct's own `:tunnel` default stays `:launchd` — a hand-built
  # `%Remote{}` (tests, literal config) is an explicit statement, not a parse.
  defp default_tunnel_manager do
    case :os.type() do
      {:unix, :darwin} -> :launchd
      _ -> :none
    end
  end

  # Accept both atom and string keys: app config is atom-keyed, the fleet file
  # decodes to string keys, and one struct serves both.
  defp fetch(map, key) when is_atom(key) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, Atom.to_string(key))
    end
  end

  @doc """
  The SSH destination for this remote — `ssh` when set, else `name`. Use this
  rather than `remote.name` for anything that shells `ssh`: a struct built
  literally (tests, hand-written config) carries no `ssh`, and the name is the
  right fallback.
  """
  @spec ssh_host(t()) :: String.t()
  def ssh_host(%__MODULE__{ssh: ssh, name: name}), do: string_or(ssh, name)

  @doc "The presentation label for this remote — `display` when set, else `name`."
  @spec display_name(t()) :: String.t()
  def display_name(%__MODULE__{display: display, name: name}), do: string_or(display, name)

  @doc """
  The full `GET /api/v1/state` URL for this remote.
  """
  @spec state_url(t()) :: String.t()
  def state_url(%__MODULE__{url: url}) do
    url
    |> String.trim_trailing("/")
    |> Kernel.<>("/api/v1/state")
  end

  @doc """
  The full `GET /api/v1/fibers?shuttle=true` URL for this remote — the
  owner-only kanban feed (this host's owned shuttle fibers, each carrying
  serve-time tmux liveness). The local daemon composes these per-origin feeds
  into the unified cross-host board (`Shuttle.RemoteFiberRegistry`).
  """
  @spec fibers_url(t()) :: String.t()
  def fibers_url(%__MODULE__{url: url}) do
    url
    |> String.trim_trailing("/")
    |> Kernel.<>("/api/v1/fibers?shuttle=true")
  end

  @doc """
  The full `GET /api/v1/activity` URL for this remote, over the inclusive
  window `from_ms..to_ms`. Host-scoped, like the two builders below it: the
  temporal feeds are each daemon's own telemetry, so the hub fans out and
  merges on the origin name rather than owner-routing.
  """
  @spec activity_url(t(), integer(), integer()) :: String.t()
  def activity_url(%__MODULE__{url: url}, from_ms, to_ms)
      when is_integer(from_ms) and is_integer(to_ms) do
    base(url) <> "/api/v1/activity?from_ms=#{from_ms}&to_ms=#{to_ms}"
  end

  @doc """
  The full `GET /api/v1/sessions` URL for this remote, from `since_ms`. The
  ledger is one line per session, so the hub asks for all of it (`since_ms: 0`).
  """
  @spec sessions_url(t(), integer()) :: String.t()
  def sessions_url(%__MODULE__{url: url}, since_ms) when is_integer(since_ms) do
    base(url) <> "/api/v1/sessions?since_ms=#{since_ms}"
  end

  @doc """
  The full `GET /api/v1/narration` URL for this remote, over the inclusive
  window `from_ms..to_ms`.
  """
  @spec narration_url(t(), integer(), integer()) :: String.t()
  def narration_url(%__MODULE__{url: url}, from_ms, to_ms)
      when is_integer(from_ms) and is_integer(to_ms) do
    base(url) <> "/api/v1/narration?from_ms=#{from_ms}&to_ms=#{to_ms}"
  end

  defp base(url), do: String.trim_trailing(url, "/")

  @doc """
  The full `GET /api/v1/felt-stores` URL for this remote.
  """
  @spec felt_stores_url(t()) :: String.t()
  def felt_stores_url(%__MODULE__{url: url}) do
    url
    |> String.trim_trailing("/")
    |> Kernel.<>("/api/v1/felt-stores")
  end

  @doc """
  Returns `true` when `last_polled_at` is older than
  `stale_multiplier × poll_interval_ms` from `now`. A `nil`
  `last_polled_at` is always stale.
  """
  @spec stale?(t(), DateTime.t() | nil, DateTime.t()) :: boolean()
  def stale?(%__MODULE__{} = _remote, nil, _now), do: true

  def stale?(
        %__MODULE__{poll_interval_ms: pi, stale_multiplier: m},
        %DateTime{} = last,
        %DateTime{} = now
      ) do
    threshold_ms = pi * m
    DateTime.diff(now, last, :millisecond) > threshold_ms
  end
end
