defmodule Shuttle.Poller.LocalFeedTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller.LocalFeed

  setup do
    data = Path.join(System.tmp_dir!(), "local-feed-#{System.unique_integer([:positive])}")
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data)
    on_exit(fn -> File.rm_rf(data) end)
    {:ok, data: data, feed_file: Path.join([data, "local-fibers", "test-host.json"])}
  end

  @entry %{
    felt_store: "/stores/loom",
    path: "tests/a/a.md",
    dir: "/stores/loom/.felt/tests/a",
    report_path: "/stores/loom/.felt/tests/a/tapestry.html",
    orchestrator: nil,
    fiber: %{"id" => "tests/a", "shuttle" => %{"host" => "test-host"}}
  }

  test "a persisted feed loads back with the cache's atom-keyed entries", %{feed_file: file} do
    assert LocalFeed.persist("test-host", [@entry]) == :ok
    assert LocalFeed.load("test-host") == [@entry]
    assert %{"host" => "test-host", "version" => 1} = file |> File.read!() |> Jason.decode!()
    assert LocalFeed.load("other-host") == []
  end

  test "a write that cannot land reports its error", %{data: data} do
    File.mkdir_p!(data)
    File.write!(Path.join(data, "local-fibers"), "a file where the directory belongs")

    assert {:error, _} = LocalFeed.persist("test-host", [@entry])
  end

  test "a file another host wrote is not this host's feed", %{feed_file: file} do
    File.mkdir_p!(Path.dirname(file))
    row = Jason.decode!(Jason.encode!(@entry))
    File.write!(file, Jason.encode!(%{"version" => 1, "host" => "elsewhere", "fibers" => [row]}))

    assert LocalFeed.load("test-host") == []
  end

  test "a missing, corrupt, other-version or misshapen file loads as no rows",
       %{feed_file: file} do
    assert LocalFeed.load("test-host") == []

    File.mkdir_p!(Path.dirname(file))
    row = Jason.decode!(Jason.encode!(@entry))
    envelope = &Jason.encode!(%{"version" => 1, "host" => "test-host", "fibers" => &1})

    for contents <- [
          "{not json",
          Jason.encode!(%{"version" => 0, "host" => "test-host", "fibers" => [row]}),
          Jason.encode!(%{"version" => 1, "fibers" => [row]}),
          envelope.("nope"),
          envelope.([1]),
          envelope.([%{}]),
          envelope.([row, Map.delete(row, "fiber")]),
          envelope.([Map.put(row, "fiber", %{"name" => "no id"})]),
          envelope.([Map.put(row, "felt_store", 7)]),
          envelope.([Map.put(row, "dir", %{})]),
          envelope.([Map.put(row, "running", true)])
        ] do
      File.write!(file, contents)
      assert LocalFeed.load("test-host") == [], contents
    end
  end

  describe "the single writer" do
    test "writes one snapshot at a time and never lets an older one overtake a newer" do
      w = LocalFeed.writer([:a])

      assert {w, nil} = LocalFeed.offer(w, [:a])
      assert {w, [:b]} = LocalFeed.offer(w, [:b])

      # Snapshots arriving mid-write coalesce: only the newest waits.
      assert {w, nil} = LocalFeed.offer(w, [:c])
      assert {w, nil} = LocalFeed.offer(w, [:d])
      assert {w, nil} = LocalFeed.offer(w, [:d])

      assert {w, [:d]} = LocalFeed.finished(w, :ok)
      assert w.written == [:b]

      assert {w, nil} = LocalFeed.finished(w, :ok)
      assert w == LocalFeed.writer([:d])
    end

    test "a failed write keeps the last written snapshot, so the same rows are offered again" do
      w = LocalFeed.writer([:a])
      {w, [:b]} = LocalFeed.offer(w, [:b])

      assert {w, nil} = LocalFeed.finished(w, {:error, :eacces})
      assert w == LocalFeed.writer([:a])
      assert {_w, [:b]} = LocalFeed.offer(w, [:b])
    end

    test "a snapshot returning to the one being written still queues behind a newer one" do
      w = LocalFeed.writer([:a])
      {w, [:b]} = LocalFeed.offer(w, [:b])
      {w, nil} = LocalFeed.offer(w, [:c])
      {w, nil} = LocalFeed.offer(w, [:b])

      assert {w, [:b]} = LocalFeed.finished(w, :ok)
      assert {%{written: [:b]}, nil} = LocalFeed.finished(w, :ok)
    end
  end
end
