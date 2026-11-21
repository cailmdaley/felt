defmodule ShuttleWeb.GoControllerTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  alias Shuttle.Test.{Env, FakeRex}
  alias Shuttle.Terminal.Rex
  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir
  @name "probe-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"

  defmodule Opener do
    def open(name, host) do
      send(Shuttle.Env.app(:go_test), {:opened, name, host})
      Shuttle.Env.app(:open_result, :ok)
    end
  end

  defmodule Forward do
    def post(url, body, _, _) do
      send(Shuttle.Env.app(:go_test), {:forward, url, Jason.decode!(body)})
      Shuttle.Env.app(:forward_response, {:ok, 200, ~s({"went":true,"place":"live"})})
    end
  end

  setup %{tmp_dir: dir} do
    # SHUTTLE_STORES is a list: a store path of its own, free of the test name's punctuation.
    store = Path.join(System.tmp_dir!(), "shuttle-go-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(store) end)

    for {id, frontmatter} <- [
          {"live", "status: active"},
          {"quiet", "status: active"},
          {"kept", "status: closed\ntempered: true"},
          {"dropped", "status: closed\ntempered: false"}
        ] do
      path = Path.join(store, ".felt/#{id}/#{id}.md")
      File.mkdir_p!(Path.dirname(path))

      File.write!(
        path,
        "---\nname: #{id}\n#{frontmatter}\nshuttle:\n  kind: oneshot\n  host: test-host\n---\n"
      )
    end

    Env.put_env("SHUTTLE_STORES", store)
    Env.put_env("SHUTTLE_DATA_DIR", dir)
    Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
    Env.put_app_env(:own_host_id, "test-host")
    Env.put_app_env(:fake_rex, start_supervised!({FakeRex, []}))
    Env.put_app_env(:rex_runner, FakeRex)
    Env.put_app_env(:terminal_backend, Rex)
    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_app_env(:opener_impl, Opener)
    Env.put_app_env(:write_forward_client, Forward)
    Env.put_app_env(:go_test, self())
    Env.put_app_env(:remotes, [%{name: "remote-a", url: "http://worker.example.test:4000"}])

    Env.put_app_env(:go_live_worker, fn
      "live" -> %{session: @name}
      _ -> nil
    end)

    FakeRex.clients([
      %{"client_id" => "client:phone", "info" => %{"kind" => "app", "platform" => "ios"}},
      %{"client_id" => "client:mac", "info" => %{"kind" => "app", "platform" => "macos"}}
    ])

    :ok
  end

  defp go(body), do: post(api_conn(), "/api/v1/go", Jason.encode!(body))

  defp requests(method),
    do: for({_, _, opts} <- FakeRex.calls(), r = decoded(opts), r && r["method"] == method, do: r)

  defp decoded(opts) do
    case opts[:input] && Jason.decode(opts[:input]) do
      {:ok, %{"action" => _} = args} -> %{"method" => "client.perform", "args" => args}
      _ -> nil
    end
  end

  defp activated?,
    do: Enum.any?(FakeRex.calls(), &match?({"open", ["-b", "com.superlogical.rex"], _}, &1))

  test "a live Rex worker's window is selected in the Mac's app, which comes forward" do
    assert :ok = Rex.launch(FakeRex, @name, "/tmp", "worker.sh", [])

    assert %{"went" => true, "place" => "live"} =
             go(%{fiber_id: "live", origin: "test-host"}) |> json_response(200)

    [window] = FakeRex.fixture("session_create")["initial_windows"]

    assert [
             %{
               "args" => %{
                 "client_id" => "client:mac",
                 "action" => "session.select",
                 "args" => args
               }
             }
           ] = requests("client.perform")

    assert args["window_id"] == window["window_id"]
    assert activated?()
  end

  test "an owner's leg selects without bringing its app forward" do
    assert :ok = Rex.launch(FakeRex, @name, "/tmp", "worker.sh", [])
    assert %{"went" => true} = go(%{fiber_id: "live", forwarded: true}) |> json_response(200)
    assert [_] = requests("client.perform")
    refute activated?()
  end

  test "a fiber with no live worker goes nowhere, and nothing is started" do
    assert %{"went" => false, "place" => "none"} = go(%{fiber_id: "quiet"}) |> json_response(200)
    # Its worker named but without a terminal is no better.
    assert %{"went" => false, "place" => "none"} = go(%{fiber_id: "live"}) |> json_response(200)
    assert requests("client.perform") == []
    refute Enum.any?(FakeRex.calls(), fn {_, argv, _} -> "session.create" in argv end)
    refute_received {:opened, _, _}
  end

  test "a tmux worker opens as today's viewer here, and is named to the hub from an owner's leg" do
    FakeRex.reply("tmux", {"", 0})
    assert %{"went" => true, "place" => "live"} = go(%{fiber_id: "live"}) |> json_response(200)
    assert_received {:opened, @name, nil}

    assert %{"went" => false, "tmux_session" => @name} =
             go(%{fiber_id: "live", forwarded: true}) |> json_response(200)

    refute_received {:opened, _, _}
  end

  test "tempered and discarded fibers are refused; an unknown one is not found" do
    for id <- ["kept", "dropped"] do
      assert %{"went" => false, "error" => error} = go(%{fiber_id: id}) |> json_response(422)
      assert error =~ if(id == "kept", do: "tempered", else: "discarded")
    end

    assert %{"error" => "not_found"} = go(%{fiber_id: "nowhere"}) |> json_response(404)
  end

  test "a remote owner's go is forwarded to it, and the Mac's Rex app comes forward after it moves" do
    assert %{"went" => true, "place" => "live"} =
             go(%{fiber_id: "far", origin: "remote-a"}) |> json_response(200)

    assert_received {:forward, "http://worker.example.test:4000/api/v1/go",
                     %{"fiber_id" => "far", "forwarded" => true} = body}

    refute Map.has_key?(body, "origin")
    assert activated?()
  end

  test "a remote tmux worker opens here; a remote that moved nothing brings no app forward; its refusal is relayed" do
    Env.put_app_env(
      :forward_response,
      {:ok, 200, ~s({"went":false,"place":"none","tmux_session":"far-w"})}
    )

    assert %{"went" => true} = go(%{fiber_id: "far", origin: "remote-a"}) |> json_response(200)
    assert_received {:opened, "far-w", "remote-a"}

    Env.put_app_env(:forward_response, {:ok, 200, ~s({"went":false,"place":"none"})})

    assert %{"went" => false, "place" => "none"} =
             go(%{fiber_id: "far", origin: "remote-a"}) |> json_response(200)

    refute activated?()

    Env.put_app_env(
      :forward_response,
      {:ok, 422, ~s({"went":false,"error":"the fiber is tempered"})}
    )

    assert %{"error" => "the fiber is tempered"} =
             go(%{fiber_id: "far", origin: "remote-a"}) |> json_response(422)

    Env.put_app_env(:forward_response, {:error, :econnrefused})
    assert %{"error" => error} = go(%{fiber_id: "far", origin: "remote-a"}) |> json_response(502)
    assert error =~ "remote-a"
  end

  test "an unknown origin is refused before any local read; a body without a fiber is a 400" do
    assert %{"error" => error} =
             go(%{fiber_id: "live", origin: "missing-owner"}) |> json_response(400)

    assert error =~ ~s(unknown origin "missing-owner")
    assert FakeRex.calls() == []
    assert %{"error" => "fiber_id is required"} = go(%{origin: "test-host"}) |> json_response(400)
  end
end
