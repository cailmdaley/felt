defmodule ShuttleWeb.CarriedDocumentTest do
  @moduledoc """
  A remote resume (`/api/v1/lifecycle`) or dispatch (`/api/v1/dispatch`) that
  carries the caller's `document`: the owner runs `shuttle adopt` on it before
  the verb, surfaces adopt's line, and stops when adopt refuses.
  """

  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  @document "---\nname: Carried\nshuttle:\n  kind: oneshot\n  host: test-host\n---\n\nThe caller's body\n"

  # Stands in for the Poller: runs lifecycle writes through the real writer
  # (which shells the fake shuttle) and reports each call to the test, so the
  # order of adopt and dispatch is observable.
  defmodule FakePoller do
    use GenServer
    def start_link(test), do: GenServer.start_link(__MODULE__, test)
    @impl true
    def init(test), do: {:ok, test}

    @impl true
    def handle_call({:lifecycle_transition, verb, target, args}, _from, test) do
      send(test, {:poller, :lifecycle, verb})

      result =
        Shuttle.LifecycleService.write(verb, target.uid || target.fiber_id,
          felt_store: target.store,
          args: args ++ Shuttle.LifecycleService.hint_args(target)
        )

      {:reply, result, test}
    end

    def handle_call({:dispatch, fiber_id, _opts}, _from, test) do
      send(test, {:poller, :dispatch, fiber_id})
      {:reply, {:ok, "fake-session"}, test}
    end

    def handle_call(_message, _from, test), do: {:reply, :ok, test}
  end

  describe "lifecycle resume" do
    test "without a document runs only the resume" do
      store = fixture_store!()
      log = install_fake_cli!()

      conn = post_json("/api/v1/lifecycle", %{"action" => "resume", "fiber" => "tests/carry"})

      assert conn.status == 200
      assert conn.resp_body == "resumed\n"

      assert File.read!(log) ==
               "-C\n#{store}\nresume\ntests/carry\n--fiber-path\ntests/carry\n--local\n"
    end

    test "adopts the carried document before resuming and prints adopt's line first" do
      store = fixture_store!()
      log = install_fake_cli!()

      conn =
        post_json("/api/v1/lifecycle", %{
          "action" => "resume",
          "fiber" => "tests/carry",
          "document" => @document,
          "carry" => true
        })

      assert conn.status == 200
      assert conn.resp_body == "test-host took the caller's version\nresumed\n"

      document_file = File.read!(log <> ".path") |> String.trim()

      assert File.read!(log) ==
               "-C\n#{store}\nadopt\ntests/carry\n--document-file\n#{document_file}\n--carry\n" <>
                 "--fiber-path\ntests/carry\n" <>
                 "-C\n#{store}\nresume\ntests/carry\n--fiber-path\ntests/carry\n--local\n"

      assert File.read!(log <> ".doc") == @document
      refute File.exists?(document_file)
    end

    test "an adopt refusal stops the resume" do
      fixture_store!()
      log = install_fake_cli!()
      Shuttle.Test.Env.put_env("ADOPT_FAIL", "1")

      conn =
        post_json("/api/v1/lifecycle", %{
          "action" => "resume",
          "fiber" => "tests/carry",
          "document" => @document
        })

      assert conn.status == 422
      assert conn.resp_body =~ "refused"
      refute File.read!(log) =~ "resume"
    end

    test "a resume refused after the adopt still carries adopt's line" do
      fixture_store!()
      install_fake_cli!()
      Shuttle.Test.Env.put_env("RESUME_FAIL", "1")

      conn =
        post_json("/api/v1/lifecycle", %{
          "action" => "resume",
          "fiber" => "tests/carry",
          "document" => @document
        })

      assert conn.status == 422
      assert conn.resp_body =~ "test-host took the caller's version"
      assert conn.resp_body =~ "closed"
    end

    test "a fiber this host lacks answers fiber_not_found" do
      fixture_store!()
      log = install_fake_cli!()

      conn =
        post_json("/api/v1/lifecycle", %{
          "action" => "resume",
          "fiber" => "tests/absent",
          "document" => @document
        })

      assert %{"error_code" => "fiber_not_found", "fiber" => "tests/absent"} =
               json_response(conn, 404)

      refute File.exists?(log)
    end
  end

  describe "dispatch" do
    setup do
      {:ok, poller} = FakePoller.start_link(self())
      Shuttle.Test.Env.put_server(Shuttle.Poller, poller)
      :ok
    end

    test "without a document dispatches without adopting" do
      fixture_store!()
      log = install_fake_cli!()

      conn = post_json("/api/v1/dispatch", %{"fiber_id" => "tests/carry"})

      body = json_response(conn, 200)
      assert body["dispatched"] == true
      refute Map.has_key?(body, "carried")
      assert_received {:poller, :dispatch, "tests/carry"}
      refute_received {:poller, :lifecycle, _}
      refute File.exists?(log)
    end

    test "adopts the carried document before dispatching and returns adopt's line" do
      store = fixture_store!()
      log = install_fake_cli!()

      conn =
        post_json("/api/v1/dispatch", %{
          "fiber_id" => "tests/carry",
          "fiber_path" => "tests/carry",
          "document" => @document
        })

      body = json_response(conn, 200)
      assert body["dispatched"] == true
      assert body["carried"] == "test-host took the caller's version"
      Shuttle.Test.ApiContract.assert_contract(conn, "/dispatch")

      {:messages, messages} = Process.info(self(), :messages)

      assert for({:poller, _, _} = call <- messages, do: call) == [
               {:poller, :lifecycle, :adopt},
               {:poller, :dispatch, "tests/carry"}
             ]

      document_file = File.read!(log <> ".path") |> String.trim()

      assert File.read!(log) ==
               "-C\n#{store}\nadopt\ntests/carry\n--document-file\n#{document_file}\n" <>
                 "--fiber-path\ntests/carry\n"

      assert File.read!(log <> ".doc") == @document
      refute File.exists?(document_file)
    end

    test "an adopt refusal answers 422 without dispatching" do
      fixture_store!()
      install_fake_cli!()
      Shuttle.Test.Env.put_env("ADOPT_FAIL", "1")

      conn =
        post_json("/api/v1/dispatch", %{"fiber_id" => "tests/carry", "document" => @document})

      assert %{"dispatched" => false, "reason" => "adopt_refused", "error" => error} =
               json_response(conn, 422)

      assert error =~ "refused"
      Shuttle.Test.ApiContract.assert_contract(conn, "/dispatch")
      assert_received {:poller, :lifecycle, :adopt}
      refute_received {:poller, :dispatch, _}
    end

    test "a carried request for a fiber this host lacks answers fiber_not_found" do
      fixture_store!()
      install_fake_cli!()

      conn =
        post_json("/api/v1/dispatch", %{"fiber_id" => "tests/absent", "document" => @document})

      assert %{"error_code" => "fiber_not_found", "fiber" => "tests/absent", "host" => host} =
               json_response(conn, 404)

      assert is_binary(host)
      Shuttle.Test.ApiContract.assert_contract(conn, "/dispatch")
      refute_received {:poller, _, _}
    end
  end

  defp post_json(path, body), do: post(api_conn(), path, Jason.encode!(body))

  # The fake shuttle appends each invocation's argv to the log; for adopt it
  # also saves the document file's path and content, and refuses when
  # ADOPT_FAIL is set.
  defp install_fake_cli! do
    log =
      Path.join(System.tmp_dir!(), "shuttle-carried-args-#{System.unique_integer([:positive])}")

    real_felt = Shuttle.Test.FakeCli.real!("felt")

    Shuttle.Test.FakeCli.install!(%{
      "felt" => """
      #!/bin/sh
      exec "#{real_felt}" "$@"
      """,
      "shuttle" => """
      #!/bin/sh
      printf '%s\\n' "$@" >> "$SHUTTLE_ARGS_FILE"
      if [ "$3" = adopt ]; then
        printf '%s\\n' "$6" > "$SHUTTLE_ARGS_FILE.path"
        cat "$6" > "$SHUTTLE_ARGS_FILE.doc"
        if [ -n "$ADOPT_FAIL" ]; then printf 'Error: refused\\n'; exit 1; fi
        printf "test-host took the caller's version\\n"
        exit 0
      fi
      if [ -n "$RESUME_FAIL" ]; then printf 'Error: closed\\n'; exit 1; fi
      printf 'resumed\\n'
      """
    })

    Shuttle.Test.Env.put_env("SHUTTLE_ARGS_FILE", log)
    on_exit(fn -> Enum.each(["", ".path", ".doc"], &File.rm(log <> &1)) end)
    log
  end

  defp fixture_store! do
    root = Path.join(System.tmp_dir!(), "shuttle-carried-#{System.unique_integer([:positive])}")
    store = Path.join(root, "loom")
    dir = Path.join([store, ".felt", "tests", "carry"])
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "carry.md"), "---\nname: Carry\n---\n\n")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", store)
    on_exit(fn -> File.rm_rf(root) end)
    store
  end
end
