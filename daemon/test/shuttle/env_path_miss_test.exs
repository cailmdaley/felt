defmodule Shuttle.EnvPathMissTest do
  use ExUnit.Case, async: true

  alias Shuttle.Test.{Env, FakeCli}

  # Installed on the VM's real PATH by test_helper.exs, and on no scoped one.
  @marker "shuttle-real-path-marker"

  test "outside a PATH override the real PATH resolves the marker" do
    assert Shuttle.Env.cmd(@marker, []) == {@marker, 0}
  end

  test "a scoped PATH without the marker never runs the real PATH's" do
    Env.put_env("PATH", Path.join(System.tmp_dir!(), "no-such-bin"))
    assert_raise ErlangError, ~r/enoent/, fn -> Shuttle.Env.cmd(@marker, []) end
  end

  test "an empty scoped PATH never runs the real PATH's marker" do
    Env.put_env("PATH", "")
    assert_raise ErlangError, ~r/enoent/, fn -> Shuttle.Env.cmd(@marker, []) end
  end

  test "a deleted scoped PATH never runs the real PATH's marker" do
    Env.delete_env("PATH")
    assert_raise ErlangError, ~r/enoent/, fn -> Shuttle.Env.cmd(@marker, []) end
  end

  test "a scoped PATH resolves its own executables" do
    FakeCli.install!(%{"shuttle-scoped-probe" => "#!/bin/sh\nprintf scoped\n"})
    assert Shuttle.Env.cmd("shuttle-scoped-probe", []) == {"scoped", 0}
  end

  test "an absolute path runs under any scoped PATH" do
    Env.delete_env("PATH")
    assert Shuttle.Env.cmd("/bin/sh", ["-c", "printf abs"]) == {"abs", 0}
  end
end
