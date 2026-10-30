defmodule Shuttle.Terminal.RexTest do
  use ExUnit.Case, async: true
  import ExUnit.CaptureLog
  alias Shuttle.{Test.Env, Test.FakeRex}
  alias Shuttle.Terminal.{Rex, RexBindings}
  @moduletag :tmp_dir
  @name "probe-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:paste_submit_delay_ms, 0)
    :ok
  end

  test "version exposes unusable Rex configuration without probing the server", %{tmp_dir: dir} do
    Env.put_app_env(:terminal_backend, Rex)
    Env.put_env("SHUTTLE_REX_BIN", Path.join(dir, "missing-rex"))
    conn = ShuttleWeb.VersionController.show(Plug.Test.conn(:get, "/api/v1/version"), %{})

    assert %{
             "rex_backend" => %{
               "state" => "unavailable",
               "available" => false,
               "reason" => reason
             }
           } = Jason.decode!(conn.resp_body)

    assert reason =~ "executable not found"

    assert {:error, {:rex_server_unavailable, _}} =
             Shuttle.Terminal.launch(FakeRex, @name, "/tmp", "true")

    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    File.mkdir_p!(Path.dirname(RexBindings.path()))
    File.write!(RexBindings.path(), "invalid")
    assert %{state: "unavailable", available: false, reason: invalid} = Rex.health()
    assert invalid =~ "invalid_bindings"
    assert {:error, {:rex_server_unavailable, _}} = Rex.ensure_ready(FakeRex)
    assert FakeRex.calls() == []
  end

  test "launch uses the captured specification and persists nested create IDs" do
    assert :ok = Rex.launch(FakeRex, @name, "/tmp", "/tmp/worker.sh", [])

    [{_, argv, opts}] =
      Enum.filter(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end)

    assert "--autostart=false" in argv
    spec = Jason.decode!(opts[:input])

    expected =
      FakeRex.fixture("session_create_request")
      |> put_in(["initial_windows", Access.at(0), "layout", "block", "options", "cwd"], "/tmp")
      |> put_in(["initial_windows", Access.at(0), "layout", "block", "options", "command"], [
        "bash",
        "-l",
        "/tmp/worker.sh"
      ])

    assert spec == expected

    assert {:ok, %{"version" => 1, "server" => server, "bindings" => %{@name => binding}}} =
             RexBindings.read()

    assert server == FakeRex.fixture("whoami")["host_id"]
    assert binding["session_id"] == sid()
    assert binding["block_id"] == bid()
    assert {:ok, _, _} = DateTime.from_iso8601(binding["created_at"])
    assert Rex.probe(FakeRex, @name) == :present
  end

  test "rejects control-containing names before a create" do
    assert {:error, _} = Rex.launch(FakeRex, "bad\nlabel", "/tmp", "x", [])
    assert FakeRex.calls() == []
  end

  test "a 120-character fiber leaf launches with a unique bounded recovery index" do
    name =
      Shuttle.Dispatcher.session_name(String.duplicate("x", 120), "01KVBR5K0FZHZQK18845TZ01Q2")

    assert :ok = Rex.launch(FakeRex, name, "/tmp", "worker.sh", [])
    [{_, _, opts}] = Enum.filter(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end)
    spec = Jason.decode!(opts[:input])
    label = spec["label"]
    assert String.length(label) == 127
    assert hd(spec["initial_windows"])["layout"]["block"]["label"] == label
    refute Rex.worker_label(name <> "other") == label
    assert {:ok, %{"bindings" => %{^name => binding}}} = RexBindings.read()
    assert :ok = RexBindings.delete(name, binding)
    assert :present = Rex.probe(FakeRex, name)
    assert {:ok, %{"bindings" => %{^name => %{"recovered" => true}}}} = RexBindings.read()
  end

  test "bound address survives label drift and takes precedence over duplicate labels" do
    seed()
    assert :present = Rex.probe(FakeRex, @name)

    FakeRex.sessions(%{
      sid() => %{label: "human rename", blocks: blocks()},
      "session:duplicate" => %{label: @name, blocks: blocks()}
    })

    assert :present = Rex.probe(FakeRex, @name)
    assert :ok = Rex.paste(FakeRex, @name, "first\nsecond")

    [paste, submit] =
      Enum.filter(FakeRex.calls(), fn {_, args, _} ->
        "block.event" in args or "send-key" in args
      end)

    {_, args, opts} = paste
    assert sid() in args

    assert Jason.decode!(opts[:input]) == %{
             "block_id" => bid(),
             "event" => %{"type" => "paste", "payload" => %{"text" => "first\nsecond"}}
           }

    assert {_,
            [
              "--autostart=false",
              "--timeout",
              "5s",
              "send-key",
              "-s",
              session,
              "-b",
              block,
              "enter"
            ], _} = submit

    assert session == sid() and block == bid()
  end

  test "duplicate label recovery is unknown and does not bind or destroy" do
    seed()

    FakeRex.sessions(
      Map.put(FakeRex.state().sessions, "session:duplicate", %{label: @name, blocks: blocks()})
    )

    assert capture_log(fn -> assert :unknown = Rex.probe(FakeRex, @name) end) =~
             "session:duplicate"

    assert {:ok, %{"bindings" => %{}} = doc} = RexBindings.read()
    assert map_size(doc["bindings"]) == 0
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.destroy" in args end)
  end

  test "bound session disappearance prunes, but transport failures preserve bindings" do
    seed()
    assert :present = Rex.probe(FakeRex, @name)

    for {status, expected} <- [{4, :absent}, {3, :unknown}, {:timeout, :unknown}, {1, :unknown}] do
      FakeRex.reply("session.list", {"failure", status})
      assert Rex.probe(FakeRex, @name) == expected
      assert {:ok, %{"bindings" => %{@name => _}}} = RexBindings.read()
    end

    FakeRex.clear_reply("session.list")
    FakeRex.sessions(%{})
    assert :absent = Rex.probe(FakeRex, @name)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
  end

  test "missing worker block destroys an empty owned session but preserves other panes" do
    own_seed()
    assert :present = Rex.probe(FakeRex, @name)
    FakeRex.sessions(%{sid() => %{label: @name, blocks: []}})
    assert :absent = Rex.probe(FakeRex, @name)
    assert FakeRex.state().sessions == %{}
    own_seed()
    assert :present = Rex.probe(FakeRex, @name)

    FakeRex.sessions(%{
      sid() => %{label: @name, blocks: [%{"block_id" => "block:other", "label" => "human"}]}
    })

    assert :absent = Rex.probe(FakeRex, @name)
    assert Map.has_key?(FakeRex.state().sessions, sid())
  end

  test "close destroys the session and binding; paste errors never submit" do
    own_seed()
    assert :present = Rex.probe(FakeRex, @name)
    FakeRex.reply("block.event", {"timeout", 1})
    assert {:error, _} = Rex.paste(FakeRex, @name, "message")
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "send-key" in args end)
    assert :ok = Rex.close(FakeRex, @name)
    assert FakeRex.state().sessions == %{}
    assert :absent = Rex.close(FakeRex, @name)
  end

  test "lists bound names and recoverable worker labels, prunes stale bindings" do
    seed()
    assert :present = Rex.probe(FakeRex, @name)
    assert {:ok, [@name]} = Rex.list(FakeRex)
    FakeRex.sessions(%{sid() => %{label: "human rename", blocks: blocks()}})
    assert {:ok, [@name]} = Rex.list(FakeRex)
    FakeRex.sessions(%{})
    assert {:ok, []} = Rex.list(FakeRex)
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert bindings == %{}
    FakeRex.reply("session.list", {"timeout", 1})
    assert {:error, :unknown} = Rex.list(FakeRex)
    FakeRex.reply("session.list", {"server gone", 4})
    assert {:ok, []} = Rex.list(FakeRex)
  end

  test "native rename is idempotent, refuses a conflicting live label, and owns native blocks" do
    seed()
    assert :ok = Rex.rename(FakeRex, sid(), "canonical")
    assert :ok = Rex.rename(FakeRex, sid(), "canonical")
    assert :present = Rex.probe(FakeRex, "canonical")
    assert Rex.owns_pane?(FakeRex, "canonical", bid())
    refute Rex.owns_pane?(FakeRex, "canonical", "block:other")
    assert :ok = Rex.rename(FakeRex, bid(), "new-name")
    assert {:ok, %{"bindings" => bindings}} = RexBindings.read()
    assert Map.keys(bindings) == ["new-name"]

    FakeRex.sessions(
      Map.put(FakeRex.state().sessions, "session:other", %{label: "taken", blocks: blocks()})
    )

    assert {:error, :rename_failed} = Rex.rename(FakeRex, sid(), "taken")
    assert FakeRex.state().sessions[sid()].label == "new-name"
  end

  test "a canonical rename is a no-op and preserves human display labels" do
    seed()
    assert :present = Rex.probe(FakeRex, @name)
    FakeRex.sessions(%{sid() => %{label: "human display", blocks: blocks()}})
    before = FakeRex.calls()
    assert :ok = Rex.rename(FakeRex, @name, @name)
    assert FakeRex.calls() == before
    assert FakeRex.state().sessions[sid()].label == "human display"
  end

  test "multi-block native sessions refuse an arbitrary worker block" do
    seed()

    FakeRex.sessions(%{
      sid() => %{
        label: "human",
        blocks: blocks() ++ [%{"block_id" => "block:other", "label" => "other"}]
      }
    })

    assert {:error, :rename_failed} = Rex.rename(FakeRex, sid(), "canonical")
    assert :ok = Rex.rename(FakeRex, bid(), "canonical")
  end

  test "readiness starts only a positively absent server, and reveal uses the app client" do
    assert :ok = Rex.ensure_ready(FakeRex)
    FakeRex.reply("whoami", {"uncertain", 1})
    assert :ok = Rex.ensure_ready(FakeRex)
    refute Enum.any?(FakeRex.calls(), fn {bin, _, _} -> bin == "open" end)
    FakeRex.reply("whoami", {"not running", 4})
    FakeRex.reply("open", {"cannot open", 1})
    assert {:error, {:rex_server_unavailable, _}} = Rex.ensure_ready(FakeRex)
    FakeRex.clear_reply("whoami")
    FakeRex.clear_reply("open")
    seed()
    FakeRex.clients([%{"client_id" => "client:app", "info" => %{"kind" => "app"}}])
    assert :ok = Rex.reveal(@name, nil)

    assert Enum.any?(FakeRex.calls(), fn {bin, args, _} ->
             bin == "open" and args == ["-b", "com.superlogical.rex"]
           end)
  end

  test "script exports only the fixed environment, preserves quotes and targets its own native IDs" do
    Env.put_env("SHUTTLE_HOST", "host'quoted")
    Env.put_env("PATH", "/daemon/tools:/bin")
    Env.put_env("SSH_AUTH_SOCK", "/daemon/agent.sock")
    Env.put_env("SECRET_TOKEN", "never-export")
    Env.put_env("TMUX_TMPDIR", "/daemon/tmux")
    snippets = Rex.script(@name)
    assert snippets.wait_for_viewer == ""
    assert snippets.env =~ "unset TMUX TMUX_PANE"
    assert snippets.env =~ "export SHUTTLE_HOST='host'\\''quoted'"
    assert snippets.env =~ "export PATH='/daemon/tools:/bin'"
    assert snippets.env =~ "export SSH_AUTH_SOCK='/daemon/agent.sock'"
    assert snippets.env =~ "export TMUX_TMPDIR='/daemon/tmux'"
    refute snippets.env =~ "SECRET_TOKEN"
    assert snippets.submit_key =~ ~s(send-key -s "$REX_SESSION" -b "$REX_BLOCK" enter)
    refute snippets.submit_key =~ "tmux"
  end

  test "a failed PID receipt does not abort the worker under set -e", %{tmp_dir: dir} do
    File.write!(Path.join(dir, "terminals"), "not a directory")
    script = "set -e\n" <> Rex.script(@name).env <> "printf worker-starts"
    assert {output, 0} = System.cmd("/bin/bash", ["-c", script], stderr_to_stdout: true)
    assert output =~ "worker-starts"
  end

  test "binding index serializes distinct worker writes and conditional prune preserves newer values" do
    binding = %{
      "session_id" => sid(),
      "block_id" => bid(),
      "created_at" => "2026-10-29T00:00:00Z"
    }

    1..30
    |> Task.async_stream(
      fn n ->
        RexBindings.put("worker-#{n}", Map.put(binding, "session_id", "session:#{n}"), "server")
      end,
      max_concurrency: 10,
      timeout: 60_000
    )
    |> Enum.each(fn result -> assert result == {:ok, :ok} end)

    assert {:ok, snapshot} = RexBindings.read()
    assert map_size(snapshot["bindings"]) == 30
    changed = Map.put(binding, "session_id", "session:new")
    assert :ok = RexBindings.put("worker-1", changed, "server")
    assert :ok = RexBindings.prune(snapshot, [])
    assert {:ok, %{"bindings" => %{"worker-1" => ^changed}}} = RexBindings.read()
    File.write!(RexBindings.path(), "broken")
    assert {:error, :invalid_bindings} = RexBindings.put("new", binding, "server")
    assert :unknown = Rex.probe(FakeRex, @name)
    assert File.read!(RexBindings.path()) == "broken"
  end

  test "unchanged binding updates and prunes preserve the file inode" do
    own_seed()
    assert {:ok, doc} = RexBindings.read()
    assert {:ok, before} = File.stat(RexBindings.path())
    assert :ok = RexBindings.put(@name, doc["bindings"][@name], doc["server"])
    assert :ok = RexBindings.prune(doc, [sid()])
    assert :ok = RexBindings.delete("missing", %{})
    assert {:ok, after_stat} = File.stat(RexBindings.path())
    assert after_stat.inode == before.inode
  end

  test "removing bindings deletes only their unreferenced PID receipts" do
    own_seed()
    assert {:ok, doc} = RexBindings.read()
    receipt = RexBindings.pid_path(bid())
    File.mkdir_p!(Path.dirname(receipt))
    File.write!(receipt, "receipt")
    stale = Map.put(doc["bindings"][@name], "created_at", "stale")
    assert :ok = RexBindings.delete(@name, stale)
    assert File.exists?(receipt)
    assert :ok = RexBindings.delete(@name, doc["bindings"][@name])
    refute File.exists?(receipt)
    own_seed()
    File.write!(receipt, "receipt")
    assert {:ok, snapshot} = RexBindings.read()
    assert :ok = RexBindings.prune(snapshot, [])
    refute File.exists?(receipt)
  end

  test "stale ledger resolution cannot overwrite a replaced binding's fiber" do
    own_seed()
    assert {:ok, doc} = RexBindings.read()
    old = doc["bindings"][@name]
    replacement = Map.merge(old, %{"block_id" => "block:new", "fiber" => "work/new"})
    assert :ok = RexBindings.put(@name, replacement, doc["server"])
    assert :ok = RexBindings.put_fiber(@name, "work/stale", old)
    assert {:ok, %{"bindings" => %{@name => ^replacement}}} = RexBindings.read()
  end

  test "an exited worker cannot adopt or paste into a surviving human pane on later probes" do
    seed()
    assert :present = Rex.probe(FakeRex, @name)

    FakeRex.sessions(%{
      sid() => %{label: @name, blocks: [%{"block_id" => "block:human", "label" => "human"}]}
    })

    assert :absent = Rex.probe(FakeRex, @name)
    assert :absent = Rex.probe(FakeRex, @name)
    assert {:error, _} = Rex.paste(FakeRex, @name, "not for the human")
    assert :absent = Rex.close(FakeRex, @name)

    refute Enum.any?(FakeRex.calls(), fn {_, args, _} ->
             "block.event" in args or "session.destroy" in args
           end)

    assert FakeRex.state().sessions[sid()].blocks == [
             %{"block_id" => "block:human", "label" => "human"}
           ]
  end

  test "lost-binding recovery refuses a sole block whose label is not the worker's recovery index" do
    FakeRex.sessions(%{
      sid() => %{label: @name, blocks: [%{"block_id" => "block:human", "label" => "human"}]}
    })

    assert :absent = Rex.probe(FakeRex, @name)
    assert {:error, _} = Rex.paste(FakeRex, @name, "not for the human")
  end

  test "lost-binding recovery never destroys a session based on a label" do
    FakeRex.sessions(%{sid() => %{label: @name, blocks: []}})
    assert :absent = Rex.probe(FakeRex, @name)
    assert Map.has_key?(FakeRex.state().sessions, sid())
    seed()
    assert :present = Rex.probe(FakeRex, @name)
    assert {:error, message} = Rex.close(FakeRex, @name)
    assert message =~ "recovered only by block label"
    FakeRex.sessions(%{sid() => %{label: @name, blocks: []}})
    assert :absent = Rex.probe(FakeRex, @name)
    assert Map.has_key?(FakeRex.state().sessions, sid())
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.destroy" in args end)
  end

  test "rename holds launch's destination-name lock across its check and mutation" do
    seed()
    Env.put_app_env(:terminal_backend, Rex)
    parent = self()

    Env.put_app_env(:fake_rex_hook, fn
      "session.set_label" ->
        send(parent, {:rename_paused, self()})

        receive do
          :continue -> :ok
        after
          5_000 -> raise "rename test barrier timed out"
        end

      _ ->
        :ok
    end)

    rename = Task.async(fn -> Rex.rename(FakeRex, sid(), "canonical") end)
    assert_receive {:rename_paused, renamer}, 2_000

    launch =
      Task.async(fn -> Shuttle.Terminal.launch(FakeRex, "canonical", "/tmp", "sleep 30\n") end)

    assert Task.yield(launch, 100) == nil
    refute Enum.any?(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end)
    send(renamer, :continue)
    assert Task.await(rename) == :ok
    assert Task.await(launch) == {:error, :already_running}
  end

  defp own_seed do
    seed()

    RexBindings.put(
      @name,
      %{"session_id" => sid(), "block_id" => bid(), "created_at" => "2026-10-29T00:00:00Z"},
      FakeRex.fixture("whoami")["host_id"]
    )
  end

  defp seed, do: FakeRex.sessions(%{sid() => %{label: @name, blocks: blocks()}})
  defp sid, do: FakeRex.fixture("session_create")["session_id"]
  defp bid, do: hd(FakeRex.fixture("session_create")["initial_windows"])["block_ids"] |> hd()
  defp blocks, do: FakeRex.fixture("list_blocks")["blocks"]
end
