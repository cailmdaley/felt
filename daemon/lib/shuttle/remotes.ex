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

  # `"http://host:port"`, a bare `"host:port"`, or `{host, port}` already
  # parsed. Anything else is nil: an unusable proxy string must not become a
  # silent direct connection to a host the hub cannot route to, but it must not
  # stop the daemon booting either — `remotes list` is the validator.
  #
  # The port must be written out. A scheme's default port is a guess about a
  # local proxy nobody runs on 80, and guessing here diverges from the Go
  # reader, which has no default to fall back on.
  defp parse_proxy(nil), do: nil
  defp parse_proxy({host, port}) when is_binary(host) and is_integer(port), do: {host, port}

  defp parse_proxy(value) when is_binary(value) do
    value = String.trim(value)
    authority = value |> String.split("://") |> List.last() |> String.trim_trailing("/")

    case URI.parse(if(String.contains?(value, "://"), do: value, else: "http://" <> value)) do
      %URI{host: host, port: port}
      when is_binary(host) and host != "" and is_integer(port) ->
        # Brackets stay off the host: that is what `:httpc` wants for an IPv6
        # proxy, and what the Go reader's normalized form renders.
        if String.ends_with?(authority, ":#{port}"), do: {host, port}, else: nil

      _ ->
        nil
    end
  end

  defp parse_proxy(_), do: nil

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
