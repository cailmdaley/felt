defmodule ShuttleWeb.SessionResumeController do
  @moduledoc """
  `POST /api/v1/sessions/resume` — `{"session": "<uuid>"}`: start (or find) the
  tmux session resuming that harness session on THIS host, and answer
  `{"tmux_session": "resume-<uuid>", "created": bool}`. 409 when the session is
  a running worker's (attach to it instead), 422 with `{error}` when there is no
  transcript here to resume, 400 for a malformed id.

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
        {:ok, result} -> json(conn, result)
        {:error, {:live, reason}} -> conn |> put_status(409) |> json(%{error: reason})
        {:error, reason} -> conn |> put_status(422) |> json(%{error: reason})
      end
    else
      conn |> put_status(400) |> json(%{error: "session must be a UUID"})
    end
  end

  def create(conn, _params), do: conn |> put_status(400) |> json(%{error: "session is required"})

  @doc false
  # The runner and the live-session source, injectable for tests.
  def prepare_opts do
    [
      runner: Application.get_env(:shuttle, :session_resume_runner, Shuttle.Runner.Default),
      live_sessions:
        Application.get_env(:shuttle, :session_resume_live, &SessionResume.live_sessions/0)
    ]
  end
end
