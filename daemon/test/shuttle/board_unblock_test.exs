defmodule Shuttle.BoardUnblockTest do
  use ExUnit.Case, async: true
  alias Shuttle.{ThreadOutbox, Threads}

  defmodule Runner do
    def cmd("shuttle", ["board", "append"], opts) do
      send(self(), {:board, Jason.decode!(opts[:input]), opts[:input_eof]})
      {"", 0}
    end
  end

  test "a newly captured unblock posts exactly once, including after acknowledgement" do
    dir = Path.join(System.tmp_dir!(), "board-unblock-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", dir)
    Shuttle.Test.Env.put_app_env(:felt_runner, Runner)
    ThreadOutbox.boot_baseline()
    stamp = DateTime.add(DateTime.utc_now(), 2, :second) |> DateTime.to_iso8601()

    parent = %{
      felt_store: dir,
      fiber: %{"id" => "hub", "uid" => "root", "shuttle" => %{"host" => "host"}}
    }

    child = %{
      felt_store: dir,
      fiber: %{
        "id" => "hub/child",
        "uid" => "child",
        "shuttle" => %{"host" => "host", "blocked_on" => "work/blocker"}
      }
    }

    blocker = %{
      felt_store: dir,
      fiber: %{
        "id" => "work/blocker",
        "uid" => "blocker",
        "name" => "Blocker",
        "status" => "closed",
        "closed_at" => stamp
      }
    }

    entries = [parent, child, blocker]
    assert :ok = Threads.capture_unblocks(entries, "host")

    assert_receive {:board,
                    %{"kind" => "unblocked", "fiber" => "child", "text" => "Blocker closed"},
                    true}

    assert [{id, _}] = ThreadOutbox.pending("host")
    assert :ok = Threads.capture_unblocks(entries, "host")
    refute_receive {:board, _, _}, 20
    ThreadOutbox.acknowledge(id)
    assert :ok = Threads.capture_unblocks(entries, "host")
    refute_receive {:board, _, _}, 20
  end

  test "runner supplies EOF after the input" do
    assert {"5", 0} =
             Shuttle.Runner.Default.cmd("sh", ["-c", "data=$(cat); printf %s ${#data}"],
               input: "hello",
               input_eof: true
             )
  end
end
