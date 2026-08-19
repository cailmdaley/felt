defmodule ShuttleWeb.SearchControllerTest do
  @moduledoc """
  `GET /api/v1/search` — the Chronicle's body search.

  felt is shelled through the `:felt_runner` seam, so these assertions never
  depend on what happens to be in the real loom (or on felt being on PATH).
  """

  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest
  import Shuttle.Test.EnvHelpers

  @endpoint ShuttleWeb.Endpoint

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    @rows [
      %{
        "id" => "ai-futures/felt/kanban-search",
        "uid" => "01J0",
        "name" => "kanban search bar",
        "status" => "closed",
        "created_at" => "2026-01-01T00:00:00Z",
        "closed_at" => "2026-02-01T00:00:00Z",
        "tempered" => true,
        "outcome" => "shipped",
        "body" => "the search input lives on the right of the title row"
      },
      %{
        "id" => "ai-futures/felt/rails",
        "uid" => "01J1",
        "name" => "day rails",
        "status" => "open",
        "created_at" => "2026-03-01T00:00:00Z",
        "closed_at" => nil,
        "outcome" => "",
        "body" => "a rail opens at 6am. The search never sees this word twice."
      }
    ]

    @impl true
    def cmd("felt", args, _opts) do
      cond do
        "--body" in args and "boom" in args -> {"felt: exploded", 1}
        "--body" in args -> {Jason.encode!(@rows), 0}
        true -> {"[]", 0}
      end
    end
  end

  setup do
    previous = Application.get_env(:shuttle, :felt_runner)
    Application.put_env(:shuttle, :felt_runner, MockRunner)
    on_exit(fn -> restore_app_env(:felt_runner, previous) end)
    :ok
  end

  defp api_conn do
    build_conn() |> put_req_header("accept", "application/json")
  end

  test "a blank query answers empty without shelling felt" do
    conn = get(api_conn(), "/api/v1/search?q=%20%20")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"query" => "", "results" => [], "errors" => []}
  end

  test "matches on name, id, outcome and body, and says which" do
    conn = get(api_conn(), "/api/v1/search?q=search")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["query"] == "search"

    by_id = Map.new(body["results"], &{&1["id"], &1})
    hit = by_id["ai-futures/felt/kanban-search"]
    assert "name" in hit["where"]
    assert "id" in hit["where"]
    assert "body" in hit["where"]
    # The closed/tempered record is in scope — the chronicle is the whole record.
    assert hit["status"] == "closed"
    assert hit["tempered"] == true

    other = by_id["ai-futures/felt/rails"]
    assert other["where"] == ["body"]
    assert other["excerpt"] =~ "search never sees"
    # The body itself never crosses the wire; only the excerpt does.
    refute Map.has_key?(other, "body")
  end

  test "a name match outranks a body-only match" do
    conn = get(api_conn(), "/api/v1/search?q=search")
    [first | _] = Jason.decode!(conn.resp_body)["results"]
    assert first["id"] == "ai-futures/felt/kanban-search"
  end

  test "limit caps the result list" do
    conn = get(api_conn(), "/api/v1/search?q=search&limit=1")
    assert length(Jason.decode!(conn.resp_body)["results"]) == 1
  end

  test "a failing store is reported without failing the request" do
    conn = get(api_conn(), "/api/v1/search?q=boom")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["results"] == []
    assert [%{"error" => "felt: exploded"} | _] = body["errors"]
  end
end
