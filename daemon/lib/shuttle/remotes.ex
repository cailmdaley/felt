defmodule Shuttle.Remotes do
  @moduledoc """
  The remote-daemon fleet: which other Shuttle daemons this host aggregates and
  how to reach each one — a locally-forwarded SSH tunnel port, or an outright
  URL on a mesh VPN.

  Two sources, merged by `resolve/2`. `Shuttle.TailnetPeers` discovers every
  Shuttle daemon on this host's tailnet and names each by the host id it
  reports, so a host with no fleet file still reaches every tailnet daemon.
  The fleet file adds hosts outside the tailnet and overrides discovered ones:
  a configured entry wins wholesale over a discovered peer of the same name or
  `https` authority, and a disabled entry suppresses one.

  The file is `~/.config/shuttle/remotes.json` (or `$SHUTTLE_REMOTES_FILE`) →

      {
        "version": 1,
        "launchd_label_prefix": "io.shuttle",
        "defaults": {
          "poll_interval_ms": 5000,
          "request_timeout_ms": 20000,
          "tailscale_socket": "/home/example/.local/state/tailscale/tailscaled.sock",
          "discover": true
        },
        "remotes": [
          {"name": "hub-a", "ssh": "hub-a", "port": 4001},
          {"name": "hub-b", "port": 4004, "tunnel": {"multiplex": true}},
          {"name": "hub-c", "url": "https://hub-c.example.ts.net",
           "tunnel": {"manager": "none"}}
        ]
      }

  The two transports are not variants of one thing. A `port` entry is reached
  through a tunnel this host supervises, so it has an ssh path and the recovery
  cascade can bounce and revive it. A bare `url` entry with
  `tunnel.manager: "none"` is reached directly; unless it names an `ssh`, this
  host has no way to touch that daemon at all and an unreachable one is simply
  reported stale. `tailscale_socket/0` selects the private LocalAPI dial
  transport for `https://` URLs, defaulting to `bin/tailscaled-launch`'s socket
  when one exists (`tailscale_socket_source/0`); `https_proxy/0` is the
  single-user-only alternative.

  `defaults.discover: false` turns tailnet discovery off for this host.

  A bare JSON array of entries is also accepted. Absent, unreadable, or
  malformed file → no configured entries: a hub with no fleet file serves its
  tailnet peers or, off the tailnet, is a correct local-only daemon, and a
  daemon that refuses to boot over a typo in an operator file is
  worse than one that serves its own board. `shuttle remotes list` is the
  validator that reports the typo.

  Deliberately a **sibling** of `Shuttle.FeltStores` (`stores.json`) and
  `Shuttle.Projects` (`projects.json`), not an extension of either — one file
  per question. `stores.json` is mutated at runtime by the kanban; the fleet is
  operator setup a UI round-trip must never clobber. And the two answer
  different questions: stores are "what do I poll", remotes are "who else
  exists".

  The Go CLI (`internal/shuttlecli/remotes.go`) reads the same file with the same
  defaults rather than shelling the daemon — the same one-way dependency
  `SHUTTLE_STORES` keeps. `test/fixtures/remotes/*.json` is read by both suites so
  the two readers cannot drift.

  ## Resolution

    1. `Application.get_env(:shuttle, :remotes)` when **not nil** — `[]` means
       "explicitly none", and discovery does not apply. This is what keeps the
       controller tests (which `put_env` their own list) and `config/test.exs`
       authoritative.
    2. the file's entries merged with the discovered peers

  There is deliberately no compact `SHUTTLE_REMOTES` env form: a remote carries
  structured fields (tunnel options, per-remote timeouts) no comma-separated
  grammar can express, so a second grammar in two languages would always be a
  lossy subset.
  """

  alias Shuttle.Remote

  @config_env "SHUTTLE_REMOTES_FILE"
  @default_config_path "~/.config/shuttle/remotes.json"

  # Reverse-DNS prefix for the tunnel launchd labels. Matches the daemon's own
  # `io.shuttle.daemon` agent. The Go tunnel installer reads the same key, so
  # the label a plist is installed under and the label this daemon's recovery
  # cascade kickstarts are one value with two readers.
  @default_launchd_label_prefix "io.shuttle"

  # `defaults.tailscale_socket: "system"` names the system tailscaled. The
  # default socket is `bin/tailscaled-launch`'s, relative to $HOME.
  @system_socket "system"
  @default_socket_path ".local/state/tailscale/tailscaled.sock"

  @doc """
  The fleet this daemon should use, as `[%Shuttle.Remote{}]`: the file's
  enabled entries merged with the tailnet peers `Shuttle.TailnetPeers` last
  discovered (see `resolve/2`). Application config, when set, is the whole
  fleet and discovery does not apply.
  """
  @spec configured() :: [Remote.t()]
  def configured do
    case Shuttle.Env.app(:remotes) do
      nil -> resolve(document(), Shuttle.TailnetPeers.peers(), tailscale_socket_configured?())
      entries when is_list(entries) -> normalize(entries, tailscale_socket_configured?())
      _ -> []
    end
  end

  @doc "The fleet as persisted in the file, ignoring application config and discovery."
  @spec registered() :: [Remote.t()]
  def registered do
    document() |> entries() |> normalize(tailscale_socket_configured?())
  end

  @doc """
  Merge a fleet document with discovered tailnet peers.

  `doc` is the decoded fleet file (`nil` when there is none); `discovered` is
  a list of `%{"name" => host_id, "url" => "https://<magicdns-name>"}` peers.
  The result is the document's enabled entries in file order, then the
  discovered peers sorted by name, each carrying its `source`.

  A configured entry wins wholesale: a discovered peer is dropped when any
  entry in the document, enabled or not, has its name or already reaches the
  same `https` authority. So `{"name": "hub-a", "url": "...", "enabled": false}`
  suppresses a discovered `hub-a`. `"defaults": {"discover": false}` drops
  every discovered peer. Discovered peers take the document's polling
  defaults and have no tunnel and no ssh path.

  Pure, and mirrored by `resolveRemotes` in `internal/shuttlecli/remotes.go`;
  `test/fixtures/tailnet_peers/*.json` drives both.
  """
  @spec resolve(map() | list() | nil, [map()]) :: [Remote.t()]
  def resolve(doc, discovered),
    do: resolve(doc, discovered, doc_tailscale_socket_configured?(doc))

  defp resolve(doc, discovered, socket_configured?) do
    configured = doc |> entries() |> normalize(socket_configured?)
    if discover?(doc), do: configured ++ admit(doc, discovered), else: configured
  end

  @doc """
  Whether the document lets this host discover tailnet peers: true unless
  `defaults.discover` is `false`.
  """
  @spec discover?(map() | list() | nil) :: boolean()
  def discover?(doc), do: Map.get(defaults_block(doc), "discover") != false

  # A discovered peer becomes a portless URL remote with the document's
  # polling defaults. Every document entry claims its name and its https
  # authority, disabled ones included, since disabling is how an operator
  # suppresses a discovered host.
  defp admit(doc, discovered) do
    claimed = doc |> entries() |> Shuttle.RegistryCommon.normalize_remotes()
    names = MapSet.new(claimed, & &1.name)
    authorities = claimed |> Enum.map(&https_authority(&1.url)) |> MapSet.new()
    defaults = defaults_block(doc)

    discovered
    |> Enum.flat_map(fn peer ->
      %{"name" => peer_field(peer, :name), "url" => peer_field(peer, :url)}
      |> Map.put("tunnel", %{"manager" => "none"})
      |> apply_defaults(defaults)
      |> Remote.from_config()
      |> List.wrap()
    end)
    |> Enum.filter(fn %Remote{name: name, url: url} ->
      authority = https_authority(url)

      not MapSet.member?(names, name) and authority != nil and
        not MapSet.member?(authorities, authority)
    end)
    |> Enum.uniq_by(& &1.name)
    |> Enum.sort_by(& &1.name)
    |> Enum.map(&%{&1 | source: :discovered})
  end

  defp peer_field(peer, key) when is_map(peer),
    do: Map.get(peer, Atom.to_string(key)) || Map.get(peer, key)

  defp peer_field(_peer, _key), do: nil

  @doc """
  The launchd label prefix for tunnel jobs: `:launchd_label_prefix` app config,
  else the file's `launchd_label_prefix`, else `"io.shuttle"`.
  """
  @spec launchd_label_prefix() :: String.t()
  def launchd_label_prefix do
    with nil <- Shuttle.Env.app(:launchd_label_prefix),
         {:ok, %{"launchd_label_prefix" => prefix}} when is_binary(prefix) and prefix != "" <-
           read_document() do
      prefix
    else
      prefix when is_binary(prefix) and prefix != "" -> prefix
      _ -> @default_launchd_label_prefix
    end
  end

  @doc """
  The launchd job label for a remote's tunnel — `tunnel.label` when the entry
  pins one, else `<prefix>.shuttle-tunnel-<name>`. Mirrors `remoteSpec.label`
  in the Go installer.
  """
  @spec label_for(Remote.t() | String.t()) :: String.t()
  def label_for(%Remote{tunnel: %{label: label}}) when is_binary(label) and label != "",
    do: label

  def label_for(%Remote{name: name}), do: label_for(name)

  def label_for(name) when is_binary(name),
    do: "#{launchd_label_prefix()}.shuttle-tunnel-#{name}"

  @doc """
  The hub's outbound HTTP proxy for `https://` remotes, as `{host, port}`, or
  `nil` for a direct connection.

  Source: the document-level `defaults.https_proxy` (`"http://localhost:1055"`,
  or a bare `"localhost:1055"`). **`$HTTPS_PROXY` is deliberately not read.** A
  supervised daemon's environment is invisible to the operator who has to debug
  it, while the fleet file is one place `shuttle remotes list` already
  validates — so the proxy lives where the fleet does, and there is exactly one
  answer to "why can't this hub reach that node".

  Why a hub needs one at all: a node joined to a mesh VPN with
  userspace networking has no kernel route to the mesh; its VPN daemon exposes a
  local HTTP proxy instead, and that proxy is the only way out. A hub with a
  real routed interface leaves the key unset.

  `Application.get_env(:shuttle, :https_proxy)` wins when set (tests);
  `false` means "explicitly none".
  """
  @spec https_proxy() :: {String.t(), pos_integer()} | nil
  def https_proxy do
    case Shuttle.Env.app(:https_proxy) do
      nil -> file_https_proxy()
      false -> nil
      value -> parse_proxy(value)
    end
  end

  @doc """
  Where this host's tailscaled LocalAPI socket comes from, as `{source, value}`:

    * `{:configured, value}` — `defaults.tailscale_socket` (or the
      `:tailscale_socket` application config) names a socket. An invalid value
      stays `:configured`, so `https://` requests fail closed rather than
      dialing directly.
    * `{:system, nil}` — the value is `"system"`: use the system tailscaled
      (its CLI and kernel route) and never a private socket.
    * `{:default, path}` — nothing is configured, no `https_proxy` is set, and
      `bin/tailscaled-launch`'s socket,
      `$HOME/.local/state/tailscale/tailscaled.sock`, exists as a Unix socket.
    * `{:none, nil}` — otherwise.

  `$TS_SOCKET` is deliberately not read: the fleet file is the operator-visible
  source of truth shared by the daemon and `shuttle remotes list`, which
  applies the same default (`effectiveTailscaleSocket` in
  `internal/shuttlecli/remotes.go`).
  """
  @spec tailscale_socket_source() ::
          {:configured, term()} | {:system, nil} | {:default, String.t()} | {:none, nil}
  def tailscale_socket_source do
    case Shuttle.Env.app(:tailscale_socket) do
      nil -> doc_socket_source(document())
      false -> {:none, nil}
      value -> explicit_socket_source(value)
    end
  end

  @doc """
  Whether the host dials `https://` remotes through a private LocalAPI socket,
  configured or default, including when the configured value is invalid.
  """
  @spec tailscale_socket_configured?() :: boolean()
  def tailscale_socket_configured? do
    match?({source, _} when source in [:configured, :default], tailscale_socket_source())
  end

  @doc """
  The hub's normalized tailscaled LocalAPI socket (see
  `tailscale_socket_source/0`), or `nil` when there is no valid private dial
  transport.
  """
  @spec tailscale_socket() :: String.t() | nil
  def tailscale_socket do
    case Shuttle.Env.app(:tailscale_socket) do
      false ->
        nil

      nil ->
        case doc_socket_source(document()) do
          {:configured, _} -> file_tailscale_socket()
          {:default, path} -> path
          _ -> nil
        end

      value ->
        case explicit_socket_source(value) do
          {:configured, configured} -> normalized_tailscale_socket(configured)
          _ -> nil
        end
    end
  end

  @doc """
  `bin/tailscaled-launch`'s LocalAPI socket when it is trustworthy, else `nil`.
  See `default_tailscale_socket_check/0`.
  """
  @spec default_tailscale_socket() :: String.t() | nil
  def default_tailscale_socket do
    case default_tailscale_socket_check() do
      {:ok, path} -> path
      _ -> nil
    end
  end

  @doc """
  The default LocalAPI socket, `$HOME/.local/state/tailscale/tailscaled.sock`:

    * `{:ok, path}` — on Linux, a Unix socket owned by this daemon's uid,
      reached from `$HOME` through real directories only, none writable by
      group or others (`Shuttle.Host.private_socket_problem/3`), so no
      co-tenant could have planted it. macOS is excluded because its ACLs do
      not show in mode bits, and a Mac uses the system tailscaled;
    * `{:refused, path, reason}` — something is there but fails that check;
      it is not used, and `/api/v1/version` reports the reason;
    * `:absent` — nothing is there.

  `:tailscale_home` application config replaces `$HOME` (`false` means none),
  which keeps the test suite off the developer's real socket.
  """
  @spec default_tailscale_socket_check() ::
          {:ok, String.t()} | {:refused, String.t(), String.t()} | :absent
  def default_tailscale_socket_check do
    home =
      case Shuttle.Env.app(:tailscale_home) do
        nil -> Shuttle.Env.get("HOME")
        false -> nil
        home -> home
      end

    with "/" <> _ <- home,
         path = Path.join(home, @default_socket_path),
         {:ok, ^path} <- Remote.normalize_socket_path(path),
         {:ok, _stat} <- File.lstat(path) do
      cond do
        (Shuttle.Env.app(:os_type) || :os.type()) != {:unix, :linux} ->
          {:refused, path, "default socket is Linux-only"}

        why = Shuttle.Host.private_socket_problem(path, home, Shuttle.Host.euid()) ->
          {:refused, path, why}

        true ->
          {:ok, path}
      end
    else
      _ -> :absent
    end
  end

  defp doc_socket_source(doc) do
    defaults = defaults_block(doc)

    case explicit_socket_source(Map.get(defaults, "tailscale_socket")) do
      {:none, nil} ->
        if proxy_set?(defaults) or Shuttle.Env.app(:https_proxy) not in [nil, false],
          do: {:none, nil},
          else: default_socket_source()

      chosen ->
        chosen
    end
  end

  defp explicit_socket_source(nil), do: {:none, nil}

  defp explicit_socket_source(value) when is_binary(value) do
    case String.trim(value) do
      "" -> {:none, nil}
      @system_socket -> {:system, nil}
      _ -> {:configured, value}
    end
  end

  defp explicit_socket_source(value), do: {:configured, value}

  @doc false
  # Why a default socket that exists was refused, for `/api/v1/version`.
  def default_tailscale_socket_refusal do
    case default_tailscale_socket_check() do
      {:refused, path, why} -> "#{path}: #{why}"
      _ -> nil
    end
  end

  @doc false
  # `tailscale_socket_source/0`'s source as the string `/api/v1/version` reports.
  def tailscale_socket_source_name, do: tailscale_socket_source() |> elem(0) |> Atom.to_string()

  defp default_socket_source do
    case default_tailscale_socket() do
      nil -> {:none, nil}
      path -> {:default, path}
    end
  end

  defp proxy_set?(defaults) do
    case Map.get(defaults, "https_proxy") do
      nil -> false
      value when is_binary(value) -> String.trim(value) != ""
      _ -> true
    end
  end

  @doc """
  A cheap change token for the resolved fleet: the file's `{mtime, size}` (or
  `nil` when absent), `Shuttle.TailnetPeers.generation/0`, and the default
  LocalAPI socket when one exists. The registries and the dial reconciler
  compare it each tick, so `shuttle remotes add`, a newly discovered peer, and
  a userspace tailscaled starting after the daemon all take effect without a
  daemon bounce. Size is folded in because POSIX mtime has 1-second
  granularity and an edit-and-save inside the same second is ordinary.
  """
  @spec config_token() ::
          {{integer(), non_neg_integer()} | nil, non_neg_integer(), String.t() | nil}
  def config_token do
    file =
      case File.stat(config_path(), time: :posix) do
        {:ok, %File.Stat{mtime: mtime, size: size}} -> {mtime, size}
        _ -> nil
      end

    {file, Shuttle.TailnetPeers.generation(), default_tailscale_socket()}
  end

  @doc "Path the fleet is read from. Only the Go CLI writes it."
  @spec config_path() :: String.t()
  def config_path do
    case Shuttle.Env.get(@config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(@default_config_path)
    end
  end

  # ── Internals ──

  @doc false
  # The decoded fleet file, or `nil` when it is absent, unreadable or
  # malformed. The document shape is checked by `entries/1`.
  def document do
    case read_document() do
      {:ok, doc} -> doc
      :error -> nil
    end
  end

  defp read_document do
    path = config_path()

    with true <- File.exists?(path),
         {:ok, content} <- File.read(path),
         {:ok, decoded} <- Jason.decode(content) do
      {:ok, decoded}
    else
      _ -> :error
    end
  end

  defp file_https_proxy do
    case read_document() do
      {:ok, doc} -> doc |> defaults_block() |> Map.get("https_proxy") |> parse_proxy()
      :error -> nil
    end
  end

  defp doc_tailscale_socket_configured?(doc) do
    match?(
      {:configured, _},
      doc |> defaults_block() |> Map.get("tailscale_socket") |> explicit_socket_source()
    )
  end

  defp file_tailscale_socket do
    case read_document() do
      {:ok, doc} ->
        defaults = defaults_block(doc)

        if valid_defaults?(defaults),
          do: normalized_tailscale_socket(Map.get(defaults, "tailscale_socket"))

      :error ->
        nil
    end
  end

  defp normalized_tailscale_socket(value) do
    case Remote.normalize_socket_path(value) do
      {:ok, path} -> path
      :error -> nil
    end
  end

  defp valid_defaults?(defaults) do
    proxy = Map.get(defaults, "https_proxy")

    socket =
      case explicit_socket_source(Map.get(defaults, "tailscale_socket")) do
        {:configured, value} -> value
        _ -> nil
      end

    proxy_absent? = is_nil(proxy) or (is_binary(proxy) and String.trim(proxy) == "")
    proxy_valid? = proxy_absent? or not is_nil(parse_proxy(proxy))

    with true <- proxy_valid?,
         {:ok, normalized_socket} <- Remote.normalize_socket_path(socket) do
      not (not is_nil(parse_proxy(proxy)) and not is_nil(normalized_socket))
    else
      _ -> false
    end
  end

  defp defaults_block(%{"defaults" => %{} = defaults}), do: defaults
  defp defaults_block(_), do: %{}

  # The proxy grammar, shared with the Go reader (`parseProxyEndpoint` in
  # `internal/shuttlecli/remotes.go`): `[scheme://][userinfo@]host:port`.
  #
  #   * scheme, when present, must be http or https. `socks5://` is rejected
  #     rather than quietly treated as an HTTP CONNECT proxy — silently making
  #     the wrong kind of connection is the same failure as making none.
  #   * a path, query, or fragment is rejected. A proxy address has none, and
  #     ignoring the tail would mean the CLI validates a string the daemon
  #     reads differently.
  #   * userinfo is accepted and dropped (`:httpc` takes credentials
  #     separately, if ever).
  #   * the port must be written out, all digits, and in 1..65535. A scheme's
  #     default port is a guess about a local proxy nobody runs on 80.
  #     `01055` normalizes to 1055, so the two readers cannot disagree about a
  #     zero-padded port either.
  #   * an IPv6 host keeps no brackets: that is what `:httpc` wants.
  #
  # Anything unusable is nil rather than a raise: a daemon that refuses to boot
  # over a typo in an operator file is worse than one that serves its own
  # board, and `shuttle remotes list` is the validator that fails loud
  # with the reason.
  #
  # `daemon/test/shuttle/remotes_test.exs` and `internal/shuttlecli/remotes_test.go`
  # carry mirrored tables of every accepted and rejected form, so a rule that
  # changes in one language fails in both.
  defp parse_proxy(nil), do: nil
  defp parse_proxy({host, port}) when is_binary(host) and is_integer(port), do: {host, port}

  defp parse_proxy(value) when is_binary(value) do
    with trimmed when trimmed != "" <- String.trim(value),
         {:ok, rest} <- strip_scheme(trimmed),
         false <- String.contains?(rest, ["/", "?", "#"]),
         {:ok, host, port_text} <- split_host_port(strip_userinfo(rest)),
         {:ok, port} <- parse_port(port_text) do
      {host, port}
    else
      _ -> nil
    end
  end

  defp parse_proxy(_), do: nil

  defp strip_scheme(value) do
    case String.split(value, "://", parts: 2) do
      [rest] ->
        {:ok, rest}

      [scheme, rest] ->
        if String.downcase(scheme) in ["http", "https"], do: {:ok, rest}, else: :error
    end
  end

  # Everything up to and including the LAST `@`, so a password containing `@`
  # does not shift the host.
  defp strip_userinfo(value) do
    value |> String.split("@") |> List.last()
  end

  # Bracketed IPv6 first; otherwise exactly one colon, which is what rejects a
  # bare `::1:1055` the same way Go's `net.SplitHostPort` does.
  defp split_host_port("[" <> rest) do
    case String.split(rest, "]:", parts: 2) do
      [host, port] when host != "" -> {:ok, host, port}
      _ -> :error
    end
  end

  defp split_host_port(authority) do
    case String.split(authority, ":") do
      [host, port] when host != "" -> {:ok, host, port}
      _ -> :error
    end
  end

  defp parse_port(text) do
    if Regex.match?(~r/\A[0-9]+\z/, text) do
      case String.to_integer(text) do
        port when port in 1..65_535 -> {:ok, port}
        _ -> :error
      end
    else
      :error
    end
  end

  # Both shapes the Go reader accepts: the wrapped document and a bare array.
  # Fleet-level `defaults` are folded into each entry here so the per-entry
  # value always wins and `Shuttle.Remote.from_config/1` sees one flat map.
  defp entries(%{"remotes" => remotes} = doc) when is_list(remotes) do
    defaults = defaults_block(doc)
    if valid_defaults?(defaults), do: Enum.map(remotes, &apply_defaults(&1, defaults)), else: []
  end

  defp entries(remotes) when is_list(remotes), do: Enum.map(remotes, &apply_defaults(&1, %{}))
  defp entries(_), do: []

  @default_keys ~w(poll_interval_ms request_timeout_ms stale_multiplier)

  defp apply_defaults(%{} = entry, %{} = defaults) do
    Enum.reduce(@default_keys, entry, fn key, acc ->
      case {Map.get(acc, key), Map.get(defaults, key)} do
        {nil, value} when not is_nil(value) -> Map.put(acc, key, value)
        _ -> acc
      end
    end)
  end

  defp apply_defaults(entry, _defaults), do: entry

  defp normalize(entries, socket_configured?) do
    remotes =
      entries
      |> Shuttle.RegistryCommon.normalize_remotes()
      |> Enum.filter(& &1.enabled)

    if socket_configured?,
      do: reject_duplicate_https_authorities(remotes),
      else: remotes
  end

  defp reject_duplicate_https_authorities(remotes) do
    {_seen, accepted} =
      Enum.reduce(remotes, {MapSet.new(), []}, fn remote, {seen, accepted} ->
        case https_authority(remote.url) do
          nil ->
            {seen, [remote | accepted]}

          authority ->
            if MapSet.member?(seen, authority) do
              {seen, accepted}
            else
              {MapSet.put(seen, authority), [remote | accepted]}
            end
        end
      end)

    Enum.reverse(accepted)
  end

  defp https_authority(url) do
    case URI.parse(url) do
      %URI{scheme: scheme, host: host} = uri
      when is_binary(scheme) and is_binary(host) and host != "" ->
        if String.downcase(scheme) == "https" do
          {canonical_host(host), uri.port || 443}
        end

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp canonical_host(host) do
    case :inet.parse_address(String.to_charlist(host)) do
      {:ok, address} -> address |> :inet.ntoa() |> to_string() |> String.downcase()
      _ -> String.downcase(host)
    end
  end
end
