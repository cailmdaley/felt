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

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end
end
