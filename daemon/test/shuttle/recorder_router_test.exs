defmodule Shuttle.Test.RecorderClient do
  use Agent
  def start_link(_), do: Agent.start_link(fn -> %{responses: %{}, calls: []} end)
  defp server, do: Shuttle.Test.Env.server!(__MODULE__)
  def set(responses), do: Agent.update(server(), &%{&1 | responses: responses, calls: []})
  def calls, do: Agent.get(server(), &Enum.reverse(&1.calls))
  def get(url, timeout), do: request(:get, url, nil, timeout)
  def get_file(url, timeout), do: request(:get_file, url, nil, timeout)
  def post_once(url, body, _type, timeout), do: request(:post, url, Jason.decode!(body), timeout)
  def post(_, _, _, _), do: raise("recorder controls must not replay POST")

  defp request(method, url, body, timeout) do
    Agent.get_and_update(server(), fn state ->
      {Map.get(state.responses, {method, url}, {:error, :unreachable}),
       %{state | calls: [{method, url, body, timeout} | state.calls]}}
    end)
  end
end

defmodule Shuttle.RecorderRouterTest do
  use ExUnit.Case, async: true
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn
  alias Shuttle.{RecorderRouter, Remote}
  alias Shuttle.Test.{Env, RecorderClient}
  @endpoint ShuttleWeb.Endpoint

  setup do
    Env.start_scoped!(RecorderClient)
    Env.put_app_env(:write_forward_client, RecorderClient)

    remotes =
      for name <- ~w(agent-host linux-recorder mac-recorder),
          do: %Remote{name: name, url: "http://#{name}.example"}

    Env.put_app_env(:remotes, remotes)
    :ok
  end

  defp capability(sources, available \\ true),
    do: {:ok, Jason.encode!(%{available: available, sources: sources})}

  defp probes do
    %{
      {:get, "http://agent-host.example/api/v1/voice?recorder=agent-host"} =>
        capability(~w(desktop phone), false),
      {:get, "http://linux-recorder.example/api/v1/voice?recorder=linux-recorder"} =>
        capability(~w(phone)),
      {:get, "http://mac-recorder.example/api/v1/voice?recorder=mac-recorder"} =>
        capability(~w(desktop phone))
    }
  end

  test "desktop defaults local, phone chooses a capable recorder, and an address always wins" do
    RecorderClient.set(probes())
    assert {:ok, :local} = RecorderRouter.select_start(%{"origin" => "agent-host"})
    assert RecorderClient.calls() == []

    assert {:ok, {:remote, %Remote{name: "mac-recorder"}}} =
             RecorderRouter.select_start(%{"source" => "phone"})

    assert Enum.count(RecorderClient.calls()) == 3
    RecorderClient.set(%{})

    assert {:ok, {:remote, %Remote{name: "linux-recorder"}}} =
             RecorderRouter.select_start(%{"recorder" => "linux-recorder", "source" => "phone"})

    assert RecorderClient.calls() == []
  end

  test "phone enabling forwards source, pin and flags in one non-replayable request" do
    url = "http://mac-recorder.example/api/v1/voice"

    RecorderClient.set(
      Map.put(
        probes(),
        {:post, url},
        {:ok, 200, ~s({"enabled":true,"source":"phone","launch":"voice-L1"})}
      )
    )

    request = %{
      enabled: true,
      source: "phone",
      follow: false,
      target: %{fiber_id: "card", origin: "agent-host", name: "Card"},
      system_audio: false
    }

    assert %{"recorder" => "mac-recorder", "source" => "phone", "launch" => "voice-L1"} =
             api_conn() |> post("/api/v1/voice", Jason.encode!(request)) |> json_response(200)

    assert [{:post, ^url, body, _}] =
             Enum.filter(RecorderClient.calls(), fn {method, _, _, _} -> method == :post end)

    assert body["target"] == %{"fiber_id" => "card", "origin" => "agent-host", "name" => "Card"}
    assert body["follow"] == false
    assert body["source"] == "phone"
    assert body["recorder_forwarded"] == true
  end

  test "reads and controls stay on an addressed recorder, including uncertainty" do
    url = "http://mac-recorder.example/api/v1/voice"

    RecorderClient.set(%{
      {:get_file, url <> "?recorder=mac-recorder"} =>
        {:ok, 200, "application/json", ~s({"enabled":true,"follow":false})}
    })

    assert %{"recorder" => "mac-recorder", "follow" => false} =
             api_conn() |> get("/api/v1/voice?recorder=mac-recorder") |> json_response(200)

    RecorderClient.set(%{{:post, url} => {:ok, 200, ~s({"enabled":true,"system_audio":true})}})

    assert %{"system_audio" => true} =
             api_conn()
             |> post("/api/v1/voice", ~s({"recorder":"mac-recorder","system_audio":true}))
             |> json_response(200)

    assert [{:post, ^url, %{"system_audio" => true}, _}] = RecorderClient.calls()
    RecorderClient.set(%{{:post, url} => {:error, :timeout}})

    assert %{"recorder" => "mac-recorder", "error" => error} =
             api_conn()
             |> post("/api/v1/voice", ~s({"recorder":"mac-recorder","enabled":true}))
             |> json_response(502)

    assert error =~ "not confirmed"
    assert [{:post, ^url, _, _}] = RecorderClient.calls()
    RecorderClient.set(%{})

    assert %{"error" => _} =
             api_conn()
             |> post("/api/v1/voice", ~s({"recorder":"mac-recorder","recorder_forwarded":true}))
             |> json_response(400)

    assert RecorderClient.calls() == []
  end

  test "speaker selection uses addressed capability probes without starting audio" do
    RecorderClient.set(%{
      {:get, "http://agent-host.example/api/v1/speak?recorder=agent-host"} =>
        {:ok, ~s({"available":false})},
      {:get, "http://mac-recorder.example/api/v1/speak?recorder=mac-recorder"} =>
        {:ok, ~s({"available":true})}
    })

    assert {:ok, :local} = RecorderRouter.select_speaker(%{}, speaks: true)
    assert RecorderClient.calls() == []

    assert {:ok, {:remote, %Remote{name: "mac-recorder"}}} =
             RecorderRouter.select_speaker(%{}, speaks: false)

    assert {:ok, {:remote, %Remote{name: "agent-host"}}} =
             RecorderRouter.select_speaker(%{"recorder" => "agent-host"})
  end
end
