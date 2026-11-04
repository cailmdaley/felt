defmodule Shuttle.RexTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Rex, Test.Env, Test.FakeRex}
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.delete_env("SHUTTLE_REX_SERVER")
    Env.put_app_env(:rex_server, "unix:///scope.sock")
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    :ok
  end

  test "endpoint rule agrees with the CLI and is exported into workers" do
    Env.delete_app_env(:rex_server)

    for c <- FakeRex.fixture("endpoints") do
      Env.put_app_env(:os_type, {:unix, if(c["os"] == "darwin", do: :darwin, else: :linux)})
      Env.put_env("HOME", c["home"])
      Env.put_env("SHUTTLE_DATA_DIR", c["data"])

      if c["override"] == "",
        do: Env.delete_env("SHUTTLE_REX_SERVER"),
        else: Env.put_env("SHUTTLE_REX_SERVER", c["override"])

      assert (Rex.server() || "") == c["want"], c["name"]
      assert Enum.member?(Rex.flags(), "-S") == (c["want"] != "")
      script = Rex.environment_script() <> "printf '%s' \"${SHUTTLE_REX_SERVER-}\""

      assert {output, 0} =
               System.cmd("/bin/sh", ["-c", script],
                 env: [{"SHUTTLE_REX_SERVER", "wrong-server"}]
               )

      assert output == c["want"]
    end
  end

  test "Rex fixtures use synthetic host identity and environment paths" do
    root = Path.expand("../fixtures/rex", __DIR__)

    ids =
      Path.wildcard(Path.join(root, "*.json"))
      |> Enum.flat_map(fn file -> file |> File.read!() |> Jason.decode!() |> host_ids() end)

    assert Enum.uniq(ids) == ["00000000-0000-4000-8000-000000000001"]

    env = FakeRex.fixture("environment_isolated")

    for values <- Map.values(env) do
      assert values["TMPDIR"] == "/tmp/rex-fixture/"
      assert values["PATH"] =~ "<HOME>/tools/bin"
      refute values["PATH"] =~ "loom"
      refute values["PATH"] =~ "munki"
      refute values["PATH"] =~ "puppetlabs"
      refute values["PATH"] =~ "/pkg/"
    end
  end

  defp host_ids(value) when is_map(value) do
    own = if value["host_id"], do: [value["host_id"]], else: []
    own ++ Enum.flat_map(Map.values(value), &host_ids/1)
  end

  defp host_ids(value) when is_list(value), do: Enum.flat_map(value, &host_ids/1)

  defp host_ids(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, decoded} -> host_ids(decoded)
      {:error, _} -> []
    end
  end

  defp host_ids(_), do: []

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
    Env.put_env("SHUTTLE_REX_SERVER", "unix:///env.sock")
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
