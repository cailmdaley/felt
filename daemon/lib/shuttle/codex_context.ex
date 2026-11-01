defmodule Shuttle.CodexContext do
  @moduledoc """
  Builds managed Codex developer instructions without invoking a harness wrapper
  or registering a session. `felt session` is the read-only plaintext producer
  underlying `felt hook session`'s JSON envelope.
  """

  @identity_vars ~w(CODEX_THREAD_ID CODEX_SESSION_ID TMUX TMUX_PANE SHUTTLE_FIBER_PATH SHUTTLE_SESSION_ID)

  def prepare(agent, cwd, opts, mode) do
    explicit = join([agent[:developer_instructions], opts[:developer_instructions]])

    # Agent context is already part of a managed thread. Only an explicit
    # dispatch override replaces it on resume; otherwise retain native context,
    # including instructions from the dispatch that created the conversation.
    if mode == :resume and opts[:developer_instructions] in [nil, ""] do
      {:ok, Keyword.put(opts, :developer_instructions, nil)}
    else
      runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)

      with {:ok, wake} <- wake(),
           {:ok, felt} <- felt_context(runner, cwd) do
        {:ok, Keyword.put(opts, :developer_instructions, join([wake, felt, explicit]))}
      end
    end
  end

  defp join(parts) do
    case Enum.reject(parts, &(is_nil(&1) or &1 == "")) do
      [] -> nil
      parts -> Enum.join(parts, "\n\n")
    end
  end

  defp wake do
    path = Path.join([Shuttle.Env.home(), ".codex", "WAKE.md"])

    case File.read(path) do
      {:ok, text} -> {:ok, text}
      {:error, :enoent} -> {:ok, nil}
      {:error, reason} -> {:error, {:codex_context_unavailable, {:wake, reason}}}
    end
  end

  defp felt_context(runner, cwd) do
    case runner.cmd("felt", ["session"],
           cd: cwd,
           env: Enum.map(@identity_vars, &{&1, nil}),
           timeout_ms: 15_000,
           stderr_to_stdout: false
         ) do
      {text, 0} -> {:ok, String.trim_trailing(text)}
      {_output, status} -> {:error, {:codex_context_unavailable, {:felt_session, status}}}
    end
  end
end
