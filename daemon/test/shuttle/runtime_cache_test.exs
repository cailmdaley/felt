defmodule Shuttle.RuntimeCacheTest do
  use ExUnit.Case, async: true

  test "a hit avoids rebuilding, expiry and invalidation rebuild" do
    key = {__MODULE__, make_ref()}

    load = fn ->
      send(self(), :loaded)
      "cached"
    end

    assert Shuttle.RuntimeCache.fetch(key, 60_000, load) == "cached"
    assert_receive :loaded
    assert Shuttle.RuntimeCache.fetch(key, 60_000, load) == "cached"
    refute_receive :loaded, 0
    Shuttle.RuntimeCache.delete(key)
    assert Shuttle.RuntimeCache.fetch(key, 0, load) == "cached"
    assert_receive :loaded
    assert Shuttle.RuntimeCache.fetch(key, 0, load) == "cached"
    assert_receive :loaded
  end

  test "path and executable lookup work before the cache owner starts" do
    script = """
    false = Process.whereis(Shuttle.RuntimeCache) != nil
    true = is_binary(Shuttle.Env.home())
    true = is_binary(Shuttle.Env.expand("~/.config"))
    true = is_binary(Shuttle.Env.find_executable("sh"))
    IO.puts("boot lookup ok")
    """

    assert {"boot lookup ok\n", 0} =
             System.cmd("elixir", ["-pa", "_build/test/lib/shuttle/ebin", "-e", script],
               env: [{"ERL_FLAGS", "+S 2:2"}],
               stderr_to_stdout: true
             )
  end

  test "missing values aren't cached" do
    key = {__MODULE__, make_ref()}
    assert Shuttle.RuntimeCache.fetch(key, 60_000, fn -> nil end) == nil
    assert Shuttle.RuntimeCache.fetch(key, 60_000, fn -> "installed" end) == "installed"
  end
end
