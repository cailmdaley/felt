defmodule ShuttleWeb.TranscriptSearchControllerTest do
  @moduledoc """
  `GET /api/v1/transcripts/search` — shells `shuttle transcript search --json`
  through the `:felt_runner` seam; the stub records its argv and answers per query.
  """

  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    @doc_ %{
      "query" => "vmpz",
      "index" => %{
        "path" => "/idx.sqlite",
        "sessions" => 2,
        "messages" => 9,
        "updated_at" => "2026-10-24T09:12:00Z"
      },
      "hits" => [
        %{
          "session" => "s1",
          "harness" => "claude",
          "line" => 3,
          "snippet" => "the «vmpz» fix",
          "fibers" => []
        }
      ],
      "errors" => []
    }

    @impl true
    def cmd("shuttle", args, _opts) do
      send(Shuttle.Env.app(:ts_test_pid), {:argv, args})
      query = List.last(args)

      cond do
        query == "boom" -> {"index is corrupt", 3}
        query == "garbage" -> {"not json", 0}
        query == "slow" -> {"", :timeout}
        true -> {Jason.encode!(@doc_), 0}
      end
    end
  end

  setup do
    Shuttle.Test.Env.put_app_env(:felt_runner, MockRunner)
    Shuttle.Test.Env.put_app_env(:ts_test_pid, self())
    :ok
  end

  test "relays the CLI document and passes every filter as its own argv element" do
    body =
      api_conn()
      |> get("/api/v1/transcripts/search", %{
        "q" => "vmpz convention",
        "session" => ["s1", "s2"],
        "fiber" => "a/b",
        "since" => "30d",
        "harness" => "codex",
        "limit" => "500"
      })
      |> json_response(200)

    assert [%{"snippet" => "the «vmpz» fix", "line" => 3}] = body["hits"]
    assert body["index"]["sessions"] == 2

    assert_received {:argv, argv}

    assert argv == [
             "transcript",
             "search",
             "--json",
             "--session=s1",
             "--session=s2",
             "--fiber=a/b",
             "--since=30d",
             "--harness",
             "codex",
             "--limit",
             "100",
             "--",
             "vmpz convention"
           ]
  end

  test "a query that begins with a dash follows the -- separator" do
    api_conn() |> get("/api/v1/transcripts/search", %{"q" => "-n 5"}) |> json_response(200)
    assert_received {:argv, argv}
    assert Enum.take(argv, -2) == ["--", "-n 5"]
    assert ["--limit", "20"] == Enum.slice(argv, -4, 2)
  end

  test "missing query and bad harness are 400s that never reach the CLI" do
    assert %{"error" => "q is required"} =
             api_conn() |> get("/api/v1/transcripts/search", %{"q" => "  "}) |> json_response(400)

    assert %{"error" => "harness must be" <> _} =
             api_conn()
             |> get("/api/v1/transcripts/search", %{"q" => "x", "harness" => "gpt"})
             |> json_response(400)

    refute_received {:argv, _}
  end

  test "CLI failure, non-contract output and timeout are JSON errors" do
    assert %{"error" => "shuttle transcript search exited 3", "detail" => "index is corrupt"} =
             api_conn()
             |> get("/api/v1/transcripts/search", %{"q" => "boom"})
             |> json_response(502)

    assert %{"error" => "shuttle transcript search printed no search document"} =
             api_conn()
             |> get("/api/v1/transcripts/search", %{"q" => "garbage"})
             |> json_response(502)

    assert %{"error" => "transcript search timed out"} =
             api_conn()
             |> get("/api/v1/transcripts/search", %{"q" => "slow"})
             |> json_response(504)
  end
end
