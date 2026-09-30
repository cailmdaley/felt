defmodule Shuttle.Felt do
  @moduledoc """
  Entry point for daemon calls to the `felt` content CLI.

  Process execution and error mapping are shared with `Shuttle.CLI`, which
  invokes either `felt` or `shuttle` through the same runner seam. This module
  keeps fiber-content call sites explicit about which binary owns their work.
  """

  @type result :: Shuttle.CLI.result()

  @doc """
  Run `felt` with `args`. See the moduledoc for the error mapping.

  `opts` forwards to the runner's `cmd/3` (`:cd`, `:env`, `:timeout_ms`, …),
  EXCEPT `:runner` — pop that out first to shell through an explicit module
  (the Poller's `state.runner` test seam) instead of the app-config default.
  """
  @spec run([String.t()], keyword()) :: result()
  def run(args, opts \\ []), do: Shuttle.CLI.run_felt(args, opts)
end
