defmodule ShuttleWeb.ConfigControllerTest do
  @moduledoc """
  `/api/v1/config` — the operator files over HTTP, reads included.

  Every test points ALL FIVE `*_FILE` env vars at throwaway paths and clears the
  compact `SHUTTLE_STORES` / `SHUTTLE_PROJECTS` forms, so no request here can reach
  the developer's real `~/.config/shuttle/` — nor the fixtures `test_helper.exs`
  pins the agents and remotes files at.

  The write cases use `stores`, whose grammar `Shuttle.ConfigFiles` owns
  outright: no felt shell-out is involved, so what these assert is the
  controller's own contract (status codes, the echoed state, the verbatim
  refusal) rather than a mocked CLI's.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  alias Shuttle.ConfigFiles
  alias Shuttle.Test.{Env, ForwardStub, StubGetFileClient, StubPostClient}

  @endpoint ShuttleWeb.Endpoint

  @file_vars [
    stores: "SHUTTLE_STORES_FILE",
    projects: "SHUTTLE_PROJECTS_FILE",
    agents: "SHUTTLE_AGENTS_FILE",
    remotes: "SHUTTLE_REMOTES_FILE",
    host: "SHUTTLE_HOST_CONFIG_FILE"
  ]

  @compact_vars ["SHUTTLE_STORES", "SHUTTLE_PROJECTS"]

  @stores_doc ~s({"version":1,"felt_stores":["/tmp/one","/tmp/two"]})

  setup do
    dir =
      Path.join(System.tmp_dir!(), "shuttle-config-ctrl-#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)

    paths =
      Map.new(@file_vars, fn {id, var} ->
        path = Path.join(dir, "#{id}.json")
        Env.put_env(var, path)
        {id, Path.expand(path)}
      end)

    Enum.each(@compact_vars, &Env.delete_env/1)
    Env.put_app_env(:remotes, [])

    on_exit(fn ->
      File.rm_rf(dir)
    end)

    {:ok, paths: paths}
  end

  describe "GET /api/v1/config" do
    test "lists the five files and the paths they resolve to", %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)

      conn = get(api_conn(), "/api/v1/config")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["host"] == Shuttle.Poller.own_host_id()

      assert Enum.map(body["files"], & &1["id"]) == [
               "stores",
               "projects",
               "agents",
               "remotes",
               "host"
             ]

      assert Enum.map(body["files"], & &1["path"]) == Enum.map(ConfigFiles.ids(), &paths[&1])
      assert Enum.map(body["files"], & &1["exists"]) == [true, false, false, false, false]

      [stores | _] = body["files"]
      assert stores["size"] == byte_size(@stores_doc)
      assert is_integer(stores["updated_at"])
      assert stores["digest"] == ConfigFiles.digest(:stores)
    end
  end

  describe "GET /api/v1/config/:id" do
    test "returns the file's bytes alongside its summary row", %{paths: paths} do
      File.write!(paths[:remotes], @stores_doc)

      conn = get(api_conn(), "/api/v1/config/remotes")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["id"] == "remotes"
      assert body["text"] == @stores_doc
      assert body["path"] == paths[:remotes]
      assert body["exists"] == true
      assert body["host"] == Shuttle.Poller.own_host_id()
    end

    test "an absent file opens on a blank page, not a refusal" do
      conn = get(api_conn(), "/api/v1/config/agents")

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["text"] == ""
      assert body["exists"] == false
      assert body["digest"] == nil
    end

    test "an unknown id is a 400 naming the ids it does know" do
      conn = get(api_conn(), "/api/v1/config/hosts")

      assert conn.status == 400
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == false
      assert body["error"] =~ ~s(unknown config file "hosts")
      assert body["error"] =~ "stores, projects, agents, remotes"
    end
  end

  describe "POST /api/v1/config/:id" do
    test "valid text is written, and the new state comes back", %{paths: paths} do
      conn = post_config("stores", %{"text" => @stores_doc})

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == true
      assert body["host"] == Shuttle.Poller.own_host_id()
      assert body["text"] == @stores_doc
      assert body["exists"] == true
      assert body["size"] == byte_size(@stores_doc)
      assert body["digest"] == ConfigFiles.digest(:stores)

      assert File.read!(paths[:stores]) == @stores_doc
    end

    test "whitespace-only text removes the file", %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)

      conn = post_config("stores", %{"text" => "\n"})

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["exists"] == false
      refute File.exists?(paths[:stores])
    end

    test "a refused edit is a 400 carrying the validator's message verbatim", %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)
      candidate = ~s({"felt_stores":["/tmp/one",42]})

      conn = post_config("stores", %{"text" => candidate})

      assert conn.status == 400
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == false

      # Verbatim, not paraphrased: the same sentence `ConfigFiles` refuses with.
      assert {:error, message} = ConfigFiles.validate(:stores, candidate)
      assert body["error"] == message

      assert File.read!(paths[:stores]) == @stores_doc
    end

    test "an unknown id is a 400 before anything is written" do
      conn = post_config("hosts", %{"text" => @stores_doc})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "unknown config file"
    end

    test "a body with no text is a 400 saying what to send" do
      conn = post_config("stores", %{})

      assert conn.status == 400
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == false
      assert body["error"] =~ "text is required"
    end

    test "a non-string text is the same 400 — the file is bytes, not a structure" do
      conn = post_config("stores", %{"text" => ["/tmp/one"]})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "text is required"
    end
  end

  describe "POST /api/v1/config/:id with expected_digest" do
    setup %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)
      {:ok, digest: ConfigFiles.digest(:stores)}
    end

    # Every file state against every precondition. An ABSENT key is
    # last-write-wins: a script, or an older client. A PRESENT null means "I
    # read no file", so it writes only where there is still none.
    #
    # A refusal is a 409, not a 400, and the distinction is load-bearing rather
    # than pedantic: the editor's recovery affordance keys off the STATUS, so
    # that it survives a rewording of the sentence. While this answered 400 the
    # button that offers to re-read the file never rendered at all — and
    # nothing went red, because the only thing that knew was prose.
    test "a write commits only when its precondition matches the file as it is now", %{
      paths: paths,
      digest: digest
    } do
      stale = String.duplicate("0", 64)
      changed = "changed since you opened it"
      deleted = "was deleted since you opened it"

      rows = [
        {:present, :omit, :commits},
        {:present, digest, :commits},
        {:present, stale, changed},
        {:present, nil, changed},
        {:absent, :omit, :commits},
        {:absent, nil, :commits},
        {:absent, digest, deleted},
        {:absent, stale, deleted}
      ]

      for {file, expected, outcome} <- rows do
        label = "#{file} file, expected_digest #{inspect(expected)}"

        if file == :present,
          do: File.write!(paths[:stores], @stores_doc),
          else: File.rm(paths[:stores])

        payload =
          if expected == :omit,
            do: %{"text" => "[]"},
            else: %{"text" => "[]", "expected_digest" => expected}

        conn = post_config("stores", payload)

        if outcome == :commits do
          assert conn.status == 200, label
          assert File.read!(paths[:stores]) == "[]", label
        else
          assert conn.status == 409, label
          body = Jason.decode!(conn.resp_body)
          assert body["conflict"] == true, label
          assert body["error"] =~ outcome, label

          if file == :present,
            do: assert(File.read!(paths[:stores]) == @stores_doc, label),
            else: refute(File.exists?(paths[:stores]), label)
        end
      end
    end
  end

  # ── Owner routing ────────────────────────────────────────────────────────
  #
  # A config file describes the host whose daemon reads it, so even the READS
  # forward. Both legs are stubbed at `:write_forward_client`: the GETs go
  # through `forward_get` (the byte transport), the POST through `forward`.

  describe "owner routing" do
    test "the index forwards to the named remote and relays its body verbatim" do
      remote_body = Jason.encode!(%{"host" => "candide", "files" => []})

      ForwardStub.stub_forward(
        "candide",
        "http://candide.example:4000",
        {:ok, 200, "application/json", remote_body}
      )

      conn = get(api_conn(), "/api/v1/config?origin=candide")

      assert conn.status == 200
      assert conn.resp_body == remote_body
      assert StubGetFileClient.last().url =~ "http://candide.example:4000/api/v1/config?"
      # The owner serves it as local — its own origin is stripped on the way.
      refute StubGetFileClient.last().url =~ "origin"
    end

    test "a single file's read forwards, dropping the path's :id from the query" do
      remote_body = Jason.encode!(%{"host" => "candide", "id" => "remotes", "text" => "{}"})

      ForwardStub.stub_forward(
        "candide",
        "http://candide.example:4000",
        {:ok, 200, "application/json", remote_body}
      )

      conn = get(api_conn(), "/api/v1/config/remotes?origin=candide")

      assert conn.status == 200
      assert conn.resp_body == remote_body

      url = StubGetFileClient.last().url
      assert url =~ "http://candide.example:4000/api/v1/config/remotes?"
      refute url =~ "id="
      refute url =~ "origin"
    end

    test "a write forwards, and the owner's status and body come back unchanged", %{paths: paths} do
      refusal = Jason.encode!(%{"ok" => false, "error" => ~s(remote "hub-a": port 4001 in use)})

      ForwardStub.stub_forward(
        "candide",
        "http://candide.example:4000",
        {:ok, 400, refusal},
        StubPostClient
      )

      conn = post_config("remotes", %{"text" => "{}", "origin" => "candide"})

      assert conn.status == 400
      assert conn.resp_body == refusal

      last = StubPostClient.last()
      assert last.url == "http://candide.example:4000/api/v1/config/remotes"
      assert Jason.decode!(last.body) == %{"id" => "remotes", "text" => "{}"}

      # Nothing local was touched on the way through.
      refute File.exists?(paths[:remotes])
    end

    test "a tunnel failure on the write leg is a 502 naming the remote" do
      ForwardStub.stub_forward(
        "candide",
        "http://candide.example:4000",
        {:error, :econnrefused},
        StubPostClient
      )

      conn = post_config("remotes", %{"text" => "{}", "origin" => "candide"})

      assert conn.status == 502
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == false
      assert body["error"] =~ "forward to candide failed"
    end

    test "an origin naming this daemon is served locally", %{paths: paths} do
      own = Shuttle.Poller.own_host_id()

      conn = post_config("stores", %{"text" => @stores_doc, "origin" => own})

      assert conn.status == 200
      assert File.read!(paths[:stores]) == @stores_doc
    end
  end

  defp post_config(id, payload) do
    post(api_conn(), "/api/v1/config/#{id}", Jason.encode!(payload))
  end
end
