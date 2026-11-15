defmodule Shuttle.BoardUnblockTest do
  use ExUnit.Case, async: true
  alias Shuttle.Threads
  alias Shuttle.Test.InboxPublications

  # Runs thread-put and loses its answer, as a timeout kill after the entries
  # were created would.
  defmodule LostAnswerRunner do
    def cmd("shuttle", ["inbox", "thread-put"] = args, opts) do
      Shuttle.Runner.Default.cmd("shuttle", args, opts)
      {"", :timeout}
    end

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defp board(dir) do
    case File.read(Path.join(dir, "events.jsonl")) do
      {:ok, text} ->
        for line <- String.split(text, "\n", trim: true),
            record = Jason.decode!(line),
            record["type"] == "board",
            do: Map.take(record, ["kind", "fiber", "text"])

      {:error, :enoent} ->
        []
    end
  end

  defp family(dir, closed_at) do
    [
      %{
        felt_store: dir,
        fiber: %{"id" => "hub", "uid" => "root", "shuttle" => %{"host" => "host"}}
      },
      %{
        felt_store: dir,
        fiber: %{
          "id" => "hub/child",
          "uid" => "child",
          "shuttle" => %{"host" => "host", "blocked_on" => "work/blocker"}
        }
      },
      %{
        felt_store: dir,
        fiber: %{
          "id" => "work/blocker",
          "uid" => "blocker",
          "name" => "Blocker",
          "status" => "closed",
          "closed_at" => closed_at
        }
      }
    ]
  end

  defp later(seconds),
    do: DateTime.utc_now() |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()

  setup do
    dir = Path.join(System.tmp_dir!(), "board-unblock-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", dir)
    Shuttle.Inbox.boot_import()
    %{dir: dir}
  end

  test "a newly captured unblock posts exactly once, including after acknowledgement", %{
    dir: dir
  } do
    entries = family(dir, later(2))
    assert :ok = Threads.capture_results(entries, "host")
    unblocked = %{"kind" => "unblocked", "fiber" => "child", "text" => "Blocker closed"}
    assert board(dir) == [unblocked]

    assert [{id, _}] = InboxPublications.pending()
    assert :ok = Threads.capture_results(entries, "host")
    InboxPublications.settle(id)
    assert :ok = Threads.capture_results(entries, "host")
    assert board(dir) == [unblocked]

    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS", "off")

    assert ExUnit.CaptureLog.capture_log(fn ->
             assert :ok = Threads.capture_results(family(dir, later(5)), "host")
           end) =~ "Recording unblock thread-"

    assert [{_, _}] = InboxPublications.pending()
  end

  test "an unblock whose thread-put answer is lost still posts once", %{dir: dir} do
    Shuttle.Test.Env.put_app_env(:felt_runner, LostAnswerRunner)
    entries = family(dir, later(2))

    ExUnit.CaptureLog.capture_log(fn ->
      assert :ok = Threads.capture_results(entries, "host")
      assert :ok = Threads.capture_results(entries, "host")
    end)

    assert board(dir) == [
             %{"kind" => "unblocked", "fiber" => "child", "text" => "Blocker closed"}
           ]
  end

  test "runner reports an unavailable input directory without raising" do
    dir = Path.join(System.tmp_dir!(), "missing-#{System.unique_integer([:positive])}")

    assert {message, 1} =
             Shuttle.Runner.Default.cmd("sh", ["-c", "true"],
               input: "x",
               input_eof: true,
               input_tmp_dir: dir
             )

    assert message =~ "cannot create command input"
  end

  test "runner supplies EOF after the input" do
    assert {"5", 0} =
             Shuttle.Runner.Default.cmd("sh", ["-c", "data=$(cat); printf %s ${#data}"],
               input: "hello",
               input_eof: true
             )
  end
end
