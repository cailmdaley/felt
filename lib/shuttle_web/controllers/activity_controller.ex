defmodule ShuttleWeb.ActivityController do
  @moduledoc """
  Per-minute activity histogram: `GET /api/v1/activity?from_ms=…&to_ms=…`.

      {"host": "hub-mac", "from_ms": …, "to_ms": …,
       "buckets": [{"m": …, "s": "…-shuttle", "cwd": "/repo", "k": "attention", "n": 3}]}

  `Shuttle.Activity` does the reading; this controller parses the window and
  stamps the host. Keys are short because a browser view polls this endpoint
  and a busy day is thousands of buckets.

  **Deliberately NOT owner-routed.** Every other per-host read here
  (`/sent-files`, `/file`) routes to the fiber's owner; this one cannot, because
  its subject is the *host*, not a fiber. Each daemon serves its own
  `events.jsonl` and stamps `host` with its own `own_host_id`; a cross-host
  temporal view fans out to each daemon and merges by that stamp.

  A missing or non-integer bound is a 400, as is an inverted or over-wide
  window (see `Shuttle.Activity`). A missing events file is a 200 with an empty
  `buckets` — a host that has never run a worker is not an error.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers,
    only: [integer_param: 2, epoch_ms_message: 1, json_with_validator: 3, file_token: 1]

  alias Shuttle.{Activity, Poller}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def show(conn, params) do
    with {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         :ok <- Activity.check_range(from_ms, to_ms) do
      json_with_validator(conn, validator(from_ms, to_ms), fn ->
        {:ok, buckets} = Activity.buckets(from_ms, to_ms)

        %{
          host: Poller.own_host_id(),
          from_ms: from_ms,
          to_ms: to_ms,
          buckets: buckets
        }
      end)
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  # The window plus both event files' `{mtime, size}`. `felt hook event` appends
  # to the live file and rotates by rename, so either operation moves this token
  # — and nothing else can change what a past window buckets to. A 304 therefore
  # skips the full-file rescan, which is the expensive half of this endpoint
  # (see `Shuttle.Activity`'s note on the missing index).
  defp validator(from_ms, to_ms) do
    live = Shuttle.WaitingTracker.default_events_file()
    {from_ms, to_ms, file_token(live), file_token(live <> ".1")}
  end

  @doc """
  `GET /api/v1/activity/composite?from_ms=…&to_ms=…` — the cross-host histogram.

  This host's buckets are read live and stamped with its own id; each remote's
  come from `Shuttle.RemoteTemporalRegistry`'s cache, filtered to the requested
  sub-window and stamped with the remote's name. A remote that is unreachable
  keeps contributing its last-good buckets, marked stale in `origins`.

  Each origin's entry reports the `window` it can actually answer for. Ask for
  more than a remote has cached and you get what it has — the mismatch between
  that window and the one you asked for is the view's cue to mark the rest as
  unknown rather than empty.
  """
  def composite(conn, params) do
    with {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         :ok <- Activity.check_range(from_ms, to_ms) do
      entries = Composite.remote_entries()
      own = Composite.own_host()
      {:ok, local} = Activity.buckets(from_ms, to_ms)

      buckets =
        Enum.map(local, &Map.put(&1, :host, own)) ++
          Enum.flat_map(entries, fn {name, entry} ->
            entry.activity_buckets
            |> Composite.in_window(:m, from_ms, to_ms)
            |> Enum.map(&Composite.stamp(&1, name))
          end)

      json(conn, %{
        host: own,
        from_ms: from_ms,
        to_ms: to_ms,
        buckets: buckets,
        origins:
          Composite.origins(
            entries,
            %{window: window_pair({from_ms, to_ms})},
            fn _name, entry -> %{window: window_pair(entry.activity_window)} end
          )
      })
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  # The covered window, as the object the UI reads. `nil` when a remote has
  # never been polled successfully — "no idea", which is not the same claim as
  # an empty window.
  defp window_pair({from_ms, to_ms}), do: %{from_ms: from_ms, to_ms: to_ms}
  defp window_pair(_), do: nil

  defp message({:bad_param, key}), do: epoch_ms_message(key)
  defp message(:inverted_range), do: "to_ms must be greater than or equal to from_ms"
  defp message(:range_too_wide), do: "range must not exceed #{Activity.max_range_days()} days"
end
