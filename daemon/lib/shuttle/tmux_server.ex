defmodule Shuttle.TmuxServer do
  @moduledoc """
  Keeps macOS tmux workers inside kitty's privacy coalition.

  Rex hosts run workers and auxiliary services in Rex blocks. This module only
  prepares tmux when tmux is the selected worker backend. On macOS, kitty must
  root the server so its file and microphone grants reach the workers.
  """

  require Logger

  @type presence :: :present | :absent | :unknown
  @anchor "shuttle-anchor"
  @await_budget_ms 3_000
  @await_interval_ms 100

  @spec ensure_available(module()) :: :ok | {:error, {:tmux_server_unavailable, String.t()}}
  def ensure_available(runner) do
    if Shuttle.Terminal.primary() == Shuttle.Terminal.Tmux and os_type() == {:unix, :darwin} do
      ensure_darwin(runner)
    else
      :ok
    end
  end

  defp ensure_darwin(runner) do
    case presence(runner) do
      :present -> disarm_exit_empty(runner)
      :unknown -> :ok
      :absent -> start_server(runner)
    end
  end

  defp start_server(runner) do
    with :ok <- kitty_impl().run_background(anchor_command(), runner),
         :ok <- await_server(runner, @await_budget_ms) do
      disarm_exit_empty(runner)
      Logger.info("Started a tmux server via kitty (anchor session #{@anchor})")
      :ok
    else
      {:error, reason} -> refuse(reason)
      :timeout -> refuse("kitty accepted the command but no tmux server appeared")
    end
  end

  @doc """
  Whether a tmux server is running on this host.

  `:present` on exit 0; `:absent` only on a non-zero exit whose output is one of
  tmux's own absence messages; `:unknown` for every other failure, including a timeout.
  """
  @spec presence(module()) :: presence()
  def presence(runner) do
    case runner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) do
      {_output, 0} ->
        :present

      {_output, :timeout} ->
        :unknown

      {output, _status} ->
        if Shuttle.Terminal.Tmux.absence_message?(output), do: :absent, else: :unknown
    end
  end

  defp anchor_command do
    ["tmux", "new-session", "-d", "-s", @anchor, "--", "sh", "-c", "exec sleep 2147483647"]
  end

  defp await_server(runner, budget_ms) do
    do_await(runner, System.monotonic_time(:millisecond) + budget_ms)
  end

  defp do_await(runner, deadline) do
    case presence(runner) do
      :present ->
        :ok

      _ ->
        if System.monotonic_time(:millisecond) + @await_interval_ms > deadline do
          :timeout
        else
          Process.sleep(@await_interval_ms)
          do_await(runner, deadline)
        end
    end
  end

  @spec disarm_exit_empty(module()) :: :ok
  defp disarm_exit_empty(runner) do
    runner.cmd("tmux", ["set-option", "-s", "exit-empty", "off"], stderr_to_stdout: true)
    :ok
  end

  @doc "The operator-facing refusal, rendered verbatim on every failure surface."
  @spec refusal_message(String.t()) :: String.t()
  def refusal_message(error) do
    "No tmux server is running on this machine, and Shuttle could not ask kitty to start one " <>
      "(#{error}). Start a tmux server from a kitty you opened from the Dock or Finder " <>
      "(`tmux new-session -d -s #{@anchor}`), or enable kitty remote control, then dispatch again."
  end

  defp refuse(reason) do
    {:error, {:tmux_server_unavailable, refusal_message(to_string(reason))}}
  end

  defp kitty_impl, do: Shuttle.Env.app(:kitty_impl, Shuttle.Kitty)
  defp os_type, do: Shuttle.Env.app(:os_type) || :os.type()
end
