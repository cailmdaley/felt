defmodule Shuttle.Test.RecorderClient do
  use Agent
  def start_link(_), do: Agent.start_link(fn -> %{responses: %{}, calls: []} end)
  defp server, do: Shuttle.Test.Env.server!(__MODULE__)
  def set(responses), do: Agent.update(server(), &%{&1 | responses: responses, calls: []})
  def calls, do: Agent.get(server(), &Enum.reverse(&1.calls))
  def get(url, timeout), do: request(:get, url, nil, timeout)
  def get_file(url, timeout), do: request(:get_file, url, nil, timeout)
  def post(url, body, _type, timeout), do: request(:post, url, Jason.decode!(body), timeout)

  defp request(method, url, body, timeout) do
    response =
      Agent.get_and_update(server(), fn state ->
        {Map.get(state.responses, {method, url}, {:error, :unreachable}),
         %{state | calls: [{method, url, body, timeout} | state.calls]}}
      end)

    case response do
      {:wait, pid} ->
        send(pid, {:probe_started, url})

        receive do
          :never -> {:error, :unreachable}
        end

      response ->
        response
    end
  end
end

defmodule Shuttle.MeetingRouterTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  alias Shuttle.{MeetingRouter, Remote}
  alias Shuttle.Test.{Env, RecorderClient}
  @endpoint ShuttleWeb.Endpoint

  setup do
    Env.start_scoped!(RecorderClient)
    Env.put_app_env(:write_forward_client, RecorderClient)
    Env.put_app_env(:hark_path, false)

    remotes =
      for name <- ~w(agent-host linux-recorder mac-recorder),
          do: %Remote{name: name, url: "http://#{name}.example"}

    Env.put_app_env(:remotes, remotes)
    %{remotes: remotes}
  end

  defp capability(modes, available \\ true),
    do: {:ok, Jason.encode!(%{available: available, modes: modes, meeting: nil})}

  defp mac_responses do
    %{
      {:get, "http://agent-host.example/api/v1/meeting"} =>
        capability(~w(call room phone), false),
      {:get, "http://linux-recorder.example/api/v1/meeting"} => capability(~w(phone)),
      {:get, "http://mac-recorder.example/api/v1/meeting"} => capability(~w(call room phone))
    }
  end

  test "normal GET is local; preferred GET selects capable remote and stamps status and row" do
    RecorderClient.set(
      Map.put(
        mac_responses(),
        {:get_file, "http://mac-recorder.example/api/v1/meeting"},
        {:ok, 200, "application/json",
         Jason.encode!(%{
           available: true,
           modes: ~w(call room phone),
           meeting: %{launch: "L1", phone: true}
         })}
      )
    )

    local = get(api_conn(), "/api/v1/meeting")
    assert %{"available" => false, "recorder" => own} = Jason.decode!(local.resp_body)
    assert own == MeetingRouter.own_host()
    assert RecorderClient.calls() == []
    selected = get(api_conn(), "/api/v1/meeting?prefer=phone")

    assert %{
             "recorder" => "mac-recorder",
             "available" => true,
             "modes" => ["call", "room", "phone"],
             "meeting" => %{"recorder" => "mac-recorder", "launch" => "L1"}
           } = Jason.decode!(selected.resp_body)

    assert Enum.count(RecorderClient.calls(), fn {method, _, _, _} -> method == :get end) == 3
    for {:get, url, _, _} <- RecorderClient.calls(), do: assert(URI.parse(url).query == nil)
  end

  test "phone start selects recorder once and preserves agent owner and phone mode for both entry points" do
    for {path, origin} <- [{"/api/v1/capture", "local"}, {"/api/v1/meeting/join", "agent-host"}] do
      RecorderClient.set(
        Map.put(
          mac_responses(),
          {:post, "http://mac-recorder.example" <> path},
          {:ok, 202, Jason.encode!(%{meeting: %{launch: "L1", phone: true}})}
        )
      )

      conn =
        post(
          api_conn(),
          path,
          Jason.encode!(%{
            meeting: %{mode: "phone"},
            origin: origin,
            prompt: "hello",
            note: "hello",
            fiber_id: "p/f",
            project_dir: "/p"
          })
        )

      assert conn.status == 202

      assert %{
               "recorder" => "mac-recorder",
               "meeting" => %{"recorder" => "mac-recorder", "phone" => true}
             } = Jason.decode!(conn.resp_body)

      assert [{:post, _, body, _}] =
               Enum.filter(RecorderClient.calls(), fn {method, _, _, _} -> method == :post end)

      assert body["origin"] == if(origin == "local", do: MeetingRouter.own_host(), else: origin)
      assert body["recorder"] == "mac-recorder"
      assert body["recorder_forwarded"] == true
      assert body["meeting"]["mode"] == "phone"
    end
  end

  test "transport failure after POST reports uncertainty and never retries or falls back" do
    RecorderClient.set(
      Map.put(
        mac_responses(),
        {:post, "http://mac-recorder.example/api/v1/capture"},
        {:error, :timeout}
      )
    )

    conn =
      post(
        api_conn(),
        "/api/v1/capture",
        Jason.encode!(%{meeting: %{mode: "phone"}, origin: "agent-host"})
      )

    assert conn.status == 502

    assert %{"recorder" => "mac-recorder", "recording_unknown" => true, "error" => error} =
             Jason.decode!(conn.resp_body)

    assert error =~ "Inspect that recorder before retrying"

    assert [{:post, "http://mac-recorder.example/api/v1/capture", _, _}] =
             Enum.filter(RecorderClient.calls(), fn {method, _, _, _} -> method == :post end)
  end

  test "pinned show and stop do not reselect; addressed stop requires launch and forwards it intact" do
    RecorderClient.set(%{
      {:get_file, "http://linux-recorder.example/api/v1/meeting"} =>
        {:ok, 200, "application/json", "{\"meeting\":null}"},
      {:post, "http://linux-recorder.example/api/v1/meeting/stop"} =>
        {:ok, 409, "{\"error\":\"stale\"}"}
    })

    conn = get(api_conn(), "/api/v1/meeting?recorder=linux-recorder&prefer=phone")
    assert %{"recorder" => "linux-recorder", "meeting" => nil} = Jason.decode!(conn.resp_body)

    assert post(api_conn(), "/api/v1/meeting/stop", Jason.encode!(%{recorder: "linux-recorder"})).status ==
             422

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/stop",
        Jason.encode!(%{recorder: "linux-recorder", launch: "old"})
      )

    assert conn.status == 409

    assert [
             {:get_file, _, _, _},
             {:post, _, %{"launch" => "old", "recorder_forwarded" => true}, _}
           ] = RecorderClient.calls()
  end

  test "unreachable and non-device remotes fall back only during selection" do
    RecorderClient.set(%{
      {:get, "http://mac-recorder.example/api/v1/meeting"} => capability(~w(phone))
    })

    assert {:ok, :local} = MeetingRouter.select_start(%{"meeting" => %{"mode" => "phone"}})
    assert Enum.all?(RecorderClient.calls(), fn {method, _, _, _} -> method == :get end)
  end

  @tag :timing
  test "probes start in parallel and the whole round is bounded", %{remotes: remotes} do
    RecorderClient.set(
      Map.new(remotes, &{{:get, Remote.url_for(&1, "/api/v1/meeting")}, {:wait, self()}})
    )

    task = Task.async(fn -> MeetingRouter.select(%{"prefer" => "phone"}, probe_ms: 100) end)

    for remote <- remotes do
      url = Remote.url_for(remote, "/api/v1/meeting")
      assert_receive {:probe_started, ^url}, 1_000
    end

    assert {:ok, :local} = Task.await(task, 2_000)
  end

  test "forwarded wrong target is refused without probes or mutation; explicit local avoids recursion" do
    for path <- ["/api/v1/capture", "/api/v1/meeting/join"] do
      conn =
        post(
          api_conn(),
          path,
          Jason.encode!(%{
            meeting: %{mode: "phone"},
            recorder: "mac-recorder",
            recorder_forwarded: true
          })
        )

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] =~ "does not name this host"
    end

    assert RecorderClient.calls() == []

    conn =
      post(
        api_conn(),
        "/api/v1/capture",
        Jason.encode!(%{
          meeting: %{mode: "phone"},
          recorder: MeetingRouter.own_host(),
          recorder_forwarded: true
        })
      )

    assert conn.status == 503
    assert RecorderClient.calls() == []
  end
end
