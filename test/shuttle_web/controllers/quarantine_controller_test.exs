defmodule ShuttleWeb.QuarantineControllerTest do
  @moduledoc """
  Wiring for `POST /api/v1/quarantine/release`. The quarantine behavior itself
  (fresh launches parked, dirty resumes allowed, release restores dispatch,
  force-dispatch bypasses) is covered at the Poller layer (`PollerTest`
  "boot quarantine …"); here we pin the HTTP contract: release reaches the
  named Poller and flips the snapshot's `boot_quarantine`, and a daemon with
  no Poller answers 503 instead of crashing the request.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # Transport stub for the forward leg: records the POST and replays a scripted
  # response, so the cross-host relay is exercised without a real tunnel.
  defmodule StubPostClient do
    use Agent
    def start_link(_ \\ []), do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)
    def set_response(r), do: Agent.update(__MODULE__, &Map.put(&1, :response, r))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def post(url, body, _content_type, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url, body: body}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  # The endpoint calls the globally named Shuttle.Poller. Quiet runner: no
  # felt stores to poll, and every shell-out reports "nothing" so init's
  # orphan-adoption scan is inert.
  defmodule QuietRunner do
    @behaviour Shuttle.Runner
    def cmd(_command, _args, _opts), do: {"", 1}
  end

  test "release flips the named Poller's boot_quarantine and is idempotent" do
    start_supervised!(%{
      id: make_ref(),
      start:
        {Shuttle.Poller, :start_link,
         [
           [
             name: Shuttle.Poller,
             runner: QuietRunner,
             poll_interval_ms: 60_000,
             felt_stores: [],
             boot_quarantine: true
           ]
         ]},
      restart: :temporary
    })

    assert Shuttle.Poller.snapshot().boot_quarantine == true

    conn = post(api_conn(), "/api/v1/quarantine/release", "{}")
    assert %{"ok" => true, "boot_quarantine" => false} = json_response(conn, 200)
    assert Shuttle.Poller.snapshot().boot_quarantine == false

    # Releasing an already-released quarantine is a cheerful no-op.
    conn = post(api_conn(), "/api/v1/quarantine/release", "{}")
    assert %{"ok" => true} = json_response(conn, 200)
  end

  test "503 when no Poller is running" do
    conn = post(api_conn(), "/api/v1/quarantine/release", "{}")
    assert %{"error" => "poller_unavailable"} = json_response(conn, 503)
  end

  # A held card can be owned by a remote host, and the quarantine lives in THAT
  # daemon's Poller — so a release carrying a remote `origin` forwards over the
  # tunnel to the owning daemon's identical endpoint and relays its response.
  # The forwarded body strips `origin` (the owner runs its own local branch).
  test "release forwards to the owning remote when origin names one" do
    start_supervised!(StubPostClient)
    StubPostClient.set_response({:ok, 200, Jason.encode!(%{"ok" => true, "boot_quarantine" => false})})

    previous_remotes = Application.get_env(:shuttle, :remotes)
    previous_client = Application.get_env(:shuttle, :write_forward_client)
    Application.put_env(:shuttle, :remotes, [%{name: "candide", url: "http://localhost:4001"}])
    Application.put_env(:shuttle, :write_forward_client, StubPostClient)

    on_exit(fn ->
      restore(:remotes, previous_remotes)
      restore(:write_forward_client, previous_client)
    end)

    conn = post(api_conn(), "/api/v1/quarantine/release", Jason.encode!(%{origin: "candide"}))
    assert %{"ok" => true, "boot_quarantine" => false} = json_response(conn, 200)

    last = StubPostClient.last()
    assert last.url == "http://localhost:4001/api/v1/quarantine/release"
    assert Jason.decode!(last.body) == %{}
  end

  defp restore(key, nil), do: Application.delete_env(:shuttle, key)
  defp restore(key, value), do: Application.put_env(:shuttle, key, value)

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end
end
