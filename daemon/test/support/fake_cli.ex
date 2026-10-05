defmodule Shuttle.Test.FakeCli do
  @moduledoc """
  Fake executables (`felt`, `shuttle`, `tmux`, …) for one test.

  `install!/1` writes each script into a fresh temp dir and prepends it to the
  test's *scoped* `PATH` (`Shuttle.Test.Env.prepend_path/1`), so
  `Shuttle.Runner.Default` resolves the fake for this test's processes and the
  real binary for every other test. The dir is removed when the test exits.

      dir = FakeCli.install!(%{"shuttle" => ~s(#!/bin/sh\\nprintf '%s\\\\n' "$@" >> "$LOG"\\n)})
  """

  @doc "Install `scripts` (name → script body) on this test's PATH; returns the bin dir."
  def install!(scripts) when is_map(scripts) do
    dir =
      Path.join(System.tmp_dir!(), "shuttle-fake-cli-#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)

    for {name, body} <- scripts do
      path = Path.join(dir, name)
      File.write!(path, body)
      File.chmod!(path, 0o755)
    end

    Shuttle.Test.Env.prepend_path(dir)
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  @doc "The real executable `name` on the test's PATH before any fake shadows it."
  def real!(name), do: Shuttle.Env.find_executable(name) || raise("#{name} not on PATH")
end
