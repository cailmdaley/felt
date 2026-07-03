defmodule Shuttle.CLI do
  @moduledoc """
  CLI entrypoint for the shuttle escript.

  Subcommands:
    dispatch <fiber-id>   — one-shot dispatch for a specific fiber
    start                 — start the daemon (refuses if one is already running)
    start --force         — start even if a daemon is detected
    status                — human-readable status dump (queries running daemon; filesystem fallback)
    snapshot              — JSON snapshot for consumers (queries running daemon; filesystem fallback)
    release               — release the boot quarantine (parked launches dispatch on the next tick)
    reset <remote>        — reset a remote's tripped circuit breaker (recovery cascade re-runs once)
    version               — print version

  ## IPC model

  `status` and `snapshot` first attempt an HTTP GET to the running daemon at
  `localhost:<port>/api/v1/state`. When the daemon is reachable, its in-memory
  view is returned — no orphan-adoption noise, no parallel BEAM. When the daemon
  is not reachable, both commands print a `(daemon down — filesystem view)`
  header and derive what they can from tmux directly, then exit with code 2 so
  callers can distinguish the fallback path from a healthy response.

  `start` performs the same HTTP check first and refuses to start a second daemon
  unless `--force` is passed. This prevents the duplicate-daemon footgun where
  `bin/shuttle start &` from a terminal that later closes leaves a launchd-orphan
  competing with the dev.sh-managed daemon.
  """

  alias Shuttle.Dispatcher

  # ── Entry ──

  def main(args) do
    case args do
      ["dispatch", fiber_id] ->
        case Dispatcher.dispatch(fiber_id) do
          {:ok, session} ->
            IO.puts("Dispatched #{fiber_id}")
            IO.puts("  Session: #{session}")
            IO.puts("  Attach:  tmux attach -t #{session}")

          {:error, :not_found} ->
            IO.puts(:stderr, "Fiber not found: #{fiber_id}")
            System.halt(1)

          {:error, :closed} ->
            IO.puts(:stderr, "Fiber #{fiber_id} is closed; refusing to dispatch.")
            System.halt(1)

          {:error, :already_running} ->
            IO.puts(:stderr, "Shuttle worker already running for #{fiber_id}")
            System.halt(0)

          {:error, reason} ->
            IO.puts(:stderr, "Dispatch failed: #{reason}")
            System.halt(1)
        end

      ["start"] ->
        case query_daemon() do
          {:ok, _} ->
            port = daemon_port()

            IO.puts(
              :stderr,
              "Daemon already running at localhost:#{port}. " <>
                "Use `bin/shuttle stop` first, or pass --force to launch anyway."
            )

            System.halt(1)

          {:error, _} ->
            IO.puts("Starting Shuttle daemon...")
            {:ok, _} = Application.ensure_all_started(:shuttle)
            IO.puts("Shuttle running. Press Ctrl+C to exit.")
            Process.sleep(:infinity)
        end

      ["start", "--force"] ->
        IO.puts("Starting Shuttle daemon (--force)...")
        {:ok, _} = Application.ensure_all_started(:shuttle)
        IO.puts("Shuttle running. Press Ctrl+C to exit.")
        Process.sleep(:infinity)

      ["snapshot"] ->
        case query_daemon() do
          {:ok, state} ->
            IO.puts(Jason.encode!(state))

          {:error, _} ->
            IO.puts(:stderr, "(daemon down — filesystem view)")
            print_snapshot_fallback()
            System.halt(2)
        end

      ["status"] ->
        case query_daemon() do
          {:ok, state} ->
            print_status(state)

          {:error, _} ->
            print_fallback_status()
            System.halt(2)
        end

      ["release"] ->
        case release_quarantine() do
          {:ok, _} ->
            IO.puts("quarantine released — parked launches will dispatch on the next tick")

          {:error, {:http_status, 503}} ->
            IO.puts(:stderr, "release failed: daemon is up but the poller isn't running")
            System.halt(1)

          {:error, reason} ->
            IO.puts(:stderr, "release failed: daemon unreachable (#{inspect(reason)})")
            System.halt(1)
        end

      ["reset", remote] ->
        case reset_breaker(remote) do
          {:ok, _} ->
            IO.puts("circuit breaker reset for #{remote} — recovery cascade re-running")

          {:error, {:http_status, 404}} ->
            IO.puts(:stderr, "reset failed: unknown remote #{remote}")
            System.halt(1)

          {:error, {:http_status, 409}} ->
            IO.puts(:stderr, "reset failed: #{remote}'s circuit breaker is not tripped")
            System.halt(1)

          {:error, {:http_status, 503}} ->
            IO.puts(:stderr, "reset failed: daemon is up but the remote registry isn't running")
            System.halt(1)

          {:error, reason} ->
            IO.puts(:stderr, "reset failed: daemon unreachable (#{inspect(reason)})")
            System.halt(1)
        end

      ["version"] ->
        IO.puts(Shuttle.version())

      _ ->
        IO.puts("Usage: shuttle <command>")
        IO.puts("")
        IO.puts("Commands:")
        IO.puts("  dispatch <fiber-id>  Dispatch a worker for a specific fiber")
        IO.puts("  start                Start the daemon (refuses if already running)")
        IO.puts("  start --force        Start even if another daemon is detected")
        IO.puts("  snapshot             Print JSON snapshot of current state")
        IO.puts("  release              Release the boot quarantine so parked launches dispatch")
        IO.puts("  reset <remote>       Reset a remote's tripped circuit breaker")
        IO.puts("  status               Human-readable status dump")
        IO.puts("  version              Print version")
        System.halt(1)
    end
  end

  # ── Status rendering ──

  @doc false
  def print_status(snap) do
    IO.puts("Shuttle v#{Shuttle.version()} — #{snap.host}")
    IO.puts("Poll at: #{DateTime.from_unix!(snap.poll_at, :millisecond)}")
    IO.puts("")

    if snap.eligible == [] do
      IO.puts("No running workers.")
    else
      IO.puts("Running workers (#{length(snap.eligible)}):")

      Enum.each(snap.eligible, fn w ->
        IO.puts("  • #{w.fiber_id}")

        IO.puts(
          "    session: #{w.tmux_session}  agent: #{w.agent}  runtime: #{w.runtime_seconds}s"
        )
      end)
    end

    IO.puts("")

    if snap.retrying == [] do
      IO.puts("No retry queue.")
    else
      IO.puts("Retry queue (#{length(snap.retrying)}):")

      Enum.each(snap.retrying, fn r ->
        IO.puts("  • #{r.fiber_id} — attempt #{r.attempt}, due in #{r.due_in_ms}ms")
      end)
    end

    IO.puts("")
    print_standing_roles(Map.get(snap, :standing_roles, []))
  end

  defp print_standing_roles([]) do
    IO.puts("No standing roles.")
  end

  defp print_standing_roles(roles) do
    IO.puts("Standing roles (#{length(roles)}):")

    Enum.each(roles, fn role ->
      IO.puts("  • #{role.fiber_id} — #{role.state}")
      print_optional("run", role.run_id)
      print_optional("next due", format_unix_ms(role.next_due_at))
      print_optional("last run", format_unix_ms(role.last_run_at))

      if role.validation_errors != [] do
        IO.puts("    validation: #{Enum.join(role.validation_errors, "; ")}")
      end
    end)
  end

  defp print_optional(_label, nil), do: :ok
  defp print_optional(_label, ""), do: :ok
  defp print_optional(label, value), do: IO.puts("    #{label}: #{value}")

  defp format_unix_ms(nil), do: nil

  defp format_unix_ms(ms) do
    ms
    |> DateTime.from_unix!(:millisecond)
    |> DateTime.to_iso8601()
  end

  # ── Fallback rendering (daemon down — no BEAM startup) ──

  defp print_fallback_status do
    IO.puts("No running daemon. Filesystem view:")
    IO.puts("")

    case tmux_shuttle_sessions() do
      [] ->
        IO.puts("No running workers.")

      sessions ->
        IO.puts("Active shuttle sessions (#{length(sessions)}):")
        Enum.each(sessions, fn s -> IO.puts("  • #{s}") end)
    end
  end

  defp print_snapshot_fallback do
    sessions = tmux_shuttle_sessions()

    fallback = %{
      daemon_down: true,
      host: Shuttle.Poller.own_host_id(),
      poll_at: System.os_time(:millisecond),
      eligible: sessions,
      retrying: [],
      standing_roles: []
    }

    IO.puts(Jason.encode!(fallback))
  end

  # List Shuttle tmux sessions without starting the OTP application.
  # Returns [] when tmux is not running or there are no matching sessions.
  defp tmux_shuttle_sessions do
    case System.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {output, 0} ->
        output
        |> String.split("\n")
        |> Enum.map(&String.trim/1)
        |> Enum.filter(&Dispatcher.shuttle_session?/1)

      {_, _} ->
        []
    end
  end

  # ── Daemon IPC ──
  #
  # All daemon commands ride `daemon_request/3`: an HTTP round-trip to the
  # running daemon on localhost, decoding the 200 body with atom keys.
  # Non-200 responses come back as {:error, {:http_status, status}} so each
  # verb can render its own guidance; an unreachable daemon is {:error, reason}.
  # Each public wrapper accepts an optional port for testability; nil means
  # the configured port.

  # GET the running daemon's state (`status` / `snapshot` / `start` probe).
  @doc false
  def query_daemon(port \\ nil), do: daemon_request(:get, "/api/v1/state", port)

  # POST the quarantine-release endpoint (`release`). A 503 means the daemon
  # is up but the poller isn't running.
  @doc false
  def release_quarantine(port \\ nil), do: daemon_request(:post, "/api/v1/quarantine/release", port)

  # POST the circuit-breaker reset endpoint (`reset <remote>`). 404 = unknown
  # remote, 409 = breaker not tripped, 503 = remote registry not running.
  @doc false
  def reset_breaker(remote, port \\ nil) do
    daemon_request(:post, "/api/v1/remotes/#{remote}/reset", port)
  end

  defp daemon_request(method, path, port) do
    port = port || daemon_port()
    url = String.to_charlist("http://localhost:#{port}#{path}")

    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    request =
      case method do
        :get -> {url, []}
        :post -> {url, [], ~c"application/json", ""}
      end

    case :httpc.request(method, request, [{:timeout, 2000}, {:connect_timeout, 1000}], []) do
      {:ok, {{_, 200, _}, _headers, body}} ->
        body_str = if is_list(body), do: List.to_string(body), else: body

        case Jason.decode(body_str, keys: :atoms) do
          {:ok, resp} -> {:ok, resp}
          {:error, _} -> {:error, :invalid_response}
        end

      {:ok, {{_, status, _}, _, _}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    _ -> {:error, :connection_failed}
  end

  @doc false
  def daemon_port do
    # Application.get_env is unreliable in escript mode before
    # Application.ensure_all_started — compile-time config isn't loaded.
    # Read from env var instead, matching maybe_configure_endpoint/0.
    System.get_env("SHUTTLE_PORT", "4000") |> String.to_integer()
  end

end
