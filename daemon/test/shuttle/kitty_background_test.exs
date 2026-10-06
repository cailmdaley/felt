defmodule Shuttle.KittyBackgroundTest do
  use ExUnit.Case, async: true

  alias Shuttle.Kitty

  # `launchctl print pid/<pid>` trimmed to what the parser reads: the resource
  # block names the responsible app, the jetsam block must never be mistaken
  # for it.
  defp launchctl_print(coalition) do
    """
    pid/2873 = {
    \ttype = pid
    \tresource coalition = {
    \t\tID = 1353
    \t\ttype = resource
    \t\tstate = active
    \t\tname = #{coalition}
    \t\tbundle ID = whatever
    \t}
    \tjetsam coalition = {
    \t\tID = 1354
    \t\ttype = jetsam
    \t\tname = net.kovidgoyal.kitty.jetsam
    \t}
    }
    """
  end

  @alfred "application.com.runningwithcrayons.Alfred.1904711.1905105"
  @kitty "application.net.kovidgoyal.kitty.1919153.1919664"

  # Answers `launchctl print pid/<pid>` from a pid → coalition map, records
  # every call, and on `open` runs the configured side effect (a kitty that
  # comes up and creates its socket, or nothing).
  defmodule StubRunner do
    @behaviour Shuttle.Runner
    use Agent

    def start_link(opts),
      do:
        Agent.start_link(
          fn -> %{coalitions: %{}, on_open: fn -> {"", 0} end, calls: []} |> Map.merge(opts) end,
          name: __MODULE__
        )

    def calls, do: Agent.get(__MODULE__, & &1.calls)

    @impl true
    def cmd(command, args, _opts) do
      state =
        Agent.get_and_update(__MODULE__, &{&1, %{&1 | calls: &1.calls ++ [{command, args}]}})

      case {command, args} do
        {"launchctl", ["print", "pid/" <> pid]} ->
          case Map.fetch(state.coalitions, pid) do
            {:ok, coalition} -> {Shuttle.KittyBackgroundTest.print(coalition), 0}
            :error -> {"Could not print job: 3: No such process", 113}
          end

        {"open", _} ->
          state.on_open.()

        {"/stub/kitty", _} ->
          {"", 0}
      end
    end
  end

  def print(coalition), do: launchctl_print(coalition)

  setup do
    dir = Path.join(System.tmp_dir!(), "kitty-sockets-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    Shuttle.Test.Env.put_app_env(:kitty_socket_dir, dir)
    Shuttle.Test.Env.put_app_env(:kitty_bin, "/stub/kitty")
    Shuttle.Test.Env.put_app_env(:kitty_launch_budget_ms, 300)

    on_exit(fn -> File.rm_rf(dir) end)

    %{dir: dir}
  end

  defp socket!(dir, pid, mtime) do
    path = Path.join(dir, "kitty-#{pid}")
    File.write!(path, "")
    File.touch!(path, mtime)
    path
  end

  defp launches,
    do: for({"/stub/kitty", ["@", "--to", socket | _]} <- StubRunner.calls(), do: socket)

  defp opened?, do: Enum.any?(StubRunner.calls(), &match?({"open", _}, &1))

  @argv ["tmux", "new-session", "-d", "-s", "shuttle-anchor"]

  test "forks through the self-rooted kitty, never the panel a launcher started", %{dir: dir} do
    # The 2026-10-01 state: the most recently touched socket is the Quick Access
    # panel Alfred opened. It must lose to an older socket of kitty's own.
    panel = socket!(dir, 2873, 2_000_000_000)
    kitty = socket!(dir, 4100, 1_000_000_000)
    start_supervised!({StubRunner, %{coalitions: %{"2873" => @alfred, "4100" => @kitty}}})

    assert Kitty.run_background(@argv, StubRunner) == :ok
    assert launches() == ["unix:" <> kitty]
    refute ("unix:" <> panel) in launches()
    refute opened?()

    assert {"/stub/kitty",
            ["@", "--to", "unix:" <> kitty, "launch", "--type=background", "--"] ++ @argv} in StubRunner.calls()
  end

  test "with only a launcher-rooted kitty, starts kitty through LaunchServices", %{dir: dir} do
    socket!(dir, 2873, 2_000_000_000)
    fresh = Path.join(dir, "kitty-5200")

    start_supervised!(
      {StubRunner,
       %{
         coalitions: %{"2873" => @alfred, "5200" => @kitty},
         on_open: fn ->
           File.write!(fresh, "")
           {"", 0}
         end
       }}
    )

    assert Kitty.run_background(@argv, StubRunner) == :ok
    assert {"open", ["-n", "-g", "-a", "kitty"]} in StubRunner.calls()
    assert launches() == ["unix:" <> fresh]
  end

  test "a stale socket of a dead pid is never used", %{dir: dir} do
    socket!(dir, 9999, 2_000_000_000)
    start_supervised!({StubRunner, %{}})

    assert {:error, reason} = Kitty.run_background(@argv, StubRunner)
    assert reason =~ "no control socket of a kitty rooted by kitty appeared"
    assert opened?()
    assert launches() == []
  end

  test "a failed LaunchServices start refuses with its output" do
    start_supervised!(
      {StubRunner, %{on_open: fn -> {"Unable to find application named 'kitty'", 1} end}}
    )

    assert {:error, reason} = Kitty.run_background(@argv, StubRunner)
    assert reason =~ "open -n -g -a kitty` exited 1"
    assert reason =~ "Unable to find application"
    assert launches() == []
  end

  describe "resource_coalition_name/1" do
    test "reads the resource block, not the jetsam one" do
      assert Kitty.resource_coalition_name(launchctl_print(@alfred)) == @alfred
    end

    test "empty for output with no resource coalition" do
      assert Kitty.resource_coalition_name("Could not print job: 3: No such process") == ""
      assert Kitty.resource_coalition_name("") == ""
    end
  end

  describe "kitty_rooted?/1" do
    test "only kitty's own bundle counts" do
      assert Kitty.kitty_rooted?(@kitty)
      refute Kitty.kitty_rooted?(@alfred)
      refute Kitty.kitty_rooted?("application.net.kovidgoyal.kitty-quick-access.1.2")
      refute Kitty.kitty_rooted?("com.koekeishiya.skhd")
      refute Kitty.kitty_rooted?("io.shuttle.daemon")
      refute Kitty.kitty_rooted?("")
    end
  end
end
