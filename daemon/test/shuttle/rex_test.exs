defmodule Shuttle.RexTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Test.Env, Test.FakeRex}
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_env("SHUTTLE_REX_SERVER", "unix:///env.sock")
    Env.put_app_env(:rex_server, "unix:///scope.sock")
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    :ok
  end

  test "binary resolution honors explicit path, PATH, then the vendor Current path", %{
    tmp_dir: dir
  } do
    assert Rex.bin() == "/bin/echo"
    Env.put_env("SHUTTLE_REX_BIN", "/missing/rex")
    assert Rex.bin() == nil
    Env.delete_env("SHUTTLE_REX_BIN")
    Env.put_env("PATH", dir)
    Env.put_env("HOME", dir)

    vendor =
      Path.join(
        dir,
        "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
      )

    File.mkdir_p!(Path.dirname(vendor))
    File.write!(vendor, "#!/bin/sh\n")
    File.chmod!(vendor, 0o700)
    assert Rex.bin() == vendor
    local = Path.join(dir, "rex")
    File.write!(local, "#!/bin/sh\n")
    File.chmod!(local, 0o700)
    Shuttle.Env.invalidate_executable("rex")
    assert Rex.bin() == local
  end

  test "requests carry JSON on stdin, disable autostart and use the scoped server" do
    assert {:ok, [%{"block_id" => _}]} = Rex.blocks(FakeRex, seed())
    [{"/bin/echo", argv, opts}] = FakeRex.calls()

    assert argv == [
             "--autostart=false",
             "--timeout",
             "5s",
             "-S",
             "unix:///scope.sock",
             "api",
             "call",
             "-s",
             seed(),
             "session.list_blocks",
             "-"
           ]

    assert Jason.decode!(opts[:input]) == %{}
    assert opts[:input_eof]
    assert opts[:timeout_ms] == 6_000
    Env.delete_app_env(:rex_server)
    assert List.last(Rex.flags()) == "unix:///env.sock"
  end

  test "captured missing-server, missing-target, timeout and conflict errors stay distinct" do
    FakeRex.fixture("errors")
    |> Enum.each(fn {key, error} ->
      expected =
        cond do
          error["exit_status"] == 4 -> :server_absent
          error["exit_status"] == 3 -> :not_found
          true -> {:unknown, error["stderr"]}
        end

      assert Rex.classify({error["stderr"], error["exit_status"]}) == {:error, expected}, key
    end)

    assert Rex.classify({"not found", :timeout}) == {:error, {:unknown, "not found"}}
    FakeRex.reply("session.list", {"garbled", 0})
    assert {:error, {:unknown, _}} = Rex.sessions(FakeRex)
    FakeRex.reply("session.list", {~s({"sessions":null}), 0})
    assert {:error, {:unknown, _}} = Rex.sessions(FakeRex)
  end

  test "helpers preserve process fixtures and discover the app client" do
    sid = seed()
    [block] = FakeRex.fixture("list_blocks")["blocks"]
    assert {:ok, process} = Rex.process(FakeRex, sid, block["block_id"])
    assert process == FakeRex.fixture("process_running")
    assert {:error, :not_found} = Rex.app_client(FakeRex)

    FakeRex.clients([
      %{"client_id" => "client:cli", "info" => %{"kind" => "cli"}},
      %{"client_id" => "client:app", "info" => %{"kind" => "app"}}
    ])

    assert {:ok, "client:app"} = Rex.app_client(FakeRex)
    assert {:ok, %{"performed_by" => "client:app"}} = Rex.select(FakeRex, "client:app", sid)
    assert {:ok, %{"full_disk_access" => "granted"}} = Rex.privacy_status(FakeRex)
  end

  test "EOF stdin reaches a real CLI reader without placing the request in argv", %{tmp_dir: dir} do
    reader = Path.join(dir, "reader")
    File.write!(reader, "#!/bin/sh\n/bin/cat\n")
    File.chmod!(reader, 0o700)
    Env.put_env("SHUTTLE_REX_BIN", reader)

    assert {:ok, %{"message" => "a'b\nsecond"}} =
             Rex.call(Shuttle.Runner.Default, "ignored", %{"message" => "a'b\nsecond"})
  end

  defp seed do
    [%{"session_id" => sid, "label" => label}] = FakeRex.fixture("session_list")["sessions"]
    FakeRex.sessions(%{sid => %{label: label, blocks: FakeRex.fixture("list_blocks")["blocks"]}})
    sid
  end
end
