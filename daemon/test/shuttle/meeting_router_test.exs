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

defmodule Shuttle.Test.RecorderOnceClient do
  def post_once(url, body, type, timeout),
    do: Shuttle.Test.RecorderClient.post(url, body, type, timeout)

  def post(_url, _body, _type, _timeout),
    do: raise("non-replayable recorder operation used ordinary POST")
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
      {:get, "http://agent-host.example/api/v1/meeting"} => capability(~w(call phone), false),
      {:get, "http://linux-recorder.example/api/v1/meeting"} => capability(~w(phone)),
      {:get, "http://mac-recorder.example/api/v1/meeting"} => capability(~w(call))
    }
  end

  test "malformed meeting values reach validation without selector crashes" do
    for path <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"],
        meeting <- ["phone", 42, ["phone"], nil] do
      conn = post(api_conn(), path, Jason.encode!(%{meeting: meeting, fiber_id: "p/f"}))
      assert conn.status == 422
      assert Jason.decode!(conn.resp_body)["error"] =~ "meeting.mode"
    end

    assert RecorderClient.calls() == []
  end

  test "addressed stop uses non-replayable transport when it is available" do
    Env.put_app_env(:write_forward_client, Shuttle.Test.RecorderOnceClient)

    RecorderClient.set(%{
      {:post, "http://mac-recorder.example/api/v1/meeting/stop"} =>
        {:ok, 202, "{\"meeting\":null}"}
    })

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/stop",
        Jason.encode!(%{recorder: "mac-recorder", launch: "L1"})
      )

    assert conn.status == 202

    assert [{:post, _, %{"launch" => "L1", "recorder" => "mac-recorder"}, _}] =
             RecorderClient.calls()
  end

  test "normal GET is local; preferred GET selects capable remote and stamps status and row" do
    RecorderClient.set(
      Map.put(
        mac_responses(),
        {:get_file, "http://mac-recorder.example/api/v1/meeting"},
        {:ok, 200, "application/json",
         Jason.encode!(%{
           available: true,
           modes: ~w(call phone),
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
             "modes" => ["call", "phone"],
             "meeting" => %{"recorder" => "mac-recorder", "launch" => "L1"}
           } = Jason.decode!(selected.resp_body)

    assert Enum.count(RecorderClient.calls(), fn {method, _, _, _} -> method == :get end) == 3
    for {:get, url, _, _} <- RecorderClient.calls(), do: assert(URI.parse(url).query == nil)
  end

  test "phone start selects recorder once and preserves agent owner and phone mode for both entry points" do
    for {path, origin} <- [
          {"/api/v1/capture", "local"},
          {"/api/v1/meeting/join", "agent-host"},
          {"/api/v1/meeting/start", nil}
        ] do
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

      assert body["origin"] ==
               if(origin in [nil, "local"], do: MeetingRouter.own_host(), else: origin)

      assert body["recorder"] == "mac-recorder"
      assert body["recorder_forwarded"] == true
      assert body["meeting"]["mode"] == "phone"
    end
  end

  test "transport failure after POST reports uncertainty and never retries or falls back" do
    for path <- ["/api/v1/capture", "/api/v1/meeting/start"] do
      url = "http://mac-recorder.example" <> path
      RecorderClient.set(Map.put(mac_responses(), {:post, url}, {:error, :timeout}))

      conn =
        post(
          api_conn(),
          path,
          Jason.encode!(%{meeting: %{mode: "phone"}, origin: "agent-host"})
        )

      assert conn.status == 502

      assert %{"recorder" => "mac-recorder", "recording_unknown" => true, "error" => error} =
               Jason.decode!(conn.resp_body)

      assert error =~ "Inspect that recorder before retrying"

      assert [{:post, ^url, _, _}] =
               Enum.filter(RecorderClient.calls(), fn {method, _, _, _} -> method == :post end)
    end
  end

  # Mutation control: drop expand_own_transcript/2, or expand regardless of origin.
  @tag :tmp_dir
  test "a record-only start forwards to the named recorder and answers the path on this host", %{
    tmp_dir: tmp_dir
  } do
    own = MeetingRouter.own_host()
    Env.put_env("HOME", tmp_dir)
    url = "http://mac-recorder.example/api/v1/meeting/start"

    answer = fn origin ->
      {:ok, 200,
       Jason.encode!(%{
         origin: origin,
         transcript: "~/.hark/meetings/2026-09-25_1403_standup.txt",
         meeting: %{launch: "L1", state: "live"}
       })}
    end

    RecorderClient.set(%{{:post, url} => answer.(own)})

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/start",
        Jason.encode!(%{recorder: "mac-recorder", meeting: %{mode: "call"}, note: "Standup"})
      )

    assert conn.status == 200

    assert %{
             "recorder" => "mac-recorder",
             "origin" => ^own,
             "transcript" => transcript,
             "meeting" => %{"recorder" => "mac-recorder", "launch" => "L1"}
           } = Jason.decode!(conn.resp_body)

    assert transcript == Path.join(tmp_dir, ".hark/meetings/2026-09-25_1403_standup.txt")

    # One write, to the named recorder, carrying this host as the origin;
    # nothing is probed, captured or delivered.
    assert [{:post, ^url, body, _}] = RecorderClient.calls()
    assert body["origin"] == own
    assert body["recorder_forwarded"] == true
    assert body["note"] == "Standup"

    # A path on some other origin is not this host's to expand.
    RecorderClient.set(%{{:post, url} => answer.("agent-host")})

    conn =
      post(
        api_conn(),
        "/api/v1/meeting/start",
        Jason.encode!(%{recorder: "mac-recorder", origin: "agent-host", meeting: %{mode: "call"}})
      )

    assert %{"origin" => "agent-host", "transcript" => "~/.hark/meetings/" <> _} =
             Jason.decode!(conn.resp_body)
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
    for path <- ["/api/v1/capture", "/api/v1/meeting/join", "/api/v1/meeting/start"] do
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
