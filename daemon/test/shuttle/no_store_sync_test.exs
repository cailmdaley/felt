defmodule Shuttle.NoStoreSyncTest do
  use ExUnit.Case, async: true

  @daemon_lib Path.expand("../../lib", __DIR__)

  test "daemon runtime never shells git or felt sync" do
    violations =
      @daemon_lib
      |> Path.join("**/*.ex")
      |> Path.wildcard()
      |> Enum.reject(&String.ends_with?(&1, "shuttle.gen_version.ex"))
      |> Enum.flat_map(fn path ->
        source = File.read!(path)

        checks = [
          {~r/(?:System|:os)\.cmd\(\s*"git"|\.cmd\(\s*"git"/, "git command"},
          {~r/Shuttle\.Felt\.run\(\s*\[.*?"sync"/s, "felt sync command"},
          {~r/defmodule\s+Shuttle\.StoreSync\b/, "StoreSync module"}
        ]

        for {pattern, label} <- checks, Regex.match?(pattern, source), do: {path, label}
      end)

    assert Path.wildcard(Path.join(@daemon_lib, "**/*.ex")) != []
    assert violations == [], "forbidden daemon commands: #{inspect(violations)}"
  end
end
