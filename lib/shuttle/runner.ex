defmodule Shuttle.Runner do
  @moduledoc """
  Behavior for shell command execution.

  Default implementation shells out via System.cmd.
  Tests inject a mock module to capture commands without running them.
  """

  @callback cmd(String.t(), [String.t()], keyword()) :: {String.t(), non_neg_integer()}

  defmodule Default do
    @behaviour Shuttle.Runner

    def cmd(command, args, opts) do
      opts = maybe_clear_inherited_tmux(command, opts)

      System.cmd(command, args, opts)
    rescue
      e in ErlangError ->
        case e.original do
          :enoent -> {"#{command}: command not found", 127}
          _ -> reraise e, __STACKTRACE__
        end
    end

    defp maybe_clear_inherited_tmux("tmux", opts) do
      Keyword.update(opts, :env, [{"TMUX", ""}], fn env ->
        [{"TMUX", ""} | Enum.reject(env, fn {key, _} -> key == "TMUX" end)]
      end)
    end

    defp maybe_clear_inherited_tmux(_command, opts), do: opts
  end
end
