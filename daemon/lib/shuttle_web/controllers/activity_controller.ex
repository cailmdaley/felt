defmodule ShuttleWeb.ActivityController do
  @moduledoc """
  Per-minute activity histogram: `GET /api/v1/activity?from_ms=…&to_ms=…`.

      {"host": "hub-mac", "from_ms": …, "to_ms": …,
       "buckets": [{"m": …, "s": "…-shuttle", "cwd": "/repo", "k": "attention", "n": 3}]}

  `Shuttle.Activity` does the reading — a slice of the fold
  `Shuttle.Activity.Follower` keeps in memory; this controller parses the
  window and stamps the host. Keys are short because a busy day is thousands
  of buckets.

  The weak `ETag` saves bandwidth, not work: it covers `events.jsonl`, which
  moves every few seconds on a busy host, and answering without it costs a
  range read of the in-memory tally.

  The window is served in whole minutes (`Shuttle.Activity.canonical_window/2`):
  the echoed `from_ms`/`to_ms` are the canonical bounds, and the buckets are
  exactly those whose minute lies in the requested window.

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
    only: [integer_param: 2, epoch_ms_message: 1, json_with_validator: 3, rotating_file_tokens: 1]

  alias Shuttle.{Activity, Poller}
  alias ShuttleWeb.TemporalComposite, as: Composite

  def show(conn, params) do
    with {:ok, requested, {from_ms, to_ms}} <- window_params(params) do
      # The canonical window plus both event files' `{mtime, size}`. The
      # response is a function of exactly those (see `Shuttle.Activity`'s
      # whole-minutes note): `felt hook event` appends to the live file and
      # rotates by rename, so either operation moves the tokens, and two
      # requests whose bounds differ inside a minute share one validator. A 304
      # skips re-sending an unchanged body.
      json_with_validator(conn, {from_ms, to_ms, events_tokens()}, fn ->
        %{
          host: Poller.own_host_id(),
          from_ms: from_ms,
          to_ms: to_ms,
          buckets: buckets!(requested)
        }
      end)
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  @doc """
  `GET /api/v1/activity/composite?from_ms=…&to_ms=…` — the cross-host histogram.

  This host's buckets are read live and stamped with its own id; each remote's
  come from `Shuttle.RemoteTemporalRegistry`, filtered to the requested window
  and stamped with the remote's name. A remote that is unreachable keeps
  contributing its last-good buckets, marked stale in `origins`.

  Each origin's entry reports the `window` it can actually answer for. Ask for
  more than a remote holds and you get what it has — the mismatch between that
  window and the one you asked for is the view's cue to mark the rest as
  unknown rather than empty.
  """
  def composite(conn, params) do
    with {:ok, requested, {from_ms, to_ms}} <- window_params(params) do
      entries = Composite.remote_entries(:activity)
      validator = Composite.validator({from_ms, to_ms, events_tokens()}, entries)

      json_with_validator(conn, validator, fn ->
        own = Composite.own_host()

        %{
          host: own,
          from_ms: from_ms,
          to_ms: to_ms,
          buckets:
            Enum.map(buckets!(requested), &Map.put(&1, :host, own)) ++
              Composite.remote_items(entries, :m, from_ms, to_ms),
          origins:
            Composite.origins(
              entries,
              %{window: window_pair({from_ms, to_ms})},
              fn _name, entry -> %{window: window_pair(entry.window)} end
            )
        }
      end)
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  # Both bounds as requested (range-checked; `Shuttle.Activity.window/3`
  # canonicalizes them itself) and their canonical pair, which is what the
  # validator, the echo and the remote filter use — so all of them see the one
  # window the slice reads.
  defp window_params(params) do
    with {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         :ok <- Activity.check_range(from_ms, to_ms) do
      {:ok, {from_ms, to_ms}, Activity.canonical_window(from_ms, to_ms)}
    end
  end

  defp buckets!({from_ms, to_ms}) do
    {:ok, buckets} = Activity.window(from_ms, to_ms)
    buckets
  end

  defp events_tokens, do: rotating_file_tokens(Shuttle.WaitingTracker.default_events_file())

  # The covered window, as the object the UI reads. `nil` when a remote has
  # never been polled successfully — "no idea", which is not the same claim as
  # an empty window.
  defp window_pair({from_ms, to_ms}), do: %{from_ms: from_ms, to_ms: to_ms}
  defp window_pair(_), do: nil

  defp message({:bad_param, key}), do: epoch_ms_message(key)
  defp message(:inverted_range), do: "to_ms must be greater than or equal to from_ms"
  defp message(:range_too_wide), do: "range must not exceed #{Activity.max_range_days()} days"
end
