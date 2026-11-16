defmodule Shuttle.ThreadCaptureTest do
  # What capture costs a poll, and what its failures cost the Poller.
  use Shuttle.Test.ThreadsCase, async: true

  defmodule CountingRunner do
    def cmd("shuttle", args, opts) do
      send(Shuttle.Env.app(:capture_test_pid), {:shuttle, args})
      send(Shuttle.Env.app(:capture_test_pid), {:shuttle_input, opts[:input]})
      Shuttle.Runner.Default.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule FullInboxRunner do
    def cmd("shuttle", ["inbox", "thread-put" | _], _opts) do
      send(Shuttle.Env.app(:capture_test_pid), :refused)
      {"mailbox is full", 1}
    end

    def cmd(command, args, opts), do: SocketRunner.cmd(command, args, opts)
  end

  defp closed_family(store, n, closed_at) do
    hub = %{
      felt_store: store,
      fiber: %{
        "id" => "load",
        "uid" => "u-load",
        "status" => "active",
        "shuttle" => %{"host" => "test-host"}
      }
    }

    children =
      for i <- 1..n do
        %{
          felt_store: store,
          fiber: %{
            "id" => "load/c#{i}",
            "uid" => "u-c#{i}",
            "status" => "closed",
            "closed_at" => closed_at,
            "outcome" => "Done #{i}.",
            "shuttle" => %{"host" => "test-host"}
          }
        }
      end

    [hub | children]
  end

  defp flush_inputs do
    receive do
      {:shuttle_input, _} -> flush_inputs()
    after
      0 -> :ok
    end
  end

  defp shuttle_calls(acc \\ []) do
    receive do
      {:shuttle, args} -> shuttle_calls([args | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  test "capturing 200 closed constitutions costs at most one CLI call per poll", %{store: store} do
    Env.put_app_env(:capture_test_pid, self())
    Env.put_app_env(:felt_runner, CountingRunner)
    recent = DateTime.to_iso8601(DateTime.utc_now())
    entries = closed_family(store, 200, recent)

    timings =
      for _poll <- 1..3 do
        {micros, :ok} = :timer.tc(fn -> Threads.capture_results(entries, "test-host") end)
        assert [["inbox", "thread-put"]] = shuttle_calls()
        micros
      end

    assert length(Shuttle.Test.InboxPublications.pending()) == 200

    IO.puts(
      "capture of 200 recent closes, first and repeat polls (ms): #{inspect(Enum.map(timings, &div(&1, 1000)))}"
    )

    # Signals older than the retention window are skipped before the shell:
    # the poll's one call captures nothing and appends any owed board lines.
    old = DateTime.utc_now() |> DateTime.add(-15 * 24 * 3600) |> DateTime.to_iso8601()
    flush_inputs()

    {micros, :ok} =
      :timer.tc(fn -> Threads.capture_results(closed_family(store, 200, old), "test-host") end)

    assert shuttle_calls() == [["inbox", "thread-put"]]
    assert_received {:shuttle_input, "[]"}
    IO.puts("capture of 200 closes outside retention (ms): #{div(micros, 1000)}")
  end

  test "a poll's delivery and waiting count list the routing inbox once", %{store: store} do
    [hub | _] = closed_family(store, 1, nil)

    # Results whose currency cannot be read wait in the routing inbox.
    Shuttle.Test.InboxPublications.capture(
      for i <- 1..2 do
        {"thread-unread-#{i}",
         %{"owner" => "test-host", "store" => store, "parent_uid" => "u-load", "text" => "t"}}
      end
    )

    Env.put_app_env(:capture_test_pid, self())
    Env.put_app_env(:felt_runner, CountingRunner)
    routing = Threads.deliver_results([hub], "test-host")

    assert [%{"parent_uid" => "u-load"}, %{"parent_uid" => "u-load"}] = routing
    assert Threads.pending_results([hub], "test-host", routing) == {%{"u-load" => 2}, %{}}
    assert Enum.count(shuttle_calls(), &(&1 == ["inbox", "routes"])) == 1
  end

  test "a close whose outcome is over 64 KiB is captured cut short, with the others",
       %{store: store} do
    recent = DateTime.to_iso8601(DateTime.utc_now())
    [hub, huge | rest] = closed_family(store, 3, recent)
    huge = put_in(huge, [:fiber, "outcome"], String.duplicate("é", 40 * 1024))

    for _poll <- 1..2 do
      assert :ok = Threads.capture_results([hub, huge | rest], "test-host")
    end

    pending = Shuttle.Test.InboxPublications.pending()
    assert length(pending) == 3
    assert [cut] = Enum.filter(pending, fn {_id, r} -> byte_size(r["text"]) > 1000 end)
    {_id, %{"text" => text}} = cut
    assert String.valid?(text)
    assert byte_size(text) <= 60_100
    assert String.ends_with?(text, "(truncated)")
  end

  test "a refused capture is logged and retried by the next poll, never crashing the Poller",
       %{store: store, data: data} do
    import Shuttle.Test.PollerHelpers
    bin = Path.join(store, "isolated-bin")
    File.mkdir_p!(bin)
    tmux = Shuttle.Env.find_executable("tmux")
    socket = Path.join(System.tmp_dir!(), "capture-#{System.unique_integer([:positive])}.sock")

    File.write!(
      Path.join(bin, "tmux"),
      "#!/bin/sh\nexec '#{tmux}' -S '#{socket}' -f /dev/null \"$@\"\n"
    )

    File.chmod!(Path.join(bin, "tmux"), 0o700)
    Env.prepend_path(bin)
    Env.put_app_env(:capture_test_pid, self())
    Env.put_app_env(:felt_runner, FullInboxRunner)
    assert {:ok, _} = CLI.run_in_store(store, ["close", "hub/child", "--local"])

    {:ok, poller} =
      start_poller!(
        runner: FullInboxRunner,
        own_host_id: "test-host",
        felt_stores: [store],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    ExUnit.CaptureLog.capture_log(fn ->
      await_boot_cycle!(poller)
      assert_receive :refused, 20_000

      for _poll <- 1..2 do
        send(poller, :run_poll_cycle)
        assert_receive :refused, 20_000
      end
    end)

    assert Process.alive?(poller)
    assert Shuttle.Test.InboxPublications.pending() == []

    Env.put_app_env(:felt_runner, SocketRunner)
    send(poller, :run_poll_cycle)

    await(fn ->
      Enum.any?(pending(data), &(&1["request"]["text"] =~ "thread hub/child closed"))
    end)
  end

  @tag first_boot: true
  test "a baseline that fails without corruption is retried, not held", %{data: data} do
    state = Path.join(data, "mailboxes/threads.json")
    File.mkdir_p!(Path.dirname(state))
    File.write!(state, ~s({"baseline":"2026-10-22T19:33:11.470348Z"}))
    File.chmod!(state, 0o000)
    on_exit(fn -> File.chmod(state, 0o600) end)
    error = assert_raise RuntimeError, fn -> Shuttle.Inbox.boot_baseline() end
    assert error.message =~ "thread capture baseline failed"
    File.chmod!(state, 0o600)
    assert :ok = Shuttle.Inbox.boot_baseline()
    assert Shuttle.Test.InboxPublications.baseline() == "2026-10-22T19:33:11.470348Z"

    File.write!(state, ~s({"baseline":"not a time"}))
    assert_raise Shuttle.Inbox.Corrupt, fn -> Shuttle.Inbox.boot_baseline() end
  end
end
