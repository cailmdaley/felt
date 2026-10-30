defmodule Shuttle.OpenerTest do
  use ExUnit.Case, async: true
  alias Shuttle.{Opener, Test.Env, Test.FakeRex}
  alias Shuttle.Terminal.{Rex, RexBindings, Tmux}
  @moduletag :tmp_dir
  @name "probe-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"

  defmodule Kitty do
    def open(name, host) do
      send(Shuttle.Env.app(:opener_test), {:kitty, name, host})
      :ok
    end
  end

  defmodule Client do
    def get(url, timeout) do
      send(Shuttle.Env.app(:opener_test), {:version, url, timeout})

      if String.contains?(url, "/sessions?"),
        do: Shuttle.Env.app(:opener_sessions, {:ok, ~s({"records":[]})}),
        else: Shuttle.Env.app(:opener_version, {:ok, ~s({"terminal":"tmux"})})
    end
  end

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:terminal_backend, Rex)
    Env.put_app_env(:kitty_impl, Kitty)
    Env.put_app_env(:opener_test, self())
    Env.put_app_env(:opener_http_client, Client)
    Env.put_app_env(:remotes, [%{name: "remote-a", port: 4001, ssh: "login-a"}])
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])
    tools = Path.join(dir, "tools")
    File.mkdir_p!(tools)
    File.write!(Path.join(tools, "tmux"), "#!/bin/sh\nexit 0\n")
    File.chmod!(Path.join(tools, "tmux"), 0o755)
    Env.put_env("PATH", tools)
    Env.put_env("SSH_AUTH_SOCK", "/tmp/daemon's ssh.sock")
    Env.put_env("TMUX_TMPDIR", "/tmp/daemon's tmux")
    %{tmux: Path.join(tools, "tmux")}
  end

  test "Rex-held worker reveals its immutable session despite a display rename" do
    assert :ok = Rex.launch(FakeRex, @name, "/tmp", "worker.sh", [])
    sid = FakeRex.fixture("session_create")["session_id"]
    FakeRex.sessions(Map.update!(FakeRex.state().sessions, sid, &%{&1 | label: "human label"}))
    assert :ok = Opener.open(@name)
    assert [select] = requests("client.perform")
    assert select["args"] == %{"session_id" => sid}
    assert length(requests("session.create")) == 1
    refute_received {:kitty, _, _}
    assert Enum.any?(FakeRex.calls(), &match?({"open", ["-b", "com.superlogical.rex"], _}, &1))
  end

  test "local tmux workers get one unbound viewer and repeated opens select it", %{tmux: tmux} do
    FakeRex.reply("tmux", {"", 0})
    assert :ok = Opener.open(@name)
    assert :ok = Opener.open(@name)
    assert [spec] = requests("session.create")
    assert spec["label"] == @name <> "@tmux"
    options = options(spec)
    assert options["exit"] == %{"on_completion" => true, "quick_exit_threshold_ms" => 0}
    assert ["bash", "-c", script] = options["command"]
    assert script =~ "'#{tmux}' 'attach' '-t' '=#{@name}'"
    assert script =~ "export PATH="
    assert script =~ "export TMUX_TMPDIR='/tmp/daemon'\\''s tmux'"
    assert length(requests("client.perform")) == 2
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
    refute_received {:kitty, _, _}
  end

  test "long local worker names keep their exact tmux target and a stable compact viewer", %{
    tmux: tmux
  } do
    name =
      Shuttle.Dispatcher.session_name(String.duplicate("x", 90), "01KVBR5K0FZHZQK18845TZ01Q2")

    assert String.length(name) == 125
    FakeRex.reply("tmux", {"", 0})
    assert :ok = Opener.open(name)
    assert :ok = Opener.open(name)
    assert [spec] = requests("session.create")
    assert String.length(spec["label"]) == 127
    assert String.ends_with?(spec["label"], "@tmux")
    assert ["bash", "-c", script] = options(spec)["command"]
    assert script =~ "'#{tmux}' 'attach' '-t' '=#{name}'"
  end

  test "viewer label boundaries and long host suffixes preserve distinct full targets" do
    host = String.duplicate("remote", 20)
    Env.put_app_env(:remotes, [%{name: host, port: 4001, ssh: "login-a"}])
    # 127-character labels are exact; longer labels are compacted. Names
    # differing only beyond the retained display prefix cannot dedupe.
    for {name, destination} <- [
          {String.duplicate("a", 118), "remote-a"},
          {String.duplicate("a", 119), "remote-a"},
          {String.duplicate("a", 124) <> "b", "remote-a"},
          {String.duplicate("a", 124) <> "c", "remote-a"},
          {String.duplicate("a", 125), host}
        ] do
      Env.put_app_env(:remotes, [%{name: destination, port: 4001, ssh: "login-a"}])
      assert :ok = Opener.open(name, destination)
      ["bash", "-c", script] = options(List.last(requests("session.create")))["command"]
      assert script =~ "=" <> name
    end

    specs = requests("session.create")
    assert length(specs) == 5
    labels = Enum.map(specs, & &1["label"])
    assert length(Enum.uniq(labels)) == 5
    assert Enum.all?(labels, &(String.length(&1) <= 127))
    assert hd(labels) == String.duplicate("a", 118) <> "@remote-a"
    assert Enum.at(labels, 1) != String.duplicate("a", 119) <> "@remote-a"
    # Reject controls even when compaction would drop them from the label.
    assert {:error, _} = Rex.viewer(FakeRex, String.duplicate("a", 130) <> "\n@tmux", ["true"])
  end

  test "remote viewers use the fleet ssh destination and the daemon's ssh agent" do
    assert :ok = Opener.open(@name, "remote-a")
    assert_received {:version, "http://127.0.0.1:4001/api/v1/version", 2000}
    assert [spec] = requests("session.create")
    assert spec["label"] == @name <> "@remote-a"
    assert ["bash", "-c", script] = options(spec)["command"]
    assert script =~ "'ssh' '-tt' '--' 'login-a'"
    assert script =~ "export SSH_AUTH_SOCK='/tmp/daemon'\\''s ssh.sock'"
    refute script =~ "'remote-a'"
    refute_received {:kitty, _, _}
  end

  test "local and remote viewers obtain their tree paths from their owning host's ledger" do
    Env.delete_env("SHUTTLE_SESSIONS_FILE")

    Shuttle.SessionLedger.record(
      fiber: "a/design/rex",
      session: "local-worker",
      tmux: @name,
      kind: :dispatch
    )

    FakeRex.reply("tmux", {"", 0})
    assert :ok = Opener.open(@name)
    child = "codex-terminal-fork-thread"

    Env.put_app_env(
      :opener_sessions,
      {:ok,
       Jason.encode!(%{
         "records" => [
           %{
             "fiber" => "a/design/rex/thread",
             "thread_id" => "fork-thread",
             "session" => "fork-transcript"
           }
         ]
       })}
    )

    assert :ok = Opener.open(child, "remote-a")
    assert {:ok, sessions} = Shuttle.Rex.sessions(FakeRex)
    assert Enum.map(sessions, & &1["label"]) == ["design/rex @tmux", "└ thread @remote-a"]
    assert :ok = Opener.open(child, "remote-a")
    assert [_, _] = requests("session.create")
  end

  test "remote shell metacharacters stay inside the literal tmux target", %{tmp_dir: dir} do
    # Run both shell parses, as ssh does, with fixture executables only.
    tools = Path.join(dir, "tools")
    receipt = Path.join(dir, "target")
    sentinel = Path.join(dir, "injected")
    File.write!(Path.join(tools, "ssh"), "#!/bin/sh\nshift 3\nexec /bin/bash -c \"$1\"\n")
    File.chmod!(Path.join(tools, "ssh"), 0o755)
    File.write!(Path.join(tools, "tmux"), "#!/bin/sh\nprintf '%s' \"$3\" > \"$RECEIPT\"\n")
    name = "worker; /usr/bin/touch injected"
    assert :ok = Opener.open(name, "remote-a")
    [spec] = requests("session.create")
    ["bash", "-c", script] = options(spec)["command"]
    # The trap is deliberately harmless here; /bin/echo is the fake Rex CLI.
    assert {_, 0} = System.cmd("/bin/bash", ["-c", script], cd: dir, env: [{"RECEIPT", receipt}])
    assert File.read!(receipt) == "=" <> name
    refute File.exists?(sentinel)
  end

  test "concurrent opens serialize creation of the same exact viewer label" do
    tasks = for _ <- 1..4, do: Task.async(fn -> Opener.open(@name, "remote-a") end)
    assert Enum.map(tasks, &Task.await(&1, 15_000)) == [:ok, :ok, :ok, :ok]
    assert [_] = requests("session.create")
    assert length(requests("client.perform")) == 4
  end

  test "a refused app selection surfaces an error without a second viewer or an app raise" do
    FakeRex.reply("client.perform", {"Remote Control is disabled", 1})
    assert {:error, reason} = Opener.open(@name, "remote-a")
    assert reason =~ "Remote Control is disabled"
    assert [_] = requests("session.create")
    refute Enum.any?(FakeRex.calls(), &match?({"open", _, _}, &1))
  end

  test "empty owned viewers are replaced without entering the worker bindings" do
    label = @name <> "@remote-a"
    assert {:ok, sid} = Rex.viewer(FakeRex, label, ["sleep", "30"])
    FakeRex.sessions(Map.update!(FakeRex.state().sessions, sid, &%{&1 | blocks: []}))
    assert :ok = Opener.open(@name, "remote-a")
    assert [_] = requests("session.destroy")
    assert [_, _] = requests("session.create")
    refute Map.has_key?(FakeRex.state().sessions, sid)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
  end

  test "unowned duplicate labels cannot be adopted, and uncertain reads refuse another viewer" do
    label = @name <> "@remote-a"

    FakeRex.sessions(%{
      "session:a" => %{label: label, blocks: [%{"block_id" => "block:a"}]},
      "session:b" => %{label: label, blocks: [%{"block_id" => "block:b"}]}
    })

    assert :ok = Opener.open(@name, "remote-a")
    assert [_] = requests("session.create")
    assert [selection] = requests("client.perform")
    refute selection["args"]["session_id"] in ["session:a", "session:b"]
    assert requests("session.destroy") == []
    FakeRex.reply("session.list", {"timed out", :timeout})
    assert {:error, _} = Opener.open(@name, "remote-a")
    assert [_] = requests("session.create")
  end

  test "no SSH path or unknown worker opens no viewer" do
    Env.put_app_env(:remotes, [%{name: "remote-a", url: "https://remote.example.test"}])
    assert {:error, reason} = Opener.open(@name, "remote-a")
    assert reason =~ "no ssh path"
    assert {:error, reason} = Opener.open(@name)
    assert reason =~ "absent or unobservable"
    assert requests("session.create") == []
  end

  test "kitty display delegates local and remote tmux terminals unchanged" do
    Env.put_app_env(:terminal_backend, Tmux)
    assert :ok = Opener.open(@name)
    assert_received {:kitty, @name, nil}
    assert :ok = Opener.open(@name, "remote-a")
    assert_received {:kitty, @name, "remote-a"}
    assert FakeRex.calls() == []
  end

  test "remote Rex is explicitly unsupported on a Rex display" do
    Env.put_app_env(:opener_version, {:ok, ~s({"terminal":"rex"})})
    assert {:error, "opening a worker on a remote Rex server is not supported yet"} =
             Opener.open(@name, "remote-a")
    refute_received {:kitty, _, _}
    assert FakeRex.calls() == []
  end

  test "kitty remote attach does not consult the remote daemon" do
    Env.put_app_env(:terminal_backend, Tmux)

    for reply <- [{:error, :timeout}, {:ok, "bad json"}, {:ok, ~s({"terminal":"rex"})}] do
      Env.put_app_env(:opener_version, reply)
      assert :ok = Opener.open(@name, "remote-a")
      assert_received {:kitty, @name, "remote-a"}
      refute_received {:version, _, _}
    end
  end

  test "Rex display defaults old versions to tmux and refuses uncertain versions" do
    Env.put_app_env(:opener_version, {:ok, "{}"})
    assert :ok = Opener.open(@name, "remote-a")

    for reply <- [
          {:error, :timeout},
          {:ok, "[]"},
          {:ok, "bad json"},
          {:ok, ~s({"terminal":null})}
        ] do
      Env.put_app_env(:opener_version, reply)
      assert {:error, _} = Opener.open(@name, "remote-a")
    end

    refute_received {:kitty, _, _}
  end

  test "bad names and unknown hosts are rejected without starting a display" do
    assert {:error, "tmux_session is required"} = Opener.open("")
    assert {:error, reason} = Opener.open(@name, "unknown")
    assert reason =~ "unknown origin"
    assert {:error, _} = Rex.viewer(FakeRex, "bad\nlabel", ["true"])
    assert FakeRex.calls() == []
  end

  defp requests(method) do
    for {_, args, opts} <- FakeRex.calls(), method in args, do: Jason.decode!(opts[:input])
  end

  defp options(spec), do: hd(spec["initial_windows"])["layout"]["block"]["options"]
end
