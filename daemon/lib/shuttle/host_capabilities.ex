defmodule Shuttle.HostCapabilities do
  @moduledoc """
  Host-local capabilities for Capture, published by the owning daemon.

  Hark has no capability-reporting CLI protocol. Its device capture is supported
  on macOS; other hosts use phone audio rather than promising microphone or
  system-audio support from the presence of CLI flags.

  Browser access requires this daemon's user to own the macOS console and have
  a GUI login domain. The probes never open an application or a permission
  dialog, and missing commands, failed probes and timeouts fail closed.
  Production browser probes are cached for 60 seconds so polling owner feeds
  does not repeatedly spawn subprocesses. Injected probes run uncached.
  """

  @probe_timeout_ms 1_000
  @browser_cache_key {__MODULE__, :browser_capable}
  @browser_cache_ttl_ms 60_000

  @spec meeting_modes(boolean(), keyword()) :: [String.t()]
  def meeting_modes(hark_available?, opts \\ [])
  def meeting_modes(false, _opts), do: []

  def meeting_modes(true, opts) do
    if os_type(opts) == {:unix, :darwin}, do: ~w(call room phone), else: ~w(phone)
  end

  @spec browser_capable?(keyword()) :: boolean()
  def browser_capable?(opts \\ []) do
    probe = fn -> os_type(opts) == {:unix, :darwin} and gui_session?(opts) end

    if opts != [] or Shuttle.Env.app(:host_capabilities_os_type) != nil or
         Shuttle.Env.app(:host_capabilities_runner) != nil do
      probe.()
    else
      cached_browser_capable?(probe, System.monotonic_time(:millisecond))
    end
  end

  @doc false
  def cached_browser_capable?(probe, now_ms) do
    case :persistent_term.get(Shuttle.Env.scope_key(@browser_cache_key), nil) do
      {checked_at, capable}
      when now_ms >= checked_at and now_ms - checked_at < @browser_cache_ttl_ms ->
        capable

      _ ->
        capable = probe.()
        :persistent_term.put(Shuttle.Env.scope_key(@browser_cache_key), {now_ms, capable})
        capable
    end
  end

  defp gui_session?(opts) do
    with {console, 0} <- run(opts, "/usr/bin/stat", ["-f", "%u", "/dev/console"]),
         {uid, ""} when uid > 0 <- Integer.parse(String.trim(console)),
         {current, 0} <- run(opts, "/usr/bin/id", ["-u"]),
         {^uid, ""} <- Integer.parse(String.trim(current)),
         {_session, 0} <- run(opts, "/bin/launchctl", ["print", "gui/#{uid}"]) do
      true
    else
      _ -> false
    end
  end

  defp os_type(opts) do
    Keyword.get(
      opts,
      :os_type,
      Shuttle.Env.app(:host_capabilities_os_type, :os.type())
    )
  end

  defp run(opts, command, args) do
    runner =
      Keyword.get(
        opts,
        :runner,
        Shuttle.Env.app(:host_capabilities_runner, Shuttle.Runner.Default)
      )

    runner.cmd(command, args, stderr_to_stdout: true, timeout_ms: @probe_timeout_ms)
  end
end
