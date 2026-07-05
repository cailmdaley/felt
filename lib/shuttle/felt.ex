defmodule Shuttle.Felt do
  @moduledoc """
  Centralized `felt` CLI shell-out for the write endpoints.

  One implementation of the drifting `System.cmd("felt", …)` error mapping the
  felt-edit / felt-nest controllers each had inline:

    * `{output, 0}` → `{:ok, output}`
    * `{output, status}` (non-zero exit) → `{:command_error, status, output}`
    * the spawn itself failing — most pointedly `felt` not on `PATH`
      (`:enoent`) — raises `ErlangError`, caught and surfaced as
      `{:error, message}`. This is the documented `:enoent` failure mode: a
      launchd daemon with a PATH missing `felt` yields `:enoent` here rather
      than a silent miss, so the caller can render it loudly.

  Always runs with `stderr_to_stdout: true` so felt's loud non-zero-exit
  diagnostics land in `output`.
  """

  @type result :: {:ok, String.t()} | {:command_error, integer(), String.t()} | {:error, String.t()}

  @doc "Run `felt` with `args`. See the moduledoc for the error mapping."
  @spec run([String.t()], keyword()) :: result()
  def run(args, opts \\ []) do
    case felt_runner().cmd("felt", args, Keyword.put(opts, :stderr_to_stdout, true)) do
      {output, 0} -> {:ok, output}
      {output, status} -> {:command_error, status, output}
    end
  rescue
    e in ErlangError -> {:error, Exception.message(e)}
  end

  # The command runner, behind the same test seam the dispatcher uses. Defaults
  # to `Shuttle.Runner.Default` — bounded by a wall-clock timeout and reaped by
  # SIGKILL on expiry (see its moduledoc), so a wedged `felt` on a loaded node
  # degrades to a timeout instead of hanging every caller (human-facing
  # pause/close/reopen/set-outcome writes among them) and leaking the process
  # forever. Its `{output, status}` contract is byte-identical to bare
  # `System.cmd/3` on the success/failure paths, including the `:enoent`
  # ErlangError-turned-127 mapping the rescue above still catches for the
  # documented PATH-missing-felt mode. Tests set `:shuttle, :felt_runner` to a
  # mock so endpoints that shell felt (e.g. `GET /api/v1/agents`) are
  # deterministic without a live felt on PATH — the failure mode where a real
  # felt on the dev box made the "degrades when felt is unavailable" test flap.
  defp felt_runner, do: Application.get_env(:shuttle, :felt_runner, Shuttle.Runner.Default)
end
