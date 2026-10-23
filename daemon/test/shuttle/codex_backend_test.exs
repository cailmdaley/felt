defmodule Shuttle.CodexBackendTest do
  use ExUnit.Case, async: true
  alias Shuttle.{CodexBackend, Test.Env}

  defmodule Runner do
    def cmd(command, args, _opts) do
      Agent.get_and_update(Env.server!(__MODULE__), fn s ->
        reply =
          case {command, args} do
            {"ps", _} -> s.scan
            {"tmux", ["has-session" | _]} -> s.session
            {"tmux", ["display-message" | _]} -> s.pane
            {"tmux", ["ls" | _]} -> {"anchor\n", 0}
            {"tmux", ["new-session" | _]} -> s.launch
            {"tmux", ["respawn-pane" | _]} -> s.launch
            _ -> {"", 0}
          end

        {reply, %{s | calls: s.calls ++ [{command, args}]}}
      end)
    end
  end

  setup do
    Env.put_app_env(:os_type, {:unix, :linux})
    root = "/tmp/shuttle-backend-test-#{System.unique_integer([:positive])}"
    on_exit(fn -> File.rm_rf!(root) end)

    runner =
      start_supervised!(
        {Agent,
         fn ->
           %{
             calls: [],
             scan: {"", 0},
             session: {"can't find session", 1},
             pane: {"0\n", 0},
             launch: {"", 0}
           }
         end}
      )

    Env.put_server(Runner, runner)
    path = Path.join(root, "control.sock")

    %{
      runner: runner,
      path: path,
      opts: [endpoint: {:ok, path}, runner: Runner, probe: fn _ -> {:error, :absent} end]
    }
  end

  defp change(pid, fields), do: Agent.update(pid, &Map.merge(&1, Map.new(fields)))
  defp calls(pid), do: Agent.get(pid, & &1.calls)

  defp starts(pid),
    do: Enum.filter(calls(pid), fn {_, args} -> hd(args) in ["new-session", "respawn-pane"] end)

  test "healthy existing backend is adopted without touching tmux or process state", %{
    opts: opts,
    runner: runner
  } do
    assert %{state: :ready, error: nil} =
             CodexBackend.check(Keyword.put(opts, :probe, fn _ -> :ok end))

    assert [] = calls(runner)
  end

  test "absent backend starts once with endpoint-specific tmux identity", %{
    opts: opts,
    path: path,
    runner: runner
  } do
    assert %{state: :starting, endpoint: ^path} = CodexBackend.check(opts)
    assert [{"tmux", ["new-session", "-d", "-s", session | _]}] = starts(runner)
    assert session == CodexBackend.session(path)
    change(runner, session: {"", 0})
    assert %{state: :waiting} = CodexBackend.check(opts)
    assert [_] = starts(runner)

    refute Enum.any?(calls(runner), fn {_, args} ->
             hd(args) in ["kill-session", "kill-server"]
           end)
  end

  test "missing socket with a live holder, scan failure, uncertain tmux or another manager holds",
       %{opts: opts, runner: runner, path: path} do
    for fields <- [
          [scan: {"123 1 codex app-server --listen unix://#{path}\n", 0}],
          [scan: {"scan failed", 1}],
          [scan: {"", 0}, session: {"permission denied", 1}],
          [session: {"", 0}]
        ] do
      change(runner, fields)
      assert %{state: :waiting} = CodexBackend.check(opts)
      assert [] = starts(runner)
    end
  end

  test "dead pane can be revived but never with tmux's live-replacement flag", %{
    opts: opts,
    runner: runner,
    path: path
  } do
    change(runner, session: {"", 0}, pane: {"1|#{path}\n", 0})
    assert %{state: :starting} = CodexBackend.check(opts)
    assert [{"tmux", ["respawn-pane" | args]}] = starts(runner)
    refute "-k" in args
  end

  test "Linux tmux server retaining the launch argv is not a live Codex holder", %{
    opts: opts,
    runner: runner,
    path: path
  } do
    script = Path.join(Path.dirname(path), "shuttle-run-#{CodexBackend.session(path)}.123.sh")

    change(runner,
      scan: {"555 1 tmux new-session -d -s #{CodexBackend.session(path)} bash -l #{script}\n", 0},
      session: {"", 0},
      pane: {"1|#{path}\n", 0}
    )

    assert %{state: :starting} = CodexBackend.check(opts)
    assert [{"tmux", ["respawn-pane" | _]}] = starts(runner)
  end

  test "a remote TUI is a client, not a holder preventing dead-server recovery", %{
    opts: opts,
    runner: runner,
    path: path
  } do
    change(runner,
      scan: {"555 1 codex --remote unix://#{path} resume thread-1\n", 0},
      session: {"", 0},
      pane: {"1|#{path}\n", 0}
    )

    assert %{state: :starting} = CodexBackend.check(opts)
    assert [{"tmux", ["respawn-pane" | _]}] = starts(runner)
  end

  test "existing unresponsive socket is held without unlinking or starting", %{
    opts: opts,
    path: path,
    runner: runner
  } do
    :ok = Shuttle.CodexEndpoint.ensure_root(path)
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ifaddr: {:local, path}])
    File.chmod!(path, 0o600)
    on_exit(fn -> :gen_tcp.close(listener) end)
    assert %{state: :waiting, error: message} = CodexBackend.check(opts)
    assert message =~ "socket exists"
    assert File.exists?(path)
    assert [] = starts(runner)
  end

  # Negative control: dropping the dangling-alias clause leaves this waiting,
  # and a probe failure other than enoent never takes it.
  test "a genuine alias left dangling by a cleared /tmp starts a fresh server", %{
    opts: opts,
    path: path,
    runner: runner
  } do
    :ok = Shuttle.CodexEndpoint.ensure_root(path)
    uid = Shuttle.Host.euid()
    tmp = if match?({:ok, _}, File.read_link("/tmp")), do: "/private/tmp", else: "/tmp"
    literal = tmp <> String.trim_leading(path, "/tmp")
    hash = :crypto.hash(:sha256, literal) |> Base.encode16(case: :lower)
    protected = Path.join(tmp, "codex-daemon-#{uid}")

    if File.exists?(Path.join(protected, hash)) == false do
      File.ln_s!(Path.join(protected, hash), path)

      refused = Keyword.put(opts, :probe, fn _ -> {:error, {:transport, :econnrefused}} end)
      assert %{state: :waiting} = CodexBackend.check(refused)
      assert [] = starts(runner)

      gone = Keyword.put(opts, :probe, fn _ -> {:error, {:transport, :enoent}} end)
      assert %{state: :starting} = CodexBackend.check(gone)
      assert [{"tmux", ["new-session" | _]}] = starts(runner)
    end
  end

  test "hostile precreated root never reaches even the probe", %{
    opts: opts,
    path: path,
    runner: runner
  } do
    File.mkdir!(Path.dirname(path))
    File.chmod!(Path.dirname(path), 0o777)
    opts = Keyword.put(opts, :probe, fn _ -> flunk("unsafe root reached probe") end)
    assert %{state: :waiting, error: error} = CodexBackend.check(opts)
    assert error =~ "unsafe Codex endpoint root"
    assert [] = calls(runner)
  end

  test "async reconciliation stays responsive, launch failures back off, readiness bypasses backoff",
       %{opts: opts, runner: runner} do
    change(runner, launch: {"failed to launch", 1})
    parent = self()
    observer = start_supervised!({Agent, fn -> :absent end}, id: :observer)

    opts =
      Keyword.merge(opts,
        name: nil,
        interval_ms: :infinity,
        probe: fn _ ->
          send(parent, :probed)
          if Agent.get(observer, & &1) == :ready, do: :ok, else: {:error, :absent}
        end
      )

    manager = Env.start_scoped!({CodexBackend, opts})
    assert_receive :probed
    health = await_check(manager)
    assert %{state: :waiting, next_attempt_at: %DateTime{}} = health
    assert [_] = starts(runner)
    CodexBackend.reconcile(manager)
    assert_receive :probed
    assert %{state: :waiting} = await_check(manager)
    assert [_] = starts(runner)
    Agent.update(observer, fn _ -> :ready end)
    CodexBackend.reconcile(manager)
    assert_receive :probed
    assert %{state: :ready, next_attempt_at: nil} = await_check(manager)
    assert [_] = starts(runner)
  end

  defp await_check(manager) do
    state = :sys.get_state(manager)

    case state.task do
      nil ->
        CodexBackend.status(manager)

      %{pid: pid} ->
        ref = Process.monitor(pid)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          10_000 -> flunk("check did not finish")
        end

        await_check(manager)
    end
  end

  test "dependency gate is retryable and cached; no wait or implicit request queue" do
    defmodule Waiting do
      def status, do: %{state: :starting, endpoint: "/tmp/isolated.sock", error: "initializing"}
    end

    Env.put_app_env(:codex_backend, Waiting)
    assert {:error, {:backend_not_ready, message}} = CodexBackend.require_ready()
    assert message =~ "initializing"

    assert {503,
            %{dispatched: false, waiting: true, retryable: true, reason: "backend_not_ready"}} =
             ShuttleWeb.DispatchReply.render("task", {:error, {:backend_not_ready, message}})

    Env.put_app_env(:codex_backend, Shuttle.Test.ReadyCodexBackend)
    assert :ok = CodexBackend.require_ready()
  end

  test "backend launch scrubs worker identities but keeps persistent configuration", %{path: path} do
    Env.put_env("CODEX_HOME", "/network/persistent-codex")
    script = CodexBackend.script(path)
    assert script =~ "CODEX_THREAD_ID"
    assert script =~ "SHUTTLE_FIBER*"
    assert script =~ "TMUX|TMUX_PANE"
    assert script =~ "command codex app-server --listen 'unix://#{path}'"
    assert script =~ "CODEX_HOME='/network/persistent-codex'"
    refute script =~ "daemon start"
  end
end
