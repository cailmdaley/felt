defmodule ShuttleWeb.NarrationController do
  @moduledoc """
  Commit narration for a civil-day range:
  `GET /api/v1/narration?from=YYYY-MM-DD&to=YYYY-MM-DD`.

      {"commits": [{"iso": "2026-08-05T14:02:11+02:00", "subject": "fiber-slug: what happened"}]}

  `Shuttle.Narration` shells `git log` in this daemon's primary felt store; both
  ends of the range are inclusive, in the daemon's local timezone.

  Like `/activity`, this is a **host-scoped** read and is not owner-routed: the
  store it narrates is this host's.

  A malformed or inverted date pair is a 400. Everything downstream of that —
  no git, no repo, no commits — is a 200 with `{"commits": []}`. The strip goes
  blank; it never 500s.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Narration

  def show(conn, params) do
    with {:ok, from} <- date_param(params, "from"),
         {:ok, to} <- date_param(params, "to"),
         :ok <- ordered(from, to) do
      json(conn, %{commits: Narration.commits(from, to)})
    else
      {:error, reason} -> conn |> put_status(400) |> json(%{error: message(reason)})
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

  defp ordered(from, to) do
    if Date.compare(from, to) == :gt, do: {:error, :inverted_range}, else: :ok
  end

  defp message({:bad_param, key}), do: "#{key} is required and must be a YYYY-MM-DD date"
  defp message(:inverted_range), do: "to must be on or after from"
end
