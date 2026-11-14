defmodule ShuttleWeb.SessionResumeController do
  @moduledoc """
  `POST /api/v1/sessions/resume` — `{"session": "<uuid>"}`: resume that harness
  session on THIS host, as its constitution's worker or in a terminal of its
  own (`Shuttle.SessionResume`), and answer `{"tmux_session": <terminal>,
  "created": bool}`. 409 when the session is a running worker's or its card has
  another live conversation, 422 with `{error}` when there is no transcript here
  to resume or the worker did not start, 400 for a malformed id.

  Host-local by design: it is the leg `POST /api/v1/attach` forwards to the host
  that ran a session, which alone has its transcript. It opens no terminal; the
  daemon serving the viewer's board does that. See `Shuttle.SessionResume`.
  """

  use Phoenix.Controller, formats: [:json]

  import Plug.Conn

  alias Shuttle.{SessionResume, Transcript}

  def create(conn, %{"session" => session}) when is_binary(session) do
    if Transcript.valid_session?(session) do
      case SessionResume.prepare(session, prepare_opts()) do
        {:ok, result} ->
          json(conn, result)

        {:error, {:live, reason}} ->
          conn |> put_status(409) |> json(%{error: reason})

        {:error, reason} ->
          conn |> put_status(422) |> json(%{error: format_error(reason)})
      end
    else
      conn |> put_status(400) |> json(%{error: "session must be a UUID"})
    end
  end

  def create(conn, _params), do: conn |> put_status(400) |> json(%{error: "session is required"})

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason), do: inspect(reason)

  @doc false
  # The runner and the live-session source, injectable for tests.
  def prepare_opts do
    [
      runner: SessionResume.runner(),
      live_sessions: Shuttle.Env.app(:session_resume_live, &SessionResume.live_sessions/0)
    ]
  end
end
