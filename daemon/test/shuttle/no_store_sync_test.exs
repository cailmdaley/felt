defmodule Shuttle.NoStoreSyncTest do
  use ExUnit.Case, async: true

  @daemon_lib Path.expand("../../lib", __DIR__)

  test "daemon runtime never shells git directly, and only StoreSync runs felt sync --ff-only" do
    violations =
      @daemon_lib
      |> Path.join("**/*.ex")
      |> Path.wildcard()
      |> Enum.reject(&String.ends_with?(&1, "shuttle.gen_version.ex"))
      |> Enum.flat_map(fn path ->
        source = File.read!(path)
        store_sync? = String.ends_with?(path, "shuttle/store_sync.ex")

        checks =
          [
            {~r/(?:System|:os)\.cmd\(\s*"git"|\.cmd\(\s*"git"/, "git command"},
            {~r/Shuttle\.Runner\.run\(\s*"git"|Runner\.run\(\s*"git"/, "runner git command"},
            {~r/Shuttle\.Felt\.run\(\s*\[.*?"sync"/s, "direct Shuttle.Felt sync command"}
          ] ++
            if store_sync? do
              # StoreSync may only invoke `felt ... sync --ff-only`, never `--push` or plain sync.
              [{~r/"--push"/, "StoreSync push flag"}]
            else
              [{~r/"sync"\s*,\s*"--ff-only"/, "sync --ff-only outside StoreSync"}]
            end

        for {pattern, label} <- checks, Regex.match?(pattern, source), do: {path, label}
      end)

    assert Path.wildcard(Path.join(@daemon_lib, "**/*.ex")) != []
    assert violations == [], "forbidden daemon commands: #{inspect(violations)}"
  end
end
