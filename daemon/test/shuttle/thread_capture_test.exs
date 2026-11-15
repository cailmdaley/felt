defmodule Shuttle.ThreadCaptureTest do
  # What capture costs a poll, and what its failures cost the Poller.
  use Shuttle.Test.ThreadsCase, async: true

  defmodule CountingRunner do
    def cmd("shuttle", args, opts) do
      send(Shuttle.Env.app(:capture_test_pid), {:shuttle, args})
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

    # Signals older than the retention window are skipped before any shell.
    old = DateTime.utc_now() |> DateTime.add(-15 * 24 * 3600) |> DateTime.to_iso8601()

    {micros, :ok} =
      :timer.tc(fn -> Threads.capture_results(closed_family(store, 200, old), "test-host") end)

    assert shuttle_calls() == []
    IO.puts("capture of 200 closes outside retention (ms): #{div(micros, 1000)}")
  end

  test "a close whose outcome is over 64 KiB is refused and logged, and the others are captured",
       %{store: store} do
    recent = DateTime.to_iso8601(DateTime.utc_now())
    [hub, huge | rest] = closed_family(store, 3, recent)
    huge = put_in(huge, [:fiber, "outcome"], String.duplicate("x", 65 * 1024))

    for _poll <- 1..2 do
      log =
        ExUnit.CaptureLog.capture_log(fn ->
          assert :ok = Threads.capture_results([hub, huge | rest], "test-host")
        end)

      assert log =~ "Thread capture refused thread-"
      assert log =~ "64 KiB"
    end

    assert [_, _] = pending = Shuttle.Test.InboxPublications.pending()
    assert Enum.all?(pending, fn {_id, record} -> record["text"] =~ ~r/Done [23]\./ end)
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
  test "a leftover acknowledgment tmp file and a rolled-back outbox both boot", %{data: data} do
    outbox = Path.join(data, "thread-outbox")
    File.mkdir_p!(Path.join(outbox, "acked"))
    File.mkdir_p!(Path.join(outbox, "pending"))
    File.write!(Path.join(outbox, "baseline"), "2026-10-22T19:33:11.470348Z")
    File.write!(Path.join(outbox, "version"), "4")
    key = :crypto.hash(:sha256, "thread-acked") |> Base.encode16(case: :lower)
    File.write!(Path.join([outbox, "acked", key]), "thread-acked")
    File.write!(Path.join([outbox, "acked", key <> ".123.tmp"]), "thread-acked")
    assert :ok = Shuttle.Inbox.boot_import()
    refute File.exists?(outbox)

    # A daemon rolled back to contract 40 recreated the outbox at its boot.
    File.mkdir_p!(Path.join(outbox, "acked"))
    File.write!(Path.join(outbox, "baseline"), DateTime.to_iso8601(DateTime.utc_now()))
    File.write!(Path.join(outbox, "version"), "4")
    assert :ok = Shuttle.Inbox.boot_import()
    assert Shuttle.Test.InboxPublications.baseline() == "2026-10-22T19:33:11.470348Z"
  end

  @tag first_boot: true
  test "an outbox the import cannot clean up is logged, and every boot goes on", %{data: data} do
    outbox = Path.join(data, "thread-outbox")
    File.mkdir_p!(Path.join(outbox, "acked"))
    File.write!(Path.join(outbox, "baseline"), "2026-10-22T19:33:11.470348Z")
    key = :crypto.hash(:sha256, "thread-acked") |> Base.encode16(case: :lower)
    File.write!(Path.join([outbox, "acked", key]), "thread-acked")
    File.chmod!(Path.join([outbox, "acked", key]), 0o000)
    File.write!(Path.join([outbox, "acked", ".nfs000000000123"]), "")
    File.chmod!(Path.join(outbox, "acked"), 0o500)
    imported = Path.join(data, "thread-outbox.imported/acked")
    on_exit(fn -> File.chmod(imported, 0o700) end)

    for _ <- 1..2 do
      log = ExUnit.CaptureLog.capture_log(fn -> assert :ok = Shuttle.Inbox.boot_import() end)
      assert log =~ "Removing the imported thread outbox failed"
    end

    assert Shuttle.Test.InboxPublications.baseline() == "2026-10-22T19:33:11.470348Z"

    assert File.exists?(
             Path.join(Shuttle.Test.InboxPublications.routing_dir(data), "offered/#{key}.json")
           )
  end

  @tag first_boot: true
  test "an outbox record the inbox can never accept is logged and skipped", %{data: data} do
    outbox = Path.join(data, "thread-outbox")
    File.mkdir_p!(Path.join(outbox, "pending"))
    File.write!(Path.join(outbox, "baseline"), "2026-10-22T19:33:11.470348Z")

    for {id, text} <- [{"thread-big", String.duplicate("x", 65 * 1024)}, {"thread-ok", "done"}] do
      key = :crypto.hash(:sha256, id) |> Base.encode16(case: :lower)

      File.write!(
        Path.join([outbox, "pending", key <> ".json"]),
        Jason.encode!(%{
          id: id,
          record: %{
            "owner" => "test-host",
            "parent_uid" => "p",
            "text" => text,
            "retained_at" => DateTime.to_iso8601(DateTime.utc_now())
          }
        })
      )
    end

    log = ExUnit.CaptureLog.capture_log(fn -> assert :ok = Shuttle.Inbox.boot_import() end)
    assert log =~ "Thread outbox import skipped thread-big"
    assert [{"thread-ok", _}] = Shuttle.Test.InboxPublications.pending()
    refute File.exists?(outbox)
  end

  @tag first_boot: true
  test "an import that fails without corruption is retried, not held", %{data: data} do
    baseline = Path.join(data, "thread-outbox/baseline")
    File.mkdir_p!(Path.dirname(baseline))
    File.write!(baseline, "2026-10-22T19:33:11.470348Z")
    File.chmod!(baseline, 0o000)
    on_exit(fn -> File.chmod(baseline, 0o600) end)
    error = assert_raise RuntimeError, fn -> Shuttle.Inbox.boot_import() end
    assert error.message =~ "thread inbox import failed"
    File.chmod!(baseline, 0o600)
    assert :ok = Shuttle.Inbox.boot_import()
    assert Shuttle.Test.InboxPublications.baseline() == "2026-10-22T19:33:11.470348Z"

    File.write!(Path.join(data, "thread-outbox.json"), "not json")
    assert_raise Shuttle.Inbox.Corrupt, fn -> Shuttle.Inbox.boot_import() end
  end
end
