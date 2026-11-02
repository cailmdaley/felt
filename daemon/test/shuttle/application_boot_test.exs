defmodule Shuttle.ApplicationBootTest do
  use ExUnit.Case, async: true

  setup_all do
    build =
      Path.expand(
        "../../_build/production-boot-#{System.pid()}-#{System.unique_integer([:positive])}",
        __DIR__
      )

    on_exit(fn -> {_, 0} = System.cmd("rm", ["-rf", "--", build]) end)

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
    assert Shuttle.TailnetDial in remotes
    assert Enum.find_index(ids, &(&1 == Shuttle.TaskSupervisor)) < endpoint
    assert Enum.find_index(ids, &(&1 == ShuttleWeb.PeerGateThrottle)) < endpoint
  end

  for mode <- ["normal", "hung", "realistic"] do
    @tag :timing
    test "production child list boots #{mode} at production limits", %{build: build} do
      root = Path.join(System.tmp_dir!(), "bb-#{System.unique_integer([:positive])}")

      on_exit(fn ->
        if tmux = System.find_executable("tmux") do
          for socket <- Path.wildcard(root <> "/tmux/tmux-*/default") do
            System.cmd(tmux, ["-S", socket, "kill-server"],
              env: [{"TMUX", nil}],
              stderr_to_stdout: true
            )
          end
        end

        {_, 0} = System.cmd("rm", ["-rf", "--", root])
      end)

      paths = Path.wildcard(Path.join(build, "lib/*/ebin"))
      script = Path.expand("../support/production_boot.exs", __DIR__)

      vm_args = File.read!(Path.expand("../../rel/vm.args.eex", __DIR__))
      [_, dirty_io] = Regex.run(~r/\+SDio\s+(\d+)/, vm_args)

      args =
        ["--erl", "+S 2:2 +SDcpu 2:2 +SDio #{dirty_io}"] ++
          Enum.flat_map(paths, &["-pa", &1]) ++ [script]

      {output, status} =
        Shuttle.Runner.Default.cmd("elixir", args,
          timeout_ms: 60_000,
          stderr_to_stdout: true,
          env: [
            {"BOOT_ROOT", root},
            {"BOOT_MODE", unquote(mode)},
            {"BOOT_BUILD_DIR", build},
            {"HOME", root}
          ]
        )

      assert status == 0, output
      assert output =~ "PRODUCTION_BOOT_OK"
      if unquote(mode) == "realistic", do: assert(output =~ "REALISTIC_SLOW_STAGE_OK")
    end
  end
end
