defmodule ShuttleWeb.NarrationController do
  @moduledoc """
  Commit narration for a time window:

      GET /api/v1/narration?from_ms=<int>&to_ms=<int>     # preferred
      GET /api/v1/narration?from=YYYY-MM-DD&to=YYYY-MM-DD # legacy, daemon-zone

      {"commits": [{"iso": "2026-08-05T14:02:11+02:00", "subject": "fiber-slug: what happened"}]}

  **Two window forms, instants win.** `from_ms`/`to_ms` are epoch-millisecond
  instants and are timezone-free, matching `/activity`. The civil-day
  `from`/`to` pair is the original contract, kept working so an already-shipped
  `ui/dist` does not go blank, but it resolves in the *daemon's* timezone while
  the browser computed those dates in its own — see `Shuttle.Narration` for the
  measured skew. When either `from_ms` or `to_ms` is present the request is
  read as an instant window and both are required; only a request naming
  neither falls back to civil days.

  Like `/activity`, this is a **host-scoped** read and is not owner-routed: the
  store it narrates is this host's.

  A malformed, inverted, or over-wide window is a 400. Everything downstream of
  that — no git, no repo, no commits, an unresponsive store — is a 200 with
  `{"commits": []}`. The strip goes blank; it never 500s.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Narration

  def show(conn, params) do
    with {:ok, window} <- window(params),
         :ok <- bounded(window) do
      json(conn, %{commits: fetch(window)})
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
    end
  end

  # Presence of either instant key selects the instant form, so a half-migrated
  # caller sending only `from_ms` gets "to_ms is required" rather than a
  # confusing complaint about the civil-day params it never sent.
  defp window(params) do
    if Map.has_key?(params, "from_ms") or Map.has_key?(params, "to_ms") do
      instant_window(params)
    else
      civil_window(params)
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

  defp civil_window(params) do
    with {:ok, from} <- date_param(params, "from"),
         {:ok, to} <- date_param(params, "to"),
         :lt_or_eq <- compare(from, to) do
      {:ok, {:days, from, to}}
    else
      :gt -> {:error, :inverted_range}
      error -> error
    end
  end

  defp compare(from, to), do: if(Date.compare(from, to) == :gt, do: :gt, else: :lt_or_eq)

  # One bound, expressed in whichever unit the caller used.
  defp bounded({:instants, from_ms, to_ms}) do
    if to_ms - from_ms > Narration.max_range_ms(), do: {:error, :range_too_wide}, else: :ok
  end

  defp bounded({:days, from, to}) do
    if Date.diff(to, from) > Narration.max_range_days(), do: {:error, :range_too_wide}, else: :ok
  end

  defp fetch({:instants, from_ms, to_ms}), do: Narration.commits_between(from_ms, to_ms)
  defp fetch({:days, from, to}), do: Narration.commits(from, to)

  # Strict, matching ActivityController: the whole value must be an integer.
  defp integer_param(params, key) do
    case Map.get(params, key) do
      value when is_binary(value) ->
        case Integer.parse(value) do
          {int, ""} -> {:ok, int}
          _ -> {:error, {:bad_param, key}}
        end

      _ ->
        {:error, {:bad_param, key}}
    end
  end

  defp date_param(params, key) do
    case Map.get(params, key) do
      value when is_binary(value) ->
        case Date.from_iso8601(value) do
          {:ok, date} -> {:ok, date}
          _ -> {:error, {:bad_param, key}}
        end

      _ ->
        {:error, {:bad_param, key}}
    end
  end

  defp message({:bad_param, "from_ms"}),
    do: "from_ms is required and must be an integer (epoch ms)"

  defp message({:bad_param, "to_ms"}), do: "to_ms is required and must be an integer (epoch ms)"
  defp message({:bad_param, key}), do: "#{key} is required and must be a YYYY-MM-DD date"
  defp message(:inverted_range), do: "to must be on or after from"
  defp message(:range_too_wide), do: "range must not exceed #{Narration.max_range_days()} days"
end
