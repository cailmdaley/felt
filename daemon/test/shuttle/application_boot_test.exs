defmodule Shuttle.ApplicationBootTest do
  use ExUnit.Case, async: true

  setup_all do
    # One production build per checkout, compiled incrementally, so an
    # unchanged tree costs a no-op compile.
    build = Path.expand("../../_build/production-boot", __DIR__)

    {output, status} =
      Shuttle.Runner.Default.cmd("mix", ["compile", "--warnings-as-errors"],
        env: [
          {"MIX_ENV", "prod"},
          {"MIX_BUILD_PATH", build},
          {"REBAR_BASE_DIR", Path.join(build, "rebar")}
        ],
        timeout_ms: 240_000,
        stderr_to_stdout: true
      )

    assert status == 0, output
    assert File.dir?(Path.join(build, "rebar/prod")), "Rebar compiler state must be private too"
    {:ok, build: build}
  end

  test "test startup never starts transcript indexing without scoped enable" do
    refute Process.whereis(Shuttle.TranscriptIndexer)
  end

  test "endpoint precedes independent local and fleet subtrees" do
    flags = [:start_poller, :start_tailnet_dial, :start_event_stream, :start_transcript_indexer]
    Enum.each(flags, &Shuttle.Test.Env.put_app_env(&1, true))
    Shuttle.Test.Env.put_app_env(:start_voice_transcript_relay, true)
    children = Shuttle.Application.child_specs()
    ids = Enum.map(children, & &1.id)
    endpoint = Enum.find_index(ids, &(&1 == ShuttleWeb.Endpoint))
    local = Enum.find_index(ids, &(&1 == Shuttle.Local))
    fleet = Enum.find_index(ids, &(&1 == Shuttle.Fleet))
    assert endpoint < local
    assert endpoint < fleet
    assert %{start: {Shuttle.Local, :start_link, [locals]}} = Enum.at(children, local)
    assert %{start: {Shuttle.Fleet, :start_link, [remotes]}} = Enum.at(children, fleet)
    assert {Shuttle.Poller, opts} = Enum.find(locals, &match?({Shuttle.Poller, _}, &1))
    assert Keyword.fetch!(opts, :own_host_id) == Shuttle.Poller.daemon_host_id()
    assert Shuttle.EventStream in locals
    assert Shuttle.TranscriptIndexer in locals
    assert Enum.any?(children, &(&1.id == Shuttle.Voice.TranscriptRelay))
    assert Shuttle.TailnetDial in remotes
    assert Enum.find_index(ids, &(&1 == Shuttle.TaskSupervisor)) < endpoint
    assert Enum.find_index(ids, &(&1 == ShuttleWeb.PeerGateThrottle)) < endpoint
  end

  # The three modes boot side by side, each in its own VM: the hung and
  # realistic modes each hold a stage past sixteen real seconds.
  @tag :timing
  # Each VM is bounded by its own deadline below; the test outlasts them all.
  @tag timeout: 180_000
  test "production child list boots normal, hung and realistic at production limits", %{
    build: build
  } do
    paths = Path.wildcard(Path.join(build, "lib/*/ebin"))
    script = Path.expand("../support/production_boot.exs", __DIR__)
    vm_args = File.read!(Path.expand("../../rel/vm.args.eex", __DIR__))
    [_, dirty_io] = Regex.run(~r/\+SDio\s+(\d+)/, vm_args)

    args =
      ["--erl", "+S 2:2 +SDcpu 2:2 +SDio #{dirty_io}"] ++
        Enum.flat_map(paths, &["-pa", &1]) ++ [script]

    # Short: the realistic mode's tmux socket under it must fit sun_path.
    roots =
      Map.new(~w(normal hung realistic), fn mode ->
        {mode, Path.join(System.tmp_dir!(), "bb-#{System.unique_integer([:positive])}")}
      end)

    on_exit(fn -> Enum.each(Map.values(roots), &remove_boot_root/1) end)

    results =
      roots
      |> Task.async_stream(
        fn {mode, root} ->
          {mode,
           Shuttle.Runner.Default.cmd("elixir", args,
             timeout_ms: 120_000,
             stderr_to_stdout: true,
             env: [
               {"BOOT_ROOT", root},
               {"BOOT_MODE", mode},
               {"BOOT_BUILD_DIR", build},
               {"HOME", root}
             ]
           )}
        end,
        timeout: :infinity
      )
      |> Map.new(fn {:ok, result} -> result end)

    for {mode, {output, status}} <- results do
      assert status == 0, "#{mode}:\n#{output}"
      assert output =~ "PRODUCTION_BOOT_OK", "#{mode}:\n#{output}"
    end

    assert elem(results["realistic"], 0) =~ "REALISTIC_SLOW_STAGE_OK"
  end

  defp remove_boot_root(root) do
    if tmux = System.find_executable("tmux") do
      for socket <- Path.wildcard(root <> "/tmux/tmux-*/default") do
        System.cmd(tmux, ["-S", socket, "kill-server"],
          env: [{"TMUX", nil}],
          stderr_to_stdout: true
        )
      end
    end

    {_, 0} = System.cmd("rm", ["-rf", "--", root])
  end
end
