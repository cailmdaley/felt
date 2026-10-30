defmodule Shuttle.CodexTerminal do
  @moduledoc "Replaceable terminal viewers of durably owned App Server threads."

  alias Shuttle.{AppWorkers, Dispatcher, Terminal}

  def tmux_name(id), do: "codex-terminal-" <> id

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
      {{__MODULE__, id}, self()},
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

  def prepare(id, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

    result =
      :global.trans({{__MODULE__, id}, self()}, fn ->
        with {:ok, %{"active" => true, "surface" => "cli"} = record} <- AppWorkers.get(id),
             true <- record["launch_state"] == "running" || {:error, :initial_turn_unconfirmed},
             :ok <- AppWorkers.check_endpoint(record),
             :ok <- verified_thread(id) do
          tmux = record["terminal_tmux"] || tmux_name(id)

          case Terminal.status(runner, tmux) do
            :alive -> {:ok, %{tmux_session: tmux, created: false}}
            :unknown -> {:error, :terminal_visibility_unknown}
            :gone -> start(id, record, tmux, runner)
          end
        else
          {:ok, _} -> {:error, :not_a_terminal_worker}
          error -> error
        end
      end)

    error =
      case result do
        {:ok, _} -> nil
        {:error, reason} -> inspect(reason)
      end

    AppWorkers.update(id, %{"terminal_error" => error})
    result
  end

  defp verified_thread(id) do
    case AppWorkers.call(id, :read_thread) do
      {:ok, %{"id" => ^id, "status" => %{"type" => type}}}
      when type in ["active", "idle", "notLoaded"] ->
        :ok

      {:error, {:peer, %{"code" => -32_600, "message" => "thread not loaded: " <> ^id}}} ->
        :ok

      {:error, reason} ->
        {:error, reason}

      _ ->
        {:error, :native_thread_unverified}
    end
  end

  defp start(id, record, tmux, runner) do
    agent = %{id: record["agent_id"], wrapper: record["terminal_wrapper"]}
    cwd = record["cwd"]

    with true <-
           (is_binary(agent.wrapper) and is_binary(cwd)) || {:error, :terminal_recipe_missing},
         :ok <- Dispatcher.preflight_terminal(agent, cwd, runner),
         :ok <- resume_exact(id, 10),
         :ok <-
           Terminal.launch(runner, tmux, cwd, script(id, record, tmux),
             fiber: record["fiber_id"],
             preflighted: true
           ) do
      AppWorkers.update(id, %{"terminal_error" => nil})
      {:ok, %{tmux_session: tmux, created: true}}
    end
  end

  # Initial turn acceptance and rollout persistence are separate boundaries.
  # Confirm the exact resume before spawning the TUI; an empty or lost initial
  # turn must never turn into a viewer of a fresh conversation.
  defp resume_exact(id, retries) do
    case AppWorkers.call(id, :resume_thread, [[]]) do
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
