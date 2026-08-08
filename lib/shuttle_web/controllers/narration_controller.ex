defmodule ShuttleWeb.NarrationController do
  @moduledoc """
  Commit narration for a time window:

      GET /api/v1/narration?from_ms=<int>&to_ms=<int>

      {"commits": [{"iso": "2026-08-05T14:02:11+02:00", "subject": "fiber-slug: what happened"}]}

  **One window form.** `from_ms`/`to_ms` are epoch-millisecond instants, both
  required, and are timezone-free — matching `/activity`. The caller resolves
  civil days into instants in ITS OWN zone before asking; a civil-day parameter
  would resolve here, in the daemon's zone, and silently shift the window for
  every browser that does not share it (see `Shuttle.Narration` for the measured
  skew).

  Like `/activity`, this is a **host-scoped** read and is not owner-routed: the
  store it narrates is this host's.

  A malformed, inverted, or over-wide window is a 400. Everything downstream of
  that — no git, no repo, no commits, an unresponsive store — is a 200 with
  `{"commits": []}`. The strip goes blank; it never 500s.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [integer_param: 2, epoch_ms_message: 1]

  alias Shuttle.Narration

  def show(conn, params) do
    with {:ok, window} <- instant_window(params),
         :ok <- bounded(window) do
      json(conn, %{commits: fetch(window)})
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  defp instant_window(params) do
    with {:ok, from_ms} <- integer_param(params, "from_ms"),
         {:ok, to_ms} <- integer_param(params, "to_ms"),
         true <- to_ms >= from_ms do
      {:ok, {:instants, from_ms, to_ms}}
    else
      false -> {:error, :inverted_range}
      error -> error
    end
  end

  defp bounded({:instants, from_ms, to_ms}) do
    if to_ms - from_ms > Narration.max_range_ms(), do: {:error, :range_too_wide}, else: :ok
  end

  defp fetch({:instants, from_ms, to_ms}), do: Narration.commits_between(from_ms, to_ms)

  # Total on purpose: a future bad key must 400, not FunctionClauseError into
  # the 500 this endpoint promises never to serve.
  defp message({:bad_param, key}), do: epoch_ms_message(key)
  defp message(:inverted_range), do: "to must be on or after from"
  defp message(:range_too_wide), do: "range must not exceed #{Narration.max_range_days()} days"
end
