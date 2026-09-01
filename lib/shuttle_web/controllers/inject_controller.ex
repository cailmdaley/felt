defmodule ShuttleWeb.InjectController do
  @moduledoc """
  Paste text into a live worker's prompt without submitting it: `POST /api/v1/inject`.

  The text is loaded into a tmux buffer from a temporary file and pasted with
  bracketed-paste mode. Newlines therefore remain part of one paste, and the
  endpoint never sends Enter.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.Poller

  def create(conn, %{"fiber_id" => fiber_id, "text" => text} = params)
      when is_binary(fiber_id) and is_binary(text) do
    case Poller.inject(fiber_id, text) do
      {:ok, %{session: session, bytes: bytes}} ->
        case maybe_raise(params, session) do
          :ok -> json(conn, %{session: session, bytes: bytes})
          {:error, reason} -> conn |> put_status(502) |> json(%{error: reason})
        end

      {:error, :not_found} ->
        conn |> put_status(404) |> json(%{error: "no live session for fiber"})

      {:error, {:paste_failed, output, status}} ->
        conn
        |> put_status(409)
        |> json(%{error: "tmux paste failed", detail: String.trim(output), status: status})
    end
  end

  def create(conn, _params) do
    conn |> put_status(400) |> json(%{error: "fiber_id and text are required"})
  end

  defp maybe_raise(%{"raise" => false}, _session), do: :ok
  defp maybe_raise(_params, session), do: Shuttle.Kitty.open(session)
end
