defmodule ShuttleWeb.SessionInputController do
  @moduledoc """
  Submit a message to a Codex terminal session on its owning host.

  A 4xx or 503 answer means nothing was typed. A 502 `terminal_input_ambiguous`
  means the paste failed after text may have reached the composer.
  """

  use Phoenix.Controller, formats: [:json]
  import Plug.Conn

  alias Shuttle.{CLI, SessionLedger, Terminal, WorkerProcess}

  def create(conn, %{"session_uuid" => session, "text" => text})
      when is_binary(session) and session != "" and is_binary(text) and text != "" do
    case current_terminal(session) do
      {:ok, terminal, _harness} ->
        runner = Shuttle.Env.app(:terminal_runner, Shuttle.Runner.Default)

        case terminal_state(runner, terminal) do
          :alive ->
            case Terminal.paste(runner, terminal, text) do
              :ok -> json(conn, %{status: "submitted"})
              {:error, {:unknown, reason}} -> error(conn, 502, "terminal_input_ambiguous", reason)
              {:error, reason} -> error(conn, 503, "terminal_input_failed", reason)
            end

          :gone ->
            error(conn, 404, "session_not_running", "The session is not running")

          :unknown ->
            error(conn, 503, "terminal_unavailable", "Terminal state is unknown")
        end

      :error ->
        error(
          conn,
          404,
          "session_not_found",
          "No current terminal that takes typed input owns this session"
        )
    end
  end

  def create(conn, _params),
    do: error(conn, 400, "invalid_request", "session_uuid and non-empty text are required")

  def receiver(conn, %{"session_uuid" => session}) when is_binary(session) and session != "" do
    case current_terminal(session) do
      {:ok, terminal, harness} ->
        runner = Shuttle.Env.app(:terminal_runner, Shuttle.Runner.Default)

        case terminal_state(runner, terminal) do
          :alive -> receiver_process(conn, session, terminal, harness, runner)
          :gone -> error(conn, 404, "session_not_running", "The session is not running")
          :unknown -> error(conn, 503, "terminal_unavailable", "Terminal state is unknown")
        end

      :error ->
        error(
          conn,
          404,
          "session_not_found",
          "No current terminal that takes typed input owns this session"
        )
    end
  end

  def receiver(conn, _params),
    do: error(conn, 400, "invalid_request", "session_uuid is required")

  defp terminal_state(runner, terminal) do
    if Terminal.locate(runner, terminal),
      do: :alive,
      else: if(Terminal.status(runner, terminal) == :gone, do: :gone, else: :unknown)
  end

  defp receiver_process(conn, session, terminal, harness, runner) do
    case WorkerProcess.scan(runner) do
      {:ok, processes} ->
        case WorkerProcess.resumed_process(
               processes,
               terminal,
               harness.binary(),
               harness.resume_args(session)
             ) do
          %{pid: pid} -> receiver_identity(conn, session, pid, runner)
          nil -> error(conn, 404, "session_not_running", "Native harness process is not running")
        end

      {:error, :unknown} ->
        error(conn, 503, "process_scan_unavailable", "Process state is unknown")
    end
  end

  defp receiver_identity(conn, session, pid, runner) do
    case CLI.run(["process-identity", Integer.to_string(pid)],
           runner: runner,
           timeout_ms: 2_000
         ) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"status" => "present", "start" => start}}
          when is_binary(start) and start != "" ->
            json(conn, %{session_uuid: session, pid: pid, process_start: start})

          {:ok, %{"status" => "gone"}} ->
            error(conn, 404, "session_not_running", "Native Codex process has exited")

          _ ->
            error(conn, 503, "process_identity_unavailable", "Process lifetime is unknown")
        end

      _ ->
        error(conn, 503, "process_identity_unavailable", "Process lifetime is unknown")
    end
  end

  defp current_terminal(session) do
    case SessionLedger.latest_for_session(session) do
      %{
        "session" => ^session,
        "harness" => harness,
        "host" => host,
        "tmux" => terminal,
        "uid" => uid
      }
      when is_binary(terminal) and is_binary(uid) ->
        case {host == Shuttle.Poller.own_host_id(), SessionLedger.latest_for_uid(uid),
              Shuttle.Harness.module(harness)} do
          {true, %{"session" => ^session, "tmux" => ^terminal}, module}
          when module != nil ->
            if module.takes_paste?(), do: {:ok, terminal, module}, else: :error

          _ ->
            :error
        end

      _ ->
        :error
    end
  end

  defp error(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: message, code: code})
  end
end
