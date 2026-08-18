defmodule Shuttle.RawFSPathTest do
  @moduledoc """
  `RawFS.find_executable/1`'s parity with `System.find_executable/1` on the two
  cases that depend on process-global state: a relative name, which resolves
  against the current directory or not, and `PATH` itself.

  Synchronous, and it never calls `File.cd/1`. The working directory is global
  to the VM — ExUnit loads test files by relative path while async modules are
  already running, so a `cd` here fails the *compiler* on some other file, with
  a `MatchError {:error, :enoent}` that names neither this test nor the reason.
  The fixture is written under the current directory instead, and the relative
  name points at it.
  """
  use ExUnit.Case, async: false

  alias Shuttle.RawFS

  setup do
    relative = Path.join(["tmp", "raw_fs_path_#{System.unique_integer([:positive])}", "bin"])
    File.mkdir_p!(relative)
    tool = Path.join(relative, "tool")
    File.write!(tool, "#!/bin/sh\n")
    File.chmod!(tool, 0o755)
    on_exit(fn -> File.rm_rf!(Path.dirname(relative)) end)

    original = System.get_env("PATH")
    on_exit(fn -> if original, do: System.put_env("PATH", original) end)

    {:ok, tool: tool}
  end

  # `:os.find_executable/1` joins a RELATIVE name onto each PATH entry even when
  # it contains a slash — it does not resolve against the current directory. An
  # earlier version of `find_executable/1` expanded such a name against the
  # daemon's cwd, which is more permissive than the function it replaces; command
  # names reach `Shuttle.Runner` from the agent registry, so more permissive is
  # the wrong direction. The fixture is what makes this test discriminating: the
  # file has to EXIST relative to the cwd, or both implementations answer nil.
  test "a relative name is resolved against PATH, not against the current directory", ctx do
    assert File.regular?(ctx.tool)

    for command <- [ctx.tool, "./" <> ctx.tool, "no/such/tool"] do
      assert RawFS.find_executable(command) == System.find_executable(command),
             "disagreed on #{command}"

      assert System.find_executable(command) == nil,
             "fixture stopped being discriminating: #{command} resolved for :os too"
    end
  end

  # POSIX and `:os.find_executable/1` both read an EMPTY `PATH` element as the
  # current directory (`os.erl` rewrites `[]` to `"."`), so `PATH=":/usr/bin"`
  # searches the cwd first. Splitting `PATH` with `trim: true` would drop it and
  # make this resolver stricter than the one it replaces — failing to find `felt`
  # where the stock resolver finds it.
  test "an empty PATH element means the current directory", ctx do
    for path <- ["", ":/usr/bin", "/usr/bin:", "::"] do
      System.put_env("PATH", path)

      assert RawFS.find_executable(ctx.tool) == System.find_executable(ctx.tool),
             "disagreed with PATH=#{inspect(path)}"

      assert System.find_executable(ctx.tool) != nil,
             "fixture stopped being discriminating with PATH=#{inspect(path)}"
    end
  end
end
