defmodule Shuttle.Agents do
  @moduledoc """
  Agent command rendering.

  Felt owns the agent registry and resolution: it parses a fiber's
  `shuttle.agent` name plus the block-declared axes (effort, chrome, headless),
  overlays the registry, and inlines the *effective* record under
  `shuttle.resolved.agent` in its JSON (`felt show -j` / `ls --json`). The two
  registry-read verbs `felt shuttle agents [resolve]` cover the cases with no
  fiber to read from.

  This module keeps only what felt does NOT do: turning a resolved record into
  the harness's shell invocation. `from_resolved/1` adapts felt's string-keyed
  JSON into the atom-keyed record the command builders consume.
  """

  @type agent_record :: %{
          id: String.t(),
          cli: String.t() | nil,
          wrapper: String.t() | nil,
          provider: String.t() | nil,
          model: String.t() | nil,
          extra_flags: String.t() | nil,
          requires_model: boolean(),
          effort: String.t() | nil,
          chrome: boolean(),
          headless: boolean()
        }

  @doc """
  Builds the command-rendering agent record from felt's resolved.agent JSON
  (felt show -j / ls --json). felt owns resolution (name + axes → effective
  record); the daemon owns only rendering. omitempty keys (absent chrome /
  headless / effort / requires_model) map to nil/false, which render_flags
  already treats as "axis off".
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
      requires_model: resolved["requires_model"] == true,
      effort: resolved["effort"],
      chrome: resolved["chrome"] == true,
      headless: resolved["headless"] == true
    }
  end

  @doc """
  Builds the shell command string for invoking an agent with the dispatch prompt.

  ## Options

    * `:session_id` — for Claude agents only: pre-specifies the session UUID via
      `--session-id <uuid>`. Ignored for other harnesses. Allows the Shuttle
      daemon to know the session UUID before the worker runs, so it can stamp it
      into the fiber's `shuttle:` block at dispatch (`shuttle.session_uuid`, the
      durable resume handle read by `Shuttle.Continuation`) rather than via
      post-hoc capture.
  """
  @spec build_command(agent_record(), String.t(), keyword()) :: String.t()
  def build_command(agent, prompt, opts \\ []) do
    session_id = Keyword.get(opts, :session_id)
    flags = render_flags(agent)

    # The wrapper is a shell function sourced via bash -l.
    # For claude: stdin via here-string; --session-id can be pre-specified.
    # For codex/pi: positional arg.
    case agent.cli do
      "claude" ->
        session_flag =
          if session_id, do: "--session-id #{shell_escape(session_id)} ", else: ""

        "#{agent.wrapper} #{session_flag}#{flags} <<< #{shell_escape(prompt)}"

      "codex" ->
        "#{agent.wrapper} #{flags} #{shell_escape(prompt)}"

      "pi" ->
        "#{agent.wrapper} #{flags} #{shell_escape(prompt)}"

      _ ->
        "#{agent.wrapper} #{flags} #{shell_escape(prompt)}"
    end
  end

  @doc """
  Builds the shell command string for resuming a previous worker session.

  Each harness has a distinct resume invocation:
  - claude: `claude --resume <uuid>` (pre-specified UUID, deterministic)
  - codex:  `codex resume <uuid>` (UUID captured post-hoc after initial dispatch)
  - pi:     `pi --session <uuid>` (partial UUID also accepted)

  When `prompt` is non-empty (whitespace-trimmed), it is injected as the
  next user turn in the resumed session — mirroring the fresh-dispatch
  pattern (claude reads it via `<<<` here-string; codex takes it as a
  positional arg). Without it, resume would land the worker in a session
  with no signal that it was deliberately woken, and the user's directive
  (the transient `user_message` dispatch parameter) would never reach it.

  Pi has no inline-prompt arg on `pi --session`, so the directive is
  dropped on pi resume today — and since `user_message` is transient (not
  persisted), it is simply lost on that path (a known, accepted gap for pi).

  Extra flags (provider, model, extra_flags) are threaded through so the
  harness wrapper runs with the same configuration as the original session.
  """
  @spec build_resume_command(agent_record(), String.t(), String.t()) :: String.t()
  def build_resume_command(agent, session_id, prompt \\ "") do
    flags = render_flags(agent)

    has_prompt = is_binary(prompt) and String.trim(prompt) != ""

    case agent.cli do
      "claude" ->
        # Claude resumes from on-disk transcript. With a prompt, feed it
        # via stdin (here-string) so it lands as the next user turn —
        # mirrors fresh dispatch's `<<<` pattern.
        base = "#{agent.wrapper} #{flags} --resume #{shell_escape(session_id)}"
        if has_prompt, do: "#{base} <<< #{shell_escape(prompt)}", else: base

      "codex" ->
        # codex resume <uuid> [prompt] — resume subcommand, UUID positional,
        # optional prompt as trailing positional.
        base = "#{agent.wrapper} #{flags} resume #{shell_escape(session_id)}"
        if has_prompt, do: "#{base} #{shell_escape(prompt)}", else: base

      "pi" ->
        # pi --session <path|partial-uuid> — accepts UUID prefix. No inline
        # prompt arg today, so the directive is dropped on pi resume.
        "#{agent.wrapper} #{flags} --session #{shell_escape(session_id)}"

      _ ->
        # Unknown harness: fall back to fresh dispatch with a note.
        "#{agent.wrapper} #{flags} #{shell_escape("Resume session #{session_id} if possible.")}"
    end
  end

  # Renders the harness invocation flags, folding the resolved axes (effort,
  # chrome, headless) into each CLI's native form:
  #   claude → `--effort <level>` flag + `--chrome`; headless adds `-p` and
  #            swaps the interactive permission mode for `bypassPermissions`
  #   pi     → `:level` suffix on the model string (preserves today's behaviour)
  #   codex  → `-c model_reasoning_effort="<level>"`
  # Effort/chrome/headless come from felt's resolved record via from_resolved/1
  # (the `:effort`/`:chrome`/`:headless` keys); absent (nil/false) means no axis
  # rendering.
  defp render_flags(agent) do
    effort = agent[:effort]
    chrome = agent[:chrome] == true
    headless = agent[:headless] == true and agent.cli == "claude"
    model = effective_model(agent, effort)

    [
      if(headless, do: "-p", else: nil),
      flag("--provider", agent.provider),
      flag("--model", model),
      effort_flag(agent.cli, effort),
      if(chrome, do: "--chrome", else: nil),
      headless_extra_flags(agent, headless)
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" ")
  end

  # A headless `-p` worker runs unattended: no human can approve a tool call, so
  # the interactive `--permission-mode auto` is swapped for `bypassPermissions`
  # (claude's "never stall" mode, the parallel to codex's
  # `--dangerously-bypass-approvals-and-sandbox`). Non-headless invocations keep
  # their declared `extra_flags` verbatim.
  defp headless_extra_flags(%{extra_flags: ef}, true) when is_binary(ef) do
    String.replace(ef, "--permission-mode auto", "--permission-mode bypassPermissions")
  end

  defp headless_extra_flags(agent, _headless), do: agent.extra_flags

  # pi renders effort as a `:level` suffix on the model string; other harnesses
  # keep the bare model.
  defp effective_model(%{cli: "pi", model: model}, effort)
       when is_binary(model) and is_binary(effort) and effort != "" do
    "#{model}:#{effort}"
  end

  defp effective_model(agent, _effort), do: agent.model

  defp effort_flag("claude", effort) when is_binary(effort) and effort != "",
    do: "--effort #{shell_escape(effort)}"

  defp effort_flag("codex", effort) when is_binary(effort) and effort != "",
    do: "-c model_reasoning_effort=#{shell_escape(effort)}"

  defp effort_flag(_cli, _effort), do: nil

  defp flag(_key, nil), do: nil
  defp flag(key, value), do: "#{key} #{shell_escape(value)}"

  defp shell_escape(str) do
    # Single-quote escaping: replace ' with '\''
    escaped = String.replace(str, "'", "'\\''")
    "'#{escaped}'"
  end
end
