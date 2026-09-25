defmodule Shuttle.Remote do
  @moduledoc """
  Configuration record for a remote Shuttle daemon this host polls for
  visibility.

  A remote is identified by `name` — the routing key everywhere. It must equal
  that daemon's own host id and the `shuttle.host` its fibers carry; origin
  stamping, `Shuttle.OriginRouter.route/2`, and `--remote NAME` all key off it.

  `url` is whatever local URL the SSH tunnel maps the remote daemon's
  listener to — `127.0.0.1:<remote_port>`, or `remote_socket` when that daemon
  listens on a unix socket (`Shuttle.Host`). Either way the local end of the
  tunnel is a TCP port, so to this daemon a socket remote is an ordinary
  tunnelled one; only the far end differs. Give a `port` and the URL derives from it
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
    remote_socket: nil,
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
          ssh: String.t() | nil,
          display: String.t(),
          port: pos_integer() | nil,
          remote_port: non_neg_integer(),
          remote_socket: String.t() | nil,
          tunnel: tunnel(),
          enabled: boolean(),
          poll_interval_ms: pos_integer(),
          request_timeout_ms: pos_integer(),
          stale_multiplier: pos_integer()
        }

  @default_remote_port 4_000

  @doc """
  Parses a single entry. Returns `nil` when required fields are missing or a
  numeric setting is malformed.

  Defaults:
    * `ssh` — nil (not the name). `ssh_host/1` supplies the name as the
      destination for a `port` entry, where the SSH destination IS the routing
      name; a bare `url` entry that names no `ssh` has no ssh path at all, and
      `ssh_host/1` says so with `nil`
    * `display` — `name`. Presentation only, never an address: two ways to name
      one origin is how a mis-stamped origin silently degrades to `:local`.
    * `url` — `http://127.0.0.1:<port>`
    * `remote_port` — 4000 (the daemon port on the far side of the tunnel),
      or 0 when the entry names a `remote_socket` instead. The two are
      mutually exclusive, and an entry naming both is dropped, as is a
      `remote_socket` outside the Go reader's rule (an absolute, clean path of
      `A-Za-z0-9._/@+-`) — the Go reader refuses the same entries
    * `tunnel.manager` — `:none` for any entry with no `port` (nothing to
      forward means nothing to supervise, on every platform); otherwise
      `:launchd` on darwin, `:none` elsewhere. This answers
      the daemon's question, which is what the recovery cascade can BOUNCE, and
      the cascade only knows `launchctl kickstart`; `:none` skips the bounce and
      goes straight to the ssh check. The Go installer's `defaultTunnelManager()`
      answers a different question — which supervisor a hub INSTALLS with — and
      so says `systemd` on Linux. A Linux hub therefore installs its tunnels as
      systemd units and the daemon reaches its remotes over the ssh check when
      one of them goes quiet
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
    name = string_or(fetch(entry, :name), nil)
    port = normalize_port(fetch(entry, :port))
    url = fetch(entry, :url) || derived_url(port)

    with {:ok, port} <- port,
         {:ok, remote_socket} <- normalize_remote_socket(fetch(entry, :remote_socket)),
         {:ok, remote_port} <-
           normalize_remote_port(fetch(entry, :remote_port), remote_socket),
         {:ok, poll_interval_ms} <- positive_integer(fetch(entry, :poll_interval_ms), 5_000),
         {:ok, request_timeout_ms} <- positive_integer(fetch(entry, :request_timeout_ms), 2_000),
         {:ok, stale_multiplier} <- positive_integer(fetch(entry, :stale_multiplier), 4),
         true <- is_binary(name) and name != "" and is_binary(url) and url != "" do
      %__MODULE__{
        name: name,
        url: url,
        ssh: string_or(fetch(entry, :ssh), nil),
        display: string_or(fetch(entry, :display), name),
        port: port,
        remote_port: remote_port,
        remote_socket: remote_socket,
        tunnel: tunnel_from(fetch(entry, :tunnel), port),
        enabled: fetch(entry, :enabled) != false,
        poll_interval_ms: poll_interval_ms,
        request_timeout_ms: request_timeout_ms,
        stale_multiplier: stale_multiplier
      }
    else
      _ -> nil
    end
  end

  def from_config(entry) when is_list(entry) do
    from_config(Map.new(entry))
  end

  def from_config(_), do: nil

  defp derived_url({:ok, port}) when is_integer(port), do: "http://127.0.0.1:#{port}"
  defp derived_url(_), do: nil

  # The fleet file is operator-editable JSON, so the daemon must validate the
  # values independently of the Go CLI. Invalid optional values drop just that
  # remote instead of leaking strings/negative integers into timer, HTTP, and
  # arithmetic code downstream. `nil` and zero retain the sparse-file defaults.
  defp normalize_port(nil), do: {:ok, nil}
  defp normalize_port(0), do: {:ok, nil}
  defp normalize_port(port) when is_integer(port) and port in 1..65_535, do: {:ok, port}
  defp normalize_port(_), do: :error

  defp normalize_remote_port(port, socket) when is_binary(socket) and port in [nil, 0],
    do: {:ok, 0}

  defp normalize_remote_port(_port, socket) when is_binary(socket), do: :error
  defp normalize_remote_port(nil, nil), do: {:ok, @default_remote_port}
  defp normalize_remote_port(0, nil), do: {:ok, @default_remote_port}

  defp normalize_remote_port(port, nil) when is_integer(port) and port in 1..65_535,
    do: {:ok, port}

  defp normalize_remote_port(_, nil), do: :error

  defp normalize_remote_socket(nil), do: {:ok, nil}

  # The Go reader's rule, byte for byte: an absolute, clean path of characters
  # that survive `ssh -L`, the launchd plist and the systemd unit unquoted.
  @remote_socket ~r{\A/[A-Za-z0-9._/@+-]+\z}

  defp normalize_remote_socket(value) when is_binary(value) do
    case String.trim(value) do
      "" ->
        {:ok, nil}

      path ->
        if Regex.match?(@remote_socket, path) and clean?(path), do: {:ok, path}, else: :error
    end
  end

  defp normalize_remote_socket(_), do: :error

  # Go's `filepath.Clean(path) == path` for an absolute path: no `.` or `..`
  # segment, no `//`, no trailing `/`.
  defp clean?("/" <> rest),
    do: rest |> String.split("/") |> Enum.all?(&(&1 not in ["", ".", ".."]))

  defp positive_integer(nil, default), do: {:ok, default}
  defp positive_integer(0, default), do: {:ok, default}
  defp positive_integer(value, _default) when is_integer(value) and value > 0, do: {:ok, value}
  defp positive_integer(_value, _default), do: :error

  defp string_or(value, _fallback) when is_binary(value) and value != "", do: value
  defp string_or(_value, fallback), do: fallback

  # A remote with no local forwarded port has no tunnel for this host to
  # supervise — there is nothing to forward — so its manager is `:none`
  # whatever the entry says, and whatever platform this is. The Go reader
  # (`normalizeRemotes`) applies the same rule and additionally REFUSES a file
  # that names an actual supervisor on a portless entry, so the only way such
  # an entry reaches this parse is a file hand-written around the CLI; reading
  # it as `:none` is the same answer the CLI would have forced.
  #
  # This matters beyond tidiness: `run_recovery_step/3`'s `:no_recovery_path`
  # clause keys off `manager == :none`, so a portless entry that claimed a
  # bounceable tunnel would send the cascade to `launchctl kickstart` at a job
  # that was deliberately never installed.
  defp tunnel_from(tunnel, nil), do: %{tunnel_shape(tunnel) | manager: :none}
  defp tunnel_from(tunnel, port) when is_integer(port), do: tunnel_shape(tunnel)

  defp tunnel_shape(tunnel) when is_list(tunnel), do: tunnel_shape(Map.new(tunnel))

  defp tunnel_shape(%{} = tunnel) do
    %{
      manager: tunnel_manager(fetch(tunnel, :manager)),
      multiplex: fetch(tunnel, :multiplex) == true,
      label: string_or(fetch(tunnel, :label), nil)
    }
  end

  defp tunnel_shape(_), do: %{manager: default_tunnel_manager(), multiplex: false, label: nil}

  defp tunnel_manager("launchd"), do: :launchd
  defp tunnel_manager(:launchd), do: :launchd
  defp tunnel_manager("none"), do: :none
  defp tunnel_manager(:none), do: :none
  # Anything else — notably `"systemd"`, which a Linux hub's fleet file carries —
  # falls through to the host rule, and that lands right on both platforms: a Mac
  # reading a systemd-marked remote installed it as a plist and CAN kickstart it,
  # while a Linux host has no launchctl to shell and belongs on the ssh check.
  defp tunnel_manager(_), do: default_tunnel_manager()

  # This decides what the recovery cascade can BOUNCE, which is a launchd job or
  # nothing: `bounce_tunnel/3` shells `launchctl kickstart`. So a Mac hub's
  # remotes are `:launchd`, and everywhere else a remote with no explicit policy
  # goes straight to the ssh check instead of shelling a `launchctl` that cannot
  # exist. `defaultTunnelManager()` in cmd/shuttle_remotes.go answers the
  # neighbouring question — which supervisor the hub INSTALLS the tunnel with —
  # and so says `systemd` where this says `:none`.
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
  The SSH destination for this remote, or `nil` when the fleet gives this host
  no ssh path to that daemon at all.

  `ssh` when the entry names one. Otherwise the name — but only for an entry
  that declares a `port`, i.e. one reached through a tunnel, where the ssh
  destination and the routing name are the same thing by construction. A bare
  `url` entry (a mesh-VPN node, a reverse proxy) is reached over HTTP and
  nothing else; guessing that its routing name is also a resolvable ssh
  destination is how the recovery cascade ends up shelling `ssh <name>` every
  backoff for a host it was never given credentials to.

  `nil` is therefore load-bearing, not a missing default: it is the fleet
  saying "if HTTP doesn't reach it, report it stale". Anything that shells
  `ssh` must handle it.
  """
  @spec ssh_host(t()) :: String.t() | nil
  def ssh_host(%__MODULE__{ssh: ssh}) when is_binary(ssh) and ssh != "", do: ssh
  def ssh_host(%__MODULE__{port: port, name: name}) when is_integer(port), do: name
  def ssh_host(%__MODULE__{}), do: nil

  @doc "The presentation label for this remote — `display` when set, else `name`."
  @spec display_name(t()) :: String.t()
  def display_name(%__MODULE__{display: display, name: name}), do: string_or(display, name)

  @doc """
  This remote's base URL joined to `path` — the ONE definition of that join, so
  every `*_url/1` builder here and `Shuttle.OriginRouter`'s forwards produce a
  byte-identical URL.
  """
  @spec url_for(t(), String.t()) :: String.t()
  def url_for(%__MODULE__{url: url}, path), do: base(url) <> path

  defp base(url), do: String.trim_trailing(url, "/")

  @doc """
  The full `GET /api/v1/state` URL for this remote.
  """
  @spec state_url(t()) :: String.t()
  def state_url(%__MODULE__{url: url}), do: base(url) <> "/api/v1/state"

  @doc """
  The full `GET /api/v1/fibers?shuttle=true` URL for this remote — the
  owner-only kanban feed (this host's owned shuttle fibers, each carrying
  serve-time tmux liveness). The local daemon composes these per-origin feeds
  into the unified cross-host board (`Shuttle.RemoteFiberRegistry`).
  """
  @spec fibers_url(t()) :: String.t()
  def fibers_url(%__MODULE__{url: url}), do: base(url) <> "/api/v1/fibers?shuttle=true"

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
  The full `GET /api/v1/sessions` URL for this remote. The ledger is one line
  per session, so the hub asks for all of it (`since_ms=0`).
  """
  @spec sessions_url(t()) :: String.t()
  def sessions_url(%__MODULE__{url: url}), do: base(url) <> "/api/v1/sessions?since_ms=0"

  @doc """
  The full `GET /api/v1/spend` URL for this remote. One row per ledgered
  session, so the hub asks for the whole ledger the way it does for
  `/sessions`; the far side caps the window at 90 days on its own.
  """
  @spec spend_url(t()) :: String.t()
  def spend_url(%__MODULE__{url: url}), do: base(url) <> "/api/v1/spend?since_ms=0"

  @doc """
  The full `GET /api/v1/commits` URL for this remote. One line per commit, so
  the hub asks for the whole ledger the way it does for `/sessions` — the
  window is applied when the composite serves it.
  """
  @spec commits_url(t()) :: String.t()
  def commits_url(%__MODULE__{url: url}), do: base(url) <> "/api/v1/commits?since_ms=0"

  @doc """
  The full `GET /api/v1/sent-files/all` URL for this remote. One line per send
  across every fiber on that host, so the hub asks for the whole stream the way
  it does for `/commits` — the window is applied when the composite serves it.
  """
  @spec sent_files_all_url(t()) :: String.t()
  def sent_files_all_url(%__MODULE__{url: url}),
    do: base(url) <> "/api/v1/sent-files/all?since_ms=0"

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
