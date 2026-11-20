defmodule Shuttle.Agents do
  @moduledoc """
  Agent command rendering.

  Shuttle owns the agent registry and resolution: it parses a fiber's
  `shuttle.agent` name plus the block-declared axes (effort, chrome, headless),
  overlays the registry, and inlines the *effective* record under
  `shuttle.resolved.agent` in its JSON (`shuttle show -j` / `ls --json`). The
  registry-read verbs `shuttle agents [resolve]` cover cases with no fiber to
  read from.

  This module keeps only what Shuttle does NOT do: turning a resolved record
  into the harness's shell invocation. `from_resolved/1` adapts Shuttle's
  string-keyed JSON into the atom-keyed record the command builders consume.
  """

  require Logger

  @type agent_record :: %{
          id: String.t(),
          cli: String.t() | nil,
          wrapper: String.t() | nil,
          provider: String.t() | nil,
          model: String.t() | nil,
          extra_flags: String.t() | nil,
          developer_instructions: String.t() | nil,
          env: %{String.t() => String.t()},
          requires_model: boolean(),
          effort: String.t() | nil,
          chrome: boolean(),
          headless: boolean(),
          harness: map() | nil
        }

  @doc """
  Builds the command-rendering agent record from Shuttle's resolved.agent JSON
  (`shuttle show -j` / `shuttle ls --json`). Shuttle owns resolution (name +
  axes → effective record); the daemon owns only rendering. omitempty keys
  (absent chrome / headless / effort / requires_model) map to nil/false, which
  render_flags already treats as "axis off".
  """
  @spec from_resolved(map()) :: agent_record()
  def from_resolved(resolved) when is_map(resolved) do
    %{
      id: resolved["id"],
      cli: resolved["cli"],
      wrapper: resolved["wrapper"],
      provider: resolved["provider"],
      model: resolved["model"],
      extra_flags: resolved["extra_flags"],
      developer_instructions: resolved["developer_instructions"],
      env: resolved["env"] || %{},
      requires_model: resolved["requires_model"] == true,
      effort: resolved["effort"],
      chrome: resolved["chrome"] == true,
      headless: resolved["headless"] == true,
      harness: resolved["harness"]
    }
  end

  @doc """
  The token bash resolves when it runs this wrapper — its *command word*.

  `build_command/3` interpolates `wrapper` into the run script UNQUOTED, so a
  record may legitimately carry more than one token (`env FOO=1 claude`, a
  `nice -n10` prefix). Bash resolves only the first of them as the command;
  everything after is argument text. So the command word is the only part whose
  resolution can be meaningfully checked, and quoting the whole string as one
  token — as an earlier version of the probe did — would refuse a wrapper that
  works perfectly well.

  Returns `nil` when there is no token at all.
  """
  @spec wrapper_command_word(String.t() | nil) :: String.t() | nil
  def wrapper_command_word(wrapper) when is_binary(wrapper) do
    case String.split(wrapper, ~r/\s+/, trim: true) do
      [word | _] -> word
      [] -> nil
    end
  end

  def wrapper_command_word(_), do: nil

  @doc """
  The shell probe that answers "does this agent's wrapper resolve?".

  `build_command/3` renders the wrapper into a script the daemon runs as
  `bash -l`, so its command word may be an executable on PATH *or* a shell
  function the login profile sources. Only a login bash can tell them apart —
  and only a login bash can tell you that neither is there. `type` reports both.

  Returns the `{command, argv}` pair for `Shuttle.Runner.cmd/3`. A zero exit
  means the word resolves; stdout then names what it resolved to (`file`,
  `function`, `builtin`, `alias`). A non-zero exit means it resolves to nothing,
  which is the failure the caller must refuse to spawn against.

  Returns `:none` for a record carrying no wrapper at all — there is nothing to
  probe, and answering is the caller's job, not a reason to raise in here.
  """
  @spec wrapper_probe(agent_record() | String.t() | nil) :: {String.t(), [String.t()]} | :none
  def wrapper_probe(%{wrapper: wrapper}), do: wrapper_probe(wrapper)

  def wrapper_probe(wrapper) when is_binary(wrapper) do
    case wrapper_command_word(wrapper) do
      nil -> :none
      word -> {"bash", ["-lc", "type -t -- #{shell_escape(word)}"]}
    end
  end

  def wrapper_probe(_), do: :none

  @doc """
  The shell command that starts `agent` with `prompt` as its first turn: the
  harness module's launch command (`Shuttle.Harness`) behind the record's env
  assignments. A record whose `cli` names no harness Shuttle knows runs its
  wrapper with the prompt as an argument.

  ## Options

    * `:session_id` — the conversation id, for a harness whose identity is
      assigned at launch (Claude's `--session-id`); others ignore it.
    * `:work_dir` — the worker's working directory.
  """
  @spec build_command(agent_record(), String.t(), keyword()) :: String.t()
  def build_command(agent, prompt, opts \\ []) do
    command =
      case Shuttle.Harness.module(agent.cli) do
        nil -> "#{agent.wrapper} #{flags(agent)} #{shell_escape(prompt)}"
        harness -> harness.launch_command(agent, prompt, opts)
      end

    with_env(command, agent)
  end

  @doc """
  The shell command that reopens conversation `session_id`, with `prompt` as
  its next user turn when it is not blank. Autonomous restoration omits the
  prompt when durable turn evidence says the previous turn had already ended
  or its state is ambiguous, and launches that resume interactively so the
  terminal can wait for the human. A record whose `cli` names no harness
  Shuttle knows starts fresh with a note asking it to resume. `opts` takes
  `:work_dir`.
  """
  @spec build_resume_command(agent_record(), String.t(), String.t(), keyword()) :: String.t()
  def build_resume_command(agent, session_id, prompt \\ "", opts \\ []) do
    prompt = if is_binary(prompt) and String.trim(prompt) != "", do: prompt, else: ""

    command =
      case Shuttle.Harness.module(agent.cli) do
        nil ->
          "#{agent.wrapper} #{flags(agent)} #{shell_escape("Resume session #{session_id} if possible.")}"

        harness ->
          harness.resume_command(agent, session_id, prompt, opts)
      end

    with_env(command, agent)
  end

  # Assignment prefixes work for both executables and login-shell functions.
  # Values remain literal shell words, including quotes, newlines and expansions.
  defp with_env(command, agent) do
    assignments =
      (agent[:env] || %{})
      |> Enum.sort()
      |> Enum.flat_map(fn
        {key, value} when is_binary(key) and is_binary(value) ->
          if Regex.match?(~r/\A[A-Za-z_][A-Za-z0-9_]*\z/, key) and
               not String.contains?(value, <<0>>) do
            ["#{key}=#{shell_escape(value)}"]
          else
            Logger.warning("Skipping invalid agent env entry for key #{inspect(key)}")
            []
          end

        {key, _value} ->
          Logger.warning("Skipping invalid agent env entry for key #{inspect(key)}")
          []
      end)

    Enum.join(assignments ++ [command], " ")
  end

  @doc """
  The flags every harness takes from a record, in order: `-p` when headless,
  `--provider`, `--model`, the harness's effort and instructions flags,
  `--chrome`, then the record's `extra_flags`. A harness module passes what
  it renders itself: `:model` (the model string, when effort is folded into
  it), `:effort` and `:instructions` (whole flags), and `:headless` (print
  mode, which swaps the interactive permission mode for `bypassPermissions`,
  since nobody can approve a tool call).
  """
  @spec flags(agent_record(), keyword()) :: String.t()
  def flags(agent, opts \\ []) do
    headless = Keyword.get(opts, :headless, false)

    [
      if(headless, do: "-p", else: nil),
      flag("--provider", agent.provider),
      flag("--model", Keyword.get(opts, :model, agent.model)),
      opts[:effort],
      opts[:instructions],
      if(agent[:chrome] == true, do: "--chrome", else: nil),
      extra_flags(agent, headless)
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" ")
  end

  defp extra_flags(%{extra_flags: ef}, true) when is_binary(ef) do
    String.replace(ef, "--permission-mode auto", "--permission-mode bypassPermissions")
  end

  defp extra_flags(agent, _headless), do: agent.extra_flags

  @doc "The effort axis when the record sets one, else nil."
  def effort(agent) do
    case agent[:effort] do
      effort when is_binary(effort) and effort != "" -> effort
      _ -> nil
    end
  end

  defp flag(_key, nil), do: nil
  defp flag(key, value), do: "#{key} #{shell_escape(value)}"

  @doc "One single-quoted shell word."
  def shell_escape(str) do
    # Single-quote escaping: replace ' with '\''
    escaped = String.replace(str, "'", "'\\''")
    "'#{escaped}'"
  end
end
