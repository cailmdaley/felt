defmodule Shuttle.CLI do
  @moduledoc """
  Shell boundary for the `felt` and `shuttle` executables.

  `run/2` invokes `shuttle`; `run_felt/2` is the content CLI entry point used
  by `Shuttle.Felt`. `run_in_store/3` scopes Shuttle commands with `-C`, and
  `run_lifecycle/4` builds on it for fiber lifecycle writes. Both executables
  share the configured runner, timeout, stderr mapping, and
  `{:ok, output} | {:command_error, status, output} | {:error, message}` result
  contract. The default runner names the executable in its PATH-missing error,
  so each caller reports the binary it actually needs.
  """

  @type result ::
          {:ok, String.t()}
          | {:command_error, non_neg_integer() | :timeout, String.t()}
          | {:error, String.t()}

  @local_verbs ~w(pause resume close reopen accept set-outcome set-model set-agent reshape uninstall)

  @doc "Run the `shuttle` executable with raw argv."
  @spec run([String.t()], keyword()) :: result()
  def run(args, opts \\ []) do
    run_executable("shuttle", args, opts)
  end

  @doc false
  @spec run_felt([String.t()], keyword()) :: result()
  def run_felt(args, opts \\ []) do
    run_executable("felt", args, opts)
  end

  @doc "Run a Shuttle command with an optional felt store root."
  @spec run_in_store(String.t() | nil, [String.t()], keyword()) :: result()
  def run_in_store(felt_store, args, opts \\ []) do
    run(store_flag(felt_store) ++ args, opts)
  end

  @doc "Run a fiber-scoped Shuttle verb, adding the store and local-owner flags."
  @spec run_lifecycle(String.t(), String.t(), [String.t()], keyword()) :: result()
  def run_lifecycle(verb, fiber_id, args \\ [], opts \\ []) do
    {felt_store, opts} = Keyword.pop(opts, :felt_store)

    run_in_store(felt_store, [verb, fiber_id] ++ args ++ local_flag(verb), opts)
  end

  defp run_executable(executable, args, opts) do
    {runner, opts} = Keyword.pop(opts, :runner, configured_runner())

    case runner.cmd(executable, args, Keyword.put_new(opts, :stderr_to_stdout, true)) do
      {output, 0} -> {:ok, output}
      {output, status} -> {:command_error, status, output}
    end
  rescue
    e in ErlangError -> {:error, Exception.message(e)}
  end

  # The single test seam covers both executable names; the runner receives the
  # actual binary name so stubs can preserve the process boundary.
  defp configured_runner, do: Application.get_env(:shuttle, :felt_runner, Shuttle.Runner.Default)

  defp local_flag(verb) when verb in @local_verbs, do: ["--local"]
  defp local_flag(_verb), do: []

  defp store_flag(store) when is_binary(store) and store != "", do: ["-C", store]
  defp store_flag(_), do: []
end
