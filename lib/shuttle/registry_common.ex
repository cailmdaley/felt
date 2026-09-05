defmodule Shuttle.RegistryCommon do
  @moduledoc """
  Plumbing shared by the remote registries (`Shuttle.RemoteRegistry`,
  `Shuttle.RemoteFiberRegistry`, `Shuttle.RemoteTemporalRegistry`). Each polls
  the same `:remotes` config on a self-rescheduling tick and exposes a read call
  guarded by liveness, so the config normalization, tick scheduling, liveness
  check, and read timeout live here once rather than verbatim in each.
  `configured_remotes/1` is additionally the fleet chokepoint for
  `Shuttle.OriginRouter` and the felt-stores controller.
  """

  alias Shuttle.Remote

  require Logger

  # Read timeout for the synchronous snapshot/feed calls. Generous because a
  # cold first walk on the owning daemon can take seconds.
  @registry_read_timeout_ms 30_000

  @doc "Default timeout (ms) for the registries' synchronous read calls."
  @spec read_timeout_ms() :: pos_integer()
  def read_timeout_ms, do: @registry_read_timeout_ms

  @doc """
  Coerce the configured `:remotes` entries into `%Shuttle.Remote{}` structs,
  accepting structs, maps, or keyword lists.
  """
  @spec normalize_remotes(list()) :: [Remote.t()]
  def normalize_remotes(entries) do
    Enum.flat_map(entries, &List.wrap(Remote.from_config(&1)))
  end

  @doc """
  The one place the fleet is resolved for a consumer.

  An explicit `:remotes` opt wins (tests, callers with their own list);
  otherwise `Shuttle.Remotes.configured/0` applies the full precedence
  (application config when set, else the fleet file, else none).

  One source, so no two consumers can disagree about where the fleet comes from
  even while agreeing on how to parse it.
  """
  @spec configured_remotes(keyword()) :: [Remote.t()]
  def configured_remotes(opts \\ []) do
    case Keyword.fetch(opts, :remotes) do
      {:ok, entries} -> normalize_remotes(entries)
      :error -> Shuttle.Remotes.configured()
    end
  end

  @doc """
  Re-key a registry's per-remote entry map onto a new fleet.

  Existing entries are kept — with their `:remote` refreshed, so a changed port
  or timeout takes effect — because they carry state the registry must not lose
  on a config reload: the recovery cascade's position, failure counts, the ETag
  cache. Added remotes get `init_fun.(remote)`. Removed remotes are dropped.
  """
  @spec reconcile(map(), [Remote.t()], (Remote.t() -> map())) :: map()
  def reconcile(entries, remotes, init_fun) when is_map(entries) and is_function(init_fun, 1) do
    Map.new(remotes, fn %Remote{name: name} = remote ->
      case Map.get(entries, name) do
        nil -> {name, init_fun.(remote)}
        existing -> {name, Map.put(existing, :remote, remote)}
      end
    end)
  end

  @doc "True iff `server` resolves to a live process."
  @spec registry_alive?(GenServer.server()) :: boolean()
  def registry_alive?(server) do
    case GenServer.whereis(server) do
      nil -> false
      pid when is_pid(pid) -> Process.alive?(pid)
      _ -> false
    end
  end

  @doc """
  (Re)arm the self-rescheduling tick. Cancels any pending timer, then sends a
  fresh `{:tick, token}` after `delay_ms` and stores its ref in `state`'s
  `:tick_timer_ref` field. Works for any state struct carrying that field.
  """
  @spec schedule_tick(struct(), non_neg_integer()) :: struct()
  def schedule_tick(state, delay_ms) do
    if is_reference(state.tick_timer_ref) do
      Process.cancel_timer(state.tick_timer_ref)
    end

    token = make_ref()
    timer_ref = Process.send_after(self(), {:tick, token}, delay_ms)
    %{state | tick_timer_ref: timer_ref}
  end

  # ── Conditional feed fetch ──

  @doc """
  `GET url` with `If-None-Match: etag` when the client implements the optional
  `get/3`, normalized to `{:ok, status, headers, body}`.
  """
  @spec conditional_get(module(), String.t(), String.t() | nil, non_neg_integer()) ::
          {:ok, non_neg_integer(), list(), binary()} | {:error, term()}
  def conditional_get(client, url, etag, timeout_ms) do
    if function_exported?(client, :get, 3) do
      headers = if is_binary(etag), do: [{"if-none-match", etag}], else: []
      client.get(url, headers, timeout_ms)
    else
      # get/2 has no status/headers: normalize its {:ok, body} to a 200 tuple.
      case client.get(url, timeout_ms) do
        {:ok, body} -> {:ok, 200, [], body}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @doc "First value for `key` in a response header list, or `nil`."
  @spec header_value(list(), String.t()) :: String.t() | nil
  def header_value(headers, key) do
    Enum.find_value(headers, fn {k, v} -> if k == key, do: v end)
  end

  # ── Per-remote entry attempt/failure stamping ──
  #
  # Pure transforms over a `%{name => entry}` map whose entries carry
  # `:last_attempt_at` / `:last_error`. Shared because the fiber and temporal
  # registries record an attempt and a failure identically; each keeps its own
  # success path, which is where their shapes actually differ.

  @doc "Stamp `remote`'s entry with the current attempt time."
  @spec stamp_attempt(map(), Remote.t(), (Remote.t() -> map())) :: map()
  def stamp_attempt(entries, %Remote{name: name} = remote, init_fun) do
    entry = Map.get(entries, name, init_fun.(remote))
    Map.put(entries, name, %{entry | last_attempt_at: DateTime.utc_now()})
  end

  @doc """
  Record a failure against `name` without touching `last_polled_at` or any
  last-good data: an error never clears what the registry already has, it only
  says so. A vanished entry (a fleet reload dropped the remote mid-fetch) is
  left dropped.
  """
  @spec record_failure(map(), String.t(), term(), DateTime.t()) :: map()
  def record_failure(entries, name, reason, now) do
    case Map.get(entries, name) do
      nil -> entries
      entry -> Map.put(entries, name, %{entry | last_attempt_at: now, last_error: reason})
    end
  end

  # ── Per-remote entry disk cache ──
  #
  # `$SHUTTLE_DATA_DIR/<registry dir>/<name>.json`, one file per remote, written
  # atomically through a `.tmp` rename. The caller supplies the already-encoded
  # map, so each registry keeps its own on-disk shape; only the mechanics are
  # shared. Persistence is best-effort: a write failure is logged and swallowed
  # because a cold cache costs one poll, while a crash here would take the
  # registry down.

  @doc "Atomically write `encoded` as `<dir>/<name>.json`. `nil` dir → no-op."
  @spec persist(String.t() | nil, String.t(), map(), String.t()) :: :ok
  def persist(nil, _name, _encoded, _label), do: :ok

  def persist(dir, name, encoded, label) do
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{safe_name(name)}.json")
    tmp = path <> ".tmp"
    File.write!(tmp, Jason.encode!(encoded))
    File.rename!(tmp, path)
    :ok
  rescue
    error ->
      Logger.debug("#{label}: persist for #{name} failed — #{inspect(error)}")
      :ok
  end

  @doc """
  The filename a remote's cache is stored under. A remote name is a routing key
  and a hostname, but it reaches a path here, so anything that is not a plain
  filename character is flattened. Public because `init/1` keys the
  `load_all/1` result by the same name.
  """
  @spec safe_name(String.t()) :: String.t()
  def safe_name(name), do: String.replace(name, ~r/[^A-Za-z0-9_.-]/, "_")

  @doc """
  Read every `<name>.json` under `dir` into `%{name => decoded | nil}`. A
  missing directory or an unreadable/malformed file degrades to no cache for
  that remote rather than failing the boot.
  """
  @spec load_all(String.t() | nil) :: %{optional(String.t()) => map() | nil}
  def load_all(nil), do: %{}

  def load_all(dir) do
    case File.ls(dir) do
      {:ok, files} ->
        files
        |> Enum.filter(&String.ends_with?(&1, ".json"))
        |> Map.new(fn file -> {Path.rootname(file), load_file(Path.join(dir, file))} end)

      _ ->
        %{}
    end
  end

  defp load_file(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, %{} = decoded} <- Jason.decode(raw) do
      decoded
    else
      _ -> nil
    end
  end

  @doc "ISO8601 for a `DateTime`, `nil` for anything else."
  @spec encode_dt(term()) :: String.t() | nil
  def encode_dt(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  def encode_dt(_), do: nil

  @doc "Inverse of `encode_dt/1`; `nil` for anything that does not parse."
  @spec decode_dt(term()) :: DateTime.t() | nil
  def decode_dt(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  def decode_dt(_), do: nil

  @doc """
  Re-resolve the fleet from the file when its change token has moved, and
  re-key `state`'s per-remote entry map (held under `key` — `:feeds` or
  `:entries`) onto it, so a fleet edit lands without a daemon bounce. A no-op
  while the token is unchanged, so the ordinary tick never re-parses the file,
  and a no-op entirely when the state was started with an explicit remote list
  (`reload_from_file?: false`). Kept entries retain their ETag and cache
  metadata, so a reload never forces a full refetch.
  """
  @spec reload_fleet(struct(), :feeds | :entries, (Remote.t() -> map())) :: struct()
  def reload_fleet(%{reload_from_file?: false} = state, _key, _init_fun), do: state

  def reload_fleet(state, key, init_fun) do
    case Shuttle.Remotes.config_token() do
      token when token == state.remotes_token ->
        state

      token ->
        remotes = configured_remotes()
        entries = reconcile(Map.fetch!(state, key), remotes, init_fun)

        state
        |> struct!(remotes: remotes, remotes_token: token)
        |> struct!([{key, entries}])
    end
  end
end
