defmodule Shuttle.Poller.LocalFeedTest do
  use ExUnit.Case, async: true

  alias Shuttle.Poller.LocalFeed

  setup do
    data = Path.join(System.tmp_dir!(), "local-feed-#{System.unique_integer([:positive])}")
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data)
    on_exit(fn -> File.rm_rf(data) end)
    {:ok, feed_file: Path.join([data, "local-fibers", "test-host.json"])}
  end

  test "a persisted feed loads back with the cache's atom-keyed entries" do
    entry = %{
      felt_store: "/stores/loom",
      path: "tests/a/a.md",
      dir: "/stores/loom/.felt/tests/a",
      orchestrator: nil,
      fiber: %{"id" => "tests/a", "shuttle" => %{"host" => "test-host"}}
    }

    assert LocalFeed.persist("test-host", [entry]) == :ok
    assert LocalFeed.load("test-host") == [entry]
    assert LocalFeed.load("other-host") == []
  end

  test "a missing, corrupt, foreign or other-version file loads as no rows", %{feed_file: file} do
    assert LocalFeed.load("test-host") == []

    File.mkdir_p!(Path.dirname(file))

    for contents <- [
          "{not json",
          Jason.encode!(%{"version" => 0, "fibers" => [%{"path" => "x"}]}),
          Jason.encode!(%{"version" => 1, "fibers" => "nope"}),
          Jason.encode!(%{"version" => 1, "fibers" => [%{"never_an_atom_q8z" => 1}]}),
          Jason.encode!(%{"version" => 1, "fibers" => [1]})
        ] do
      File.write!(file, contents)
      assert LocalFeed.load("test-host") == [], contents
    end
  end
end
