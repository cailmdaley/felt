defmodule Shuttle.Remotes do
  @moduledoc """
  The remote-daemon fleet: which other Shuttle daemons this host aggregates,
  what local port each one's SSH tunnel lands on, and how to reach them.

  Source: `~/.config/felt/remotes.json` (or `$FELT_REMOTES_FILE`) →

      {
        "version": 1,
        "launchd_label_prefix": "io.shuttle",
        "defaults": {"poll_interval_ms": 5000, "request_timeout_ms": 20000},
        "remotes": [
          {"name": "hub-a", "ssh": "hub-a", "port": 4001},
          {"name": "hub-b", "port": 4004, "tunnel": {"multiplex": true}}
        ]
      }

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

  @doc "Path the fleet is read from and written to."
  @spec config_path() :: String.t()
  def config_path do
    case System.get_env(@config_env) do
      v when is_binary(v) and v != "" -> Path.expand(v)
      _ -> Path.expand(@default_config_path)
    end
  end

  @doc """
  Persist the fleet atomically. Entries are written as given (no defaults
  materialized); an empty list deletes the file.
  """
  @spec save([map()]) :: {:ok, [map()]} | {:error, term()}
  def save(entries) when is_list(entries) do
    path = config_path()

    try do
      case entries do
        [] ->
          case File.rm(path) do
            :ok -> {:ok, []}
            {:error, :enoent} -> {:ok, []}
            {:error, reason} -> {:error, {:file_error, reason}}
          end

        _ ->
          File.mkdir_p!(Path.dirname(path))
          tmp = path <> ".tmp"
          payload = Jason.encode!(%{version: 1, remotes: entries}, pretty: true) <> "\n"
          File.write!(tmp, payload)
          File.rename!(tmp, path)
          {:ok, entries}
      end
    rescue
      error -> {:error, error}
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
