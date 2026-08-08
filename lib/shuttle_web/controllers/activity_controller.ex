defmodule ShuttleWeb.ActivityController do
  @moduledoc """
  Per-minute activity histogram: `GET /api/v1/activity?from_ms=…&to_ms=…`.

      {"host": "dapmcw68", "from_ms": …, "to_ms": …,
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

  import ShuttleWeb.RelayHelpers, only: [integer_param: 2, epoch_ms_message: 1]

  alias Shuttle.{Activity, Poller}

  def show(conn, params) do
    with {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         {:ok, buckets} <- Activity.buckets(from_ms, to_ms) do
      json(conn, %{
        host: Poller.own_host_id(),
        from_ms: from_ms,
        to_ms: to_ms,
        buckets: buckets
      })
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  defp message({:bad_param, key}), do: epoch_ms_message(key)
  defp message(:inverted_range), do: "to_ms must be greater than or equal to from_ms"
  defp message(:range_too_wide), do: "range must not exceed #{Activity.max_range_days()} days"
end
