defmodule Shuttle.CodexTerminal do
  @moduledoc "Replaceable terminal viewers of durably owned App Server threads."

  alias Shuttle.{AppWorkers, Dispatcher, Terminal}
  require Logger

  def tmux_name(id), do: "codex-terminal-" <> id

  @doc "Shared exclusion for preparing, stopping and retiring a conversation's viewer."
  def lock_id(id), do: {{__MODULE__, AppWorkers.root(), id}, self()}

  @doc """
  Close leftover viewers of conversations Shuttle no longer owns.

  A viewer is leftover when its ownership record is inactive (the assignment
  was retired or stopped) and its thread has no running turn. An active record,
  a missing or unreadable record, or an unconfirmed thread state keeps the
  viewer. The App Server and the conversation are never touched. Returns the
  viewers closed, including those with attached clients.
  """
  def sweep(runner) do
    case Terminal.list(runner, "codex-terminal-") do
      {:ok, names} ->
        names
        |> Enum.flat_map(fn
          "codex-terminal-" <> id = tmux -> [{id, tmux}]
          _ -> []
        end)
        |> Enum.filter(fn {id, tmux} -> retire_leftover(runner, id, tmux) end)
        |> Enum.map(&elem(&1, 1))

      _ ->
        []
    end
  end

  # The poller never waits on the terminal lock: a viewer being prepared or
  # stopped elsewhere is left for the next sweep.
  defp retire_leftover(runner, id, tmux) do
    :global.trans(
      lock_id(id),
      fn ->
        with {:ok, %{"active" => false} = record} <- AppWorkers.get(id),
             true <- (record["terminal_tmux"] || tmux_name(id)) == tmux,
             state when state in [:idle, :not_loaded, :missing, :system_error] <-
               AppWorkers.state(id),
             {_, 0} <- Terminal.stop(runner, tmux) do
          true
        else
          _ -> false
        end
      end,
      [node()],
      0
    ) == true
  end

  @doc "Interactive wait budget; a viewer launch owns its completion after the caller leaves."
  def prepare_timeout_ms, do: Shuttle.Env.app(:terminal_prepare_timeout_ms, 10_000)
  def forward_timeout_ms, do: prepare_timeout_ms() + 2_000
  def rpc_timeout_ms, do: Shuttle.Env.app(:terminal_rpc_timeout_ms, 5_000)

  def prepare(id, opts \\ []) do
    token = Integer.to_string(System.unique_integer([:positive, :monotonic]))

    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        prepare_owned(id, opts, token)
      end)

    case Task.yield(task, Keyword.get(opts, :wait_timeout_ms, :infinity)) do
      {:ok, result} ->
        result

      {:exit, reason} ->
        Logger.warning("Codex terminal preparation exited for #{id}: #{inspect(reason)}")
        record_result(id, token, {:error, :terminal_prepare_failed}, true)
        {:error, :terminal_prepare_failed}

      nil ->
        record_result(id, token, {:error, :terminal_prepare_timeout}, false)
        Task.ignore(task)
        {:error, :terminal_prepare_timeout}
    end
  end

  defp prepare_owned(id, opts, token) do
    case :global.trans(lock_id(id), fn -> prepare_locked(id, opts, token) end, [node()], 0) do
      :aborted -> {:error, :terminal_busy}
      result -> result
    end
  end

  defp prepare_locked(id, opts, token) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

    with {:ok, %{"active" => true, "surface" => "cli"} = record} <- AppWorkers.get(id),
         :ok <- AppWorkers.update(id, %{"terminal_prepare_token" => token}) do
      result =
        with true <- record["launch_state"] == "running" || {:error, :initial_turn_unconfirmed},
             :ok <- AppWorkers.check_endpoint(record),
             :ok <- verified_thread(id, 10) do
          tmux = record["terminal_tmux"] || tmux_name(id)

          case Terminal.status(runner, tmux) do
            :alive -> {:ok, %{tmux_session: tmux, created: false}}
            :unknown -> {:error, :terminal_visibility_unknown}
            :gone -> start(id, record, tmux, runner, opts)
          end
        end

      record_result(id, token, result, true)
      result
    else
      {:ok, _} -> {:error, :not_a_terminal_worker}
      error -> error
    end
  end

  # The operation token keeps a caller's timeout from overwriting a task that
  # has already completed. Completion clears both the error and retry deadline.
  defp record_result(id, token, result, finished) do
    values =
      case result do
        {:ok, _} ->
          %{"terminal_error" => nil, "terminal_retry_at" => nil}

        {:error, reason} ->
          retry_at =
            if reason != :backend_not_ready, do: System.system_time(:millisecond) + 300_000

          %{"terminal_error" => inspect(reason), "terminal_retry_at" => retry_at}
      end

    values = if finished, do: Map.put(values, "terminal_prepare_token", nil), else: values

    AppWorkers.update(id, fn record ->
      {:ok,
       if(record["terminal_prepare_token"] == token, do: Map.merge(record, values), else: record)}
    end)

    case result do
      {:error, reason} when reason != :backend_not_ready ->
        Logger.warning("Codex terminal preparation failed for #{id}: #{inspect(reason)}")

      _ ->
        :ok
    end
  end

  def error_message(message) when is_binary(message), do: message

  def error_message(:terminal_busy),
    do: "This conversation's terminal is already being prepared. Try again shortly."

  def error_message(:terminal_prepare_timeout),
    do:
      "Preparing this conversation's terminal timed out; the Codex App Server or terminal backend did not answer."

  def error_message(:timeout), do: "The Codex App Server did not answer for this conversation."

  def error_message(:disconnected),
    do: "The Codex App Server disconnected while preparing this conversation."

  def error_message(:not_found),
    do: "This conversation has no worker ownership record on its host."

  def error_message(:not_a_terminal_worker),
    do: "This conversation is not an active terminal worker."

  def error_message(:initial_turn_unconfirmed),
    do: "This conversation's initial turn is not confirmed; its terminal cannot be opened yet."

  def error_message(:terminal_identity_mismatch),
    do: "The host answered with a different conversation's terminal; nothing was opened."

  def error_message(:terminal_visibility_unknown),
    do: "The host cannot currently determine whether this conversation's terminal is running."

  def error_message(:native_thread_unverified),
    do: "The Codex App Server could not verify this exact conversation; nothing was opened."

  def error_message(:backend_not_ready),
    do: "The Codex App Server is not ready. Try again shortly."

  def error_message(reason) do
    Logger.warning("Terminal open failed: #{inspect(reason)}")
    "The host could not prepare this conversation's terminal. Check its daemon log for details."
  end

  defp verified_thread(id, retries) do
    # A systemError describes a failed turn in a loaded conversation. Native
    # resume and a new turn still use this exact thread, even while that status
    # remains visible.
    case AppWorkers.call(id, :read_thread, [[timeout_ms: rpc_timeout_ms()]]) do
      {:ok, %{"id" => ^id, "status" => %{"type" => type}}}
      when type in ["active", "idle", "notLoaded", "systemError"] ->
        :ok

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        :ok

      {:error, {:peer, %{"code" => -32_603, "message" => message}}} = error when retries > 0 ->
        if String.contains?(message, "rollout at ") and String.ends_with?(message, " is empty") do
          Process.sleep(100)
          verified_thread(id, retries - 1)
        else
          error
        end

      {:error, reason} ->
        {:error, reason}

      _ ->
        {:error, :native_thread_unverified}
    end
  end

  defp start(id, record, tmux, runner, opts) do
    agent = %{id: record["agent_id"], wrapper: record["terminal_wrapper"]}
    cwd = record["cwd"]

    with true <-
           (is_binary(agent.wrapper) and is_binary(cwd)) || {:error, :terminal_recipe_missing},
         :ok <-
           if(opts[:preflighted],
             do: :ok,
             else: Dispatcher.preflight_terminal(agent, cwd, runner)
           ),
         :ok <- resume_exact(id, 10),
         :ok <-
           Terminal.launch(runner, tmux, cwd, script(id, record, tmux),
             fiber: record["fiber_id"],
             felt_store: record["felt_store"],
             preflighted: true
           ) do
      {:ok, %{tmux_session: tmux, created: true}}
    end
  end

  # Initial turn acceptance and rollout persistence are separate boundaries.
  # Confirm the exact resume before spawning the TUI; an empty or lost initial
  # turn must never turn into a viewer of a fresh conversation.
  defp resume_exact(id, retries) do
    case AppWorkers.call(id, :resume_thread, [[timeout_ms: rpc_timeout_ms()]]) do
      {:ok, %{"id" => ^id}} ->
        :ok

      {:error,
       {:peer, %{"code" => -32_600, "message" => "no rollout found for thread id " <> ^id}}}
      when retries > 0 ->
        Process.sleep(100)
        resume_exact(id, retries - 1)

      {:error, reason} ->
        {:error, reason}

      _ ->
        {:error, :native_thread_unverified}
    end
  end

  defp script(id, record, tmux) do
    endpoint = "unix://" <> record["backend_endpoint"]
    snippets = Terminal.primary().script(tmux)

    """
    #!/bin/bash
    trap 'rm -f "$0"' EXIT
    #{snippets.env}#{Dispatcher.erts_scrub_block()}
    #{snippets.wait_for_viewer}
    #{command(record["terminal_wrapper"], record["cwd"], id, endpoint)}
    """
  end

  def command(wrapper, cwd, id, endpoint) do
    "env -u TMUX -u TMUX_PANE #{wrapper} --remote #{quote_word(endpoint)} -C #{quote_word(cwd)} resume #{quote_word(id)}"
  end

  defp quote_word(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
end
