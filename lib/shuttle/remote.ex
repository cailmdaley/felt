defmodule Shuttle.Remote do
  @moduledoc """
  Configuration record for a remote Shuttle daemon the laptop polls for
  visibility.

  A remote is identified by name (e.g. "candide", "cineca"); its `url`
  is whatever local URL the SSH tunnel maps the remote daemon's
  `127.0.0.1:4000` to (e.g. `http://localhost:4001`).

  Remotes are configured via `config :shuttle, :remotes, [...]`. Each
  entry may be a map (`%{name: "candide", url: "http://localhost:4001"}`)
  or a keyword list. Missing fields fall back to defaults documented on
  `from_config/1`.

  See [[constitution-shuttle-remote-dispatch]] for the cross-host
  contract: each daemon owns its host's `.felt/`, the laptop is a
  viewer that composites snapshots over HTTP.
  """

  @enforce_keys [:name, :url]
  defstruct [
    :name,
    :url,
    poll_interval_ms: 5_000,
    request_timeout_ms: 2_000,
    stale_multiplier: 2
  ]

  @type t :: %__MODULE__{
          name: String.t(),
          url: String.t(),
          poll_interval_ms: pos_integer(),
          request_timeout_ms: pos_integer(),
          stale_multiplier: pos_integer()
        }

  @doc """
  Parses a list of config entries (maps or keyword lists) into
  `%Shuttle.Remote{}` structs. Drops entries missing the required
  `:name` or `:url`.
  """
  @spec from_config_list([map() | keyword()]) :: [t()]
  def from_config_list(entries) when is_list(entries) do
    entries
    |> Enum.map(&from_config/1)
    |> Enum.reject(&is_nil/1)
  end

  def from_config_list(_), do: []

  @doc """
  Parses a single entry. Returns `nil` when required fields are
  missing.

  Defaults:
    * `poll_interval_ms` — 5_000
    * `request_timeout_ms` — 2_000
    * `stale_multiplier` — 2 (entry becomes stale after
      `stale_multiplier × poll_interval_ms` without a successful poll)
  """
  @spec from_config(map() | keyword()) :: t() | nil
  def from_config(%{} = entry) do
    name = fetch(entry, :name) || fetch(entry, "name")
    url = fetch(entry, :url) || fetch(entry, "url")

    if is_binary(name) and name != "" and is_binary(url) and url != "" do
      poll_interval_ms =
        fetch(entry, :poll_interval_ms) || fetch(entry, "poll_interval_ms") || 5_000

      request_timeout_ms =
        fetch(entry, :request_timeout_ms) || fetch(entry, "request_timeout_ms") || 2_000

      stale_multiplier =
        fetch(entry, :stale_multiplier) || fetch(entry, "stale_multiplier") || 2

      %__MODULE__{
        name: name,
        url: url,
        poll_interval_ms: poll_interval_ms,
        request_timeout_ms: request_timeout_ms,
        stale_multiplier: stale_multiplier
      }
    end
  end

  def from_config(entry) when is_list(entry) do
    from_config(Map.new(entry))
  end

  def from_config(_), do: nil

  defp fetch(map, key) when is_map(map), do: Map.get(map, key)
  defp fetch(_, _), do: nil

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
  Returns `true` when `last_polled_at` is older than
  `stale_multiplier × poll_interval_ms` from `now`. A `nil`
  `last_polled_at` is always stale.
  """
  @spec stale?(t(), DateTime.t() | nil, DateTime.t()) :: boolean()
  def stale?(%__MODULE__{} = _remote, nil, _now), do: true

  def stale?(%__MODULE__{poll_interval_ms: pi, stale_multiplier: m}, %DateTime{} = last, %DateTime{} = now) do
    threshold_ms = pi * m
    DateTime.diff(now, last, :millisecond) > threshold_ms
  end
end
