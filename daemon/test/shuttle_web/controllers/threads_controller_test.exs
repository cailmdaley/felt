defmodule ShuttleWeb.ThreadsControllerTest do
  @moduledoc """
  Wiring for `GET /api/v1/threads/*id`: the tree is built from the named
  Poller's cached constitutions with its running workers as the live ones. The
  classification itself is `Shuttle.ThreadsTest`'s.
  """
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  defmodule QuietRunner do
    @behaviour Shuttle.Runner
    def cmd(_command, _args, _opts), do: {"", 1}
  end

  defp entry(id, fiber) do
    %{
      felt_store: "/s",
      fiber:
        Map.merge(
          %{
            "id" => "u-" <> id,
            "slug" => id,
            "uid" => "u-" <> id,
            "name" => id,
            "shuttle" => %{}
          },
          fiber
        )
    }
  end

  # A Poller past its boot cycle, so no poll overwrites the state set here.
  defp quiet_poller! do
    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: QuietRunner,
        poll_interval_ms: 60_000,
        felt_stores: []
      )

    Shuttle.Test.PollerHelpers.await_boot_cycle!(poller)
    poller
  end

  defp warm!(entries, running) do
    cache = Map.new(entries, &{&1.fiber["uid"], %{modified_at: nil, entry: &1}})

    poller = quiet_poller!()

    :sys.replace_state(poller, fn state ->
      %{
        state
        | document_cache_ready: true,
          document_cache: cache,
          document_fiber_index: Shuttle.Poller.DocumentCache.index(cache),
          running:
            Map.new(running, fn id ->
              now = DateTime.utc_now()

              {id,
               %{
                 pid: nil,
                 session: "thread-test",
                 agent_id: nil,
                 started_at: now,
                 last_activity_at: now
               }}
            end)
      }
    end)

    # `:sys.replace_state/2` changes the GenServer fixture without running the
    # normal transition wrapper, so use an actual callback as a publication
    # barrier before exercising the mailbox-free controller reader.
    GenServer.call(poller, :orchestrator_state)
    poller
  end

  test "a constitution's threads, by address or uid, live from the poller's workers" do
    warm!(
      [
        entry("hub", %{"status" => "active"}),
        entry("hub/live", %{"status" => "open"}),
        entry("hub/live/deep", %{"status" => "closed", "outcome" => "Found it."}),
        entry("hub/done", %{"status" => "closed", "tempered" => true})
      ],
      ["u-hub/live"]
    )

    for id <- ["hub", "u-hub"] do
      body = get(api_conn(), "/api/v1/threads/#{id}") |> json_response(200)
      assert %{"fiber_id" => "hub", "uid" => "u-hub", "felt_store" => "/s"} = body

      assert [
               %{"id" => "hub/done", "column" => "tempered", "state" => "Archived"},
               %{
                 "id" => "hub/live",
                 "column" => "in_flight",
                 "state" => "Working",
                 "threads" => [%{"id" => "hub/live/deep", "state" => "To review"}]
               }
             ] = body["threads"]
    end

    assert %{"error" => "not_found"} =
             get(api_conn(), "/api/v1/threads/nowhere") |> json_response(404)
  end

  test "503 before the first poll warms the cache, and with no Poller" do
    assert %{"error" => "poller_unavailable"} =
             get(api_conn(), "/api/v1/threads/hub") |> json_response(503)

    poller = quiet_poller!()
    :sys.replace_state(poller, &%{&1 | document_cache_ready: false})
    GenServer.call(poller, :orchestrator_state)

    assert %{"error" => "cold"} = get(api_conn(), "/api/v1/threads/hub") |> json_response(503)
  end
end
