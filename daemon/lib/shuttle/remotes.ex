defmodule Shuttle.Remotes do
  @moduledoc """
  The remote-daemon fleet: which other Shuttle daemons this host aggregates and
  how to reach each one — a locally-forwarded SSH tunnel port, or an outright
  URL on a mesh VPN.

  Source: `~/.config/felt/remotes.json` (or `$FELT_REMOTES_FILE`) →

      {
        "version": 1,
        "launchd_label_prefix": "io.shuttle",
        "defaults": {
          "poll_interval_ms": 5000,
          "request_timeout_ms": 20000,
          "https_proxy": "http://localhost:1055"
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
  reported stale. See `https_proxy/0` for the hub-side proxy such a URL may need.

  A bare JSON array of entries is also accepted. Absent, unreadable, or
  malformed file → `[]`: a hub with no fleet file is a correct local-only
  daemon, and a daemon that refuses to boot over a typo in an operator file is
  worse than one that serves its own board. `felt shuttle remotes list` is the
  validator that reports the typo.

  Deliberately a **sibling** of `Shuttle.FeltStores` (`stores.json`) and
  `Shuttle.Projects` (`projects.json`), not an extension of either — one file
  per question. `stores.json` is mutated at runtime by the kanban; the fleet is
  operator setup a UI round-trip must never clobber. And the two answer
  different questions: stores are "what do I poll", remotes are "who else
  exists".

  The Go CLI (`cmd/shuttle_remotes.go`) reads the same file with the same
  defaults rather than shelling the daemon — the same one-way dependency
  `FELT_STORES` keeps. `test/fixtures/remotes/*.json` is read by both suites so
  the two readers cannot drift.

  ## Resolution

    1. `Application.get_env(:shuttle, :remotes)` when **not nil** — `[]` means
       "explicitly none". This is what keeps the controller tests (which
       `put_env` their own list) and `config/test.exs` authoritative.
    2. the file
    3. `[]`

  There is deliberately no compact `FELT_REMOTES` env form: a remote carries
  structured fields (tunnel options, per-remote timeouts) no comma-separated
  grammar can express, so a second grammar in two languages would always be a
  lossy subset.
  """

  alias Shuttle.Remote

  @config_env "FELT_REMOTES_FILE"
  @default_config_path "~/.config/felt/remotes.json"

  # Reverse-DNS prefix for the tunnel launchd labels. Matches the daemon's own
  # `io.shuttle.daemon` agent. The Go tunnel installer reads the same key, so
  # the label a plist is installed under and the label this daemon's recovery
  # cascade kickstarts are one value with two readers.
  @default_launchd_label_prefix "io.shuttle"

  @doc """
  The fleet this daemon should use, as `[%Shuttle.Remote{}]`. Disabled entries
  are dropped.
  """
  @spec configured() :: [Remote.t()]
  def configured do
    case Application.get_env(:shuttle, :remotes) do
      nil -> registered()
      entries when is_list(entries) -> normalize(entries)
      _ -> []
    end
  end

  @doc "The fleet as persisted in the file, ignoring application config."
  @spec registered() :: [Remote.t()]
  def registered do
    case read_document() do
      {:ok, doc} -> doc |> entries() |> normalize()
      :error -> []
    end
  end

  @doc """
  The launchd label prefix for tunnel jobs: `:launchd_label_prefix` app config,
  else the file's `launchd_label_prefix`, else `"io.shuttle"`.
  """
  @spec launchd_label_prefix() :: String.t()
  def launchd_label_prefix do
    with nil <- Application.get_env(:shuttle, :launchd_label_prefix),
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
  it, while the fleet file is one place `felt shuttle remotes list` already
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
    case Application.get_env(:shuttle, :https_proxy) do
      nil -> file_https_proxy()
      false -> nil
      value -> parse_proxy(value)
    end
  end

  @doc """
  A cheap change token for the fleet file — `{mtime, size}`, or `nil` when the
  file is absent. The registries stat this each tick so `felt shuttle remotes
  add` takes effect without a daemon bounce. Size is folded in because POSIX
  mtime has 1-second granularity and an edit-and-save inside the same second is
  ordinary.
  """
  @spec config_token() :: {integer(), non_neg_integer()} | nil
  def config_token do
    case File.stat(config_path(), time: :posix) do
      {:ok, %File.Stat{mtime: mtime, size: size}} -> {mtime, size}
      _ -> nil
    end
  end

  @doc "Path the fleet is read from. Only the Go CLI writes it."
  @spec config_path() :: String.t()
  def config_path do
    case System.get_env(@config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(@default_config_path)
    end
  end

  # ── Internals ──

  # `{:ok, decoded}` for any JSON the file holds, `:error` for absent /
  # unreadable / malformed. The document shape is checked by `entries/1`.
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

  defp defaults_block(%{"defaults" => %{} = defaults}), do: defaults
  defp defaults_block(_), do: %{}

  # The proxy grammar, shared with the Go reader (`parseProxyEndpoint` in
  # `cmd/shuttle_remotes.go`): `[scheme://][userinfo@]host:port`.
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
  # board, and `felt shuttle remotes list` is the validator that fails loud
  # with the reason.
  #
  # `daemon/test/shuttle/remotes_test.exs` and `cmd/shuttle_remotes_test.go`
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
    defaults = Map.get(doc, "defaults") || %{}
    Enum.map(remotes, &apply_defaults(&1, defaults))
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

  defp normalize(entries) do
    entries
    |> Shuttle.RegistryCommon.normalize_remotes()
    |> Enum.filter(& &1.enabled)
  end
end
