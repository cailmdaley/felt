defmodule Shuttle.RetainedTerminalTest do
  use ExUnit.Case, async: true
  alias Shuttle.{RetainedTerminal, Test.Env, Test.FakeRex}
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    FakeRex.reply("whoami", {Jason.encode!(%{"instance_id" => "one", "host_id" => "test"}), 0})
    %{opts: [state_dir: Path.join(dir, "retained")]}
  end

  test "wrapper retains exit, metadata and output across observations", %{
    tmp_dir: dir,
    opts: opts
  } do
    assert :gone = RetainedTerminal.observe("capture", FakeRex, opts)

    assert :ok =
             RetainedTerminal.start(
               "capture",
               dir,
               ["bash", "-c", "printf '%s\\n' \"$HARK_DIR\"; exit 7"],
               %{"launch" => "abc"},
               FakeRex,
               Keyword.put(opts, :env, %{"HARK_DIR" => "audio dir"})
             )

    {_, _, command_opts} =
      Enum.find(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end)

    spec = Jason.decode!(command_opts[:input])

    ["bash", "-l", script] =
      get_in(spec, ["initial_windows", Access.at(0), "layout", "block", "options", "command"])

    assert {"audio dir\n", 7} = System.cmd("bash", ["-e", script])

    assert {:ok,
            %{
              dead: true,
              exit_status: 7,
              metadata: %{"launch" => "abc"},
              screen: ["audio dir"],
              created: created,
              ended: ended
            }} = RetainedTerminal.observe("capture", FakeRex, opts)

    assert ended >= created
    assert :ok = RetainedTerminal.stop("capture", FakeRex, opts)
    assert :gone = RetainedTerminal.observe("capture", FakeRex, opts)
    refute Enum.any?(FakeRex.calls(), fn {bin, _, _} -> bin == "tmux" end)
  end

  test "server restart and missing block never adopt a running receipt", %{
    tmp_dir: dir,
    opts: opts
  } do
    assert :ok =
             RetainedTerminal.start(
               "capture",
               dir,
               ["sleep", "30"],
               %{"launch" => "abc"},
               FakeRex,
               opts
             )

    path = Path.join(opts[:state_dir], "capture.json")
    record = path |> File.read!() |> Jason.decode!()
    File.write!(Path.join(record["dir"], "receipt"), "running|123|100\n")
    assert {:ok, %{dead: false, pid: 123}} = RetainedTerminal.observe("capture", FakeRex, opts)
    FakeRex.reply("whoami", {Jason.encode!(%{"instance_id" => "two", "host_id" => "test"}), 0})

    assert {:ok, %{dead: true, pid: nil, exit_status: nil, metadata: %{"launch" => "abc"}}} =
             RetainedTerminal.observe("capture", FakeRex, opts)

    assert :ok = RetainedTerminal.stop("capture", FakeRex, opts)
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.destroy" in args end)
    assert :gone = RetainedTerminal.observe("capture", FakeRex, opts)
    FakeRex.reply("whoami", {Jason.encode!(%{"instance_id" => "one", "host_id" => "test"}), 0})
    assert :ok = RetainedTerminal.start("capture", dir, ["true"], %{}, FakeRex, opts)
    FakeRex.sessions(%{})
    assert {:ok, %{dead: true, pid: nil}} = RetainedTerminal.observe("capture", FakeRex, opts)
  end

  test "uncertain transport holds ownership and cannot authorize replacement", %{
    tmp_dir: dir,
    opts: opts
  } do
    assert :ok = RetainedTerminal.start("capture", dir, ["true"], %{}, FakeRex, opts)
    FakeRex.reply("whoami", {"unavailable", :timeout})

    assert {:error, {:unknown, "unavailable"}} =
             RetainedTerminal.observe("capture", FakeRex, opts)

    assert File.exists?(Path.join(opts[:state_dir], "capture.json"))
  end
end
