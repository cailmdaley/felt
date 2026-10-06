defmodule Shuttle.HostCapabilitiesTest do
  use ExUnit.Case, async: true

  alias Shuttle.HostCapabilities

  alias Shuttle.Test.HostCapabilityProbeRunner, as: ProbeRunner

  defp probe_responses(
         console \\ {"501\n", 0},
         current \\ {"501\n", 0},
         gui \\ {"gui/501 = {}", 0}
       ) do
    %{"/usr/bin/stat" => console, "/usr/bin/id" => current, "/bin/launchctl" => gui}
  end

  defp browser?(responses, os_type \\ {:unix, :darwin}) do
    Process.put(:capability_probe_responses, responses)
    HostCapabilities.browser_capable?(os_type: os_type, runner: ProbeRunner)
  end

  # Mutation control: bypass the cache hit or never expire the cached result.
  test "browser probes cache both answers for 60 seconds and refresh expired login state" do
    # This test's own cache slot, not the one every owner-feed request reads.
    Shuttle.Test.Env.own_scope!()
    key = Shuttle.Env.scope_key({HostCapabilities, :browser_capable})
    on_exit(fn -> :persistent_term.erase(key) end)

    assert HostCapabilities.cached_browser_capable?(fn -> true end, 100)

    assert HostCapabilities.cached_browser_capable?(
             fn -> flunk("probe ran before TTL") end,
             60_099
           )

    refute HostCapabilities.cached_browser_capable?(fn -> false end, 60_100)

    refute HostCapabilities.cached_browser_capable?(
             fn -> flunk("negative probe was not cached") end,
             60_101
           )

    assert HostCapabilities.cached_browser_capable?(fn -> true end, 120_100)
    refute HostCapabilities.cached_browser_capable?(fn -> false end, 99)
  end

  # Mutation control: make meeting_modes/2 return all modes for every OS.
  test "audio modes require hark and macOS device support" do
    for os <- [{:unix, :darwin}, {:unix, :linux}, {:unix, :freebsd}, {:win32, :nt}] do
      assert HostCapabilities.meeting_modes(false, os_type: os) == []
    end

    assert HostCapabilities.meeting_modes(true, os_type: {:unix, :darwin}) == ~w(call room phone)
    assert HostCapabilities.meeting_modes(true, os_type: {:unix, :linux}) == ~w(phone)
    assert HostCapabilities.meeting_modes(true, os_type: {:unix, :freebsd}) == ~w(phone)
  end

  test "an owned macOS console and a GUI login domain permit browser access without dialogs" do
    assert browser?(probe_responses())

    assert_receive {:capability_probe, "/usr/bin/stat", ["-f", "%u", "/dev/console"], opts}
    assert opts[:timeout_ms] == 1_000
    assert_receive {:capability_probe, "/usr/bin/id", ["-u"], opts}
    assert opts[:timeout_ms] == 1_000
    assert_receive {:capability_probe, "/bin/launchctl", ["print", "gui/501"], opts}
    assert opts[:timeout_ms] == 1_000
    refute_receive {:capability_probe, _, _, _}
  end

  # Mutation control: skip console ownership or the launchctl GUI-domain probe.
  test "headless, loginwindow and another user's console fail closed" do
    for console <- [
          {"0\n", 0},
          {"502\n", 0},
          {"-1", 0},
          {"", 0},
          {"501garbage", 0},
          {"", 1},
          {"", :timeout}
        ] do
      refute browser?(probe_responses(console))
    end

    for current <- [{"0", 0}, {"502", 0}, {"", 127}, {"", :timeout}] do
      refute browser?(probe_responses({"501", 0}, current))
    end

    for gui <- [{"domain not found", 1}, {"", 127}, {"", :timeout}] do
      refute browser?(probe_responses({"501", 0}, {"501", 0}, gui))
    end
  end

  test "non-macOS never advertises browser access or probes login state" do
    for os <- [{:unix, :linux}, {:unix, :freebsd}, {:win32, :nt}] do
      refute browser?(probe_responses(), os)
    end

    refute_receive {:capability_probe, _, _, _}
  end
end
