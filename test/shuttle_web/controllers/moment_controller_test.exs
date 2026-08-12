defmodule ShuttleWeb.MomentControllerTest do
  @moduledoc """
  Reading + wiring for `GET /api/v1/moment` — the words behind a minute.

  The reader (`Shuttle.Moment`) runs against a FIXTURE transcript tree shaped
  like `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, covering the record shapes
  a real Claude Code transcript carries (string user content, assistant text
  blocks alongside thinking/tool_use, tool results, `isMeta` injections, system
  notices) plus malformed lines. The controller's local branch reads that tree
  via `$SHUTTLE_CLAUDE_PROJECTS_DIR`; the cross-host branch reuses
  `Shuttle.OriginRouter.forward_get/4` with a stubbed transport, mirroring the
  /file and /sent-files forward tests.
  """
  use ExUnit.Case, async: false
  import Plug.Conn
  import Phoenix.ConnTest

  alias Shuttle.Moment

  @endpoint ShuttleWeb.Endpoint

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @other "fef866ba-b397-4277-a01b-16fcecc2b256"
  @t0 1_762_000_000_000

  # GET transport stub for the cross-host /moment forward. Mirrors the
  # /sent-files controller test's stub.
  defmodule StubGetFileClient do
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{response: nil, last: nil} end, name: __MODULE__)

    def set_response(response), do: Agent.update(__MODULE__, &Map.put(&1, :response, response))
    def last, do: Agent.get(__MODULE__, & &1.last)

    def get_file(url, _timeout_ms) do
      Agent.update(__MODULE__, &Map.put(&1, :last, %{url: url}))
      Agent.get(__MODULE__, & &1.response)
    end
  end

  defp iso(ms), do: ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()

  defp user(ms, text), do: %{"type" => "user", "timestamp" => iso(ms), "message" => %{"content" => text}}

  defp assistant(ms, blocks),
    do: %{"type" => "assistant", "timestamp" => iso(ms), "message" => %{"content" => blocks}}

  # A fixture transcript tree; returns the root. Cleaned up on exit.
  defp write_tree(files) do
    root =
      Path.join(System.tmp_dir!(), "shuttle_moment_#{System.unique_integer([:positive])}")

    Enum.each(files, fn {slug, session, records} ->
      dir = Path.join(root, slug)
      File.mkdir_p!(dir)

      body =
        records
        |> Enum.map(fn
          line when is_binary(line) -> line
          record -> Jason.encode!(record)
        end)
        |> Enum.join("\n")

      File.write!(Path.join(dir, "#{session}.jsonl"), body <> "\n")
    end)

    on_exit(fn -> File.rm_rf(root) end)
    root
  end

  defp default_tree do
    write_tree([
      {"-Users-cail-french", @session,
       [
         # Before the window.
         user(@t0 - 60_000, "yesterday's question"),
         user(@t0 + 1_000, "hi french class! pasting some vocab"),
         assistant(@t0 + 2_000, [
           %{"type" => "thinking", "thinking" => "let me consider"},
           %{"type" => "text", "text" => "Bien sûr — here are the definitions."}
         ]),
         # Tool call and tool result: activity, not words.
         assistant(@t0 + 3_000, [%{"type" => "tool_use", "name" => "Bash", "input" => %{}}]),
         %{
           "type" => "user",
           "timestamp" => iso(@t0 + 3_500),
           "message" => %{"content" => [%{"type" => "tool_result", "content" => "ok"}]}
         },
         # Injected context wearing a user's clothes.
         %{
           "type" => "user",
           "isMeta" => true,
           "timestamp" => iso(@t0 + 4_000),
           "message" => %{"content" => [%{"type" => "text", "text" => "Base directory for…"}]}
         },
         %{
           "type" => "system",
           "timestamp" => iso(@t0 + 5_000),
           "content" => "/remote-control is active."
         },
         "{ not json at all",
         "",
         %{"type" => "user", "message" => %{"content" => "no timestamp, no place in time"}},
         # After the window.
         user(@t0 + 600_000, "much later")
       ]},
      {"-Users-cail-other", @other, [user(@t0 + 1_000, "different session")]}
    ])
  end

  describe "Shuttle.Moment.excerpts/4 (the reader)" do
    test "recovers user, assistant and notification words inside the window" do
      root = default_tree()

      excerpts = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)

      assert Enum.map(excerpts, &{&1.role, &1.text}) == [
               {"user", "hi french class! pasting some vocab"},
               {"assistant", "Bien sûr — here are the definitions."},
               {"notification", "/remote-control is active."}
             ]

      assert Enum.map(excerpts, & &1.at_ms) == [@t0 + 1_000, @t0 + 2_000, @t0 + 5_000]
    end

    test "a window with nothing in it is empty, not an error" do
      root = default_tree()
      assert Moment.excerpts(@session, @t0 + 100_000, @t0 + 200_000, root: root) == []
    end

    test "window edges are inclusive on both bounds" do
      root = default_tree()

      assert [%{at_ms: at}] = Moment.excerpts(@session, @t0 + 1_000, @t0 + 1_000, root: root)
      assert at == @t0 + 1_000
    end

    test "an unknown session, a non-uuid session and a missing root are all empty" do
      root = default_tree()

      assert Moment.excerpts("11111111-2222-3333-4444-555555555555", @t0, @t0 + 10_000,
               root: root
             ) == []

      # A non-UUID session never reaches the filesystem as a glob.
      assert Moment.excerpts("../../*", @t0, @t0 + 10_000, root: root) == []
      assert Moment.excerpts(@session, @t0, @t0 + 10_000, root: "/nope/not/here") == []
    end

    test "caps the excerpt count and the text length" do
      root =
        write_tree([
          {"-slug", @session,
           for(i <- 1..20, do: user(@t0 + i * 100, String.duplicate("mot ", 200)))}
        ])

      excerpts = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)

      assert length(excerpts) == 6
      assert Enum.all?(excerpts, &(String.length(&1.text) == 280))
      assert String.ends_with?(hd(excerpts).text, "…")
      # Oldest first — the six the window opened with, in order.
      assert Enum.map(excerpts, & &1.at_ms) == for(i <- 1..6, do: @t0 + i * 100)
    end

    test "check_window/2 refuses an inverted or over-wide window" do
      assert Moment.check_window(@t0, @t0 + 1_000) == :ok
      assert Moment.check_window(@t0, @t0 - 1) == {:error, :inverted_range}

      assert Moment.check_window(@t0, @t0 + Moment.max_window_ms() + 1) ==
               {:error, :range_too_wide}
    end
  end

  describe "Shuttle.Moment.tool_summary/1 (the wordless minute's answer)" do
    test "names the tools in order, deduped with counts" do
      assert Moment.tool_summary([{"Bash", nil}, {"Read", nil}, {"Bash", nil}, {"Read", nil},
               {"Read", nil}, {"Edit", nil}]) == "Bash ×2 · Read ×3 · Edit"
    end

    test "no calls means no line" do
      assert Moment.tool_summary([]) == nil
    end

    test "the dominant tool's hint is appended, once" do
      assert Moment.tool_summary([
               {"Read", nil},
               {"Bash", "run the activity tests"},
               {"Bash", "and again"}
             ]) == "Read · Bash ×2 — run the activity tests"
    end

    test "past five distinct tools the list elides rather than growing" do
      calls = for name <- ~w(A B C D E F G), do: {name, nil}
      assert Moment.tool_summary(calls) == "A · B · C · D · E · …"
    end

    test "the whole line is bounded" do
      calls = [{String.duplicate("Tool", 40), "x"}]
      summary = Moment.tool_summary(calls)
      assert String.length(summary) == 120
      assert String.ends_with?(summary, "…")
    end
  end

  describe "Shuttle.Moment.moment/4 (words, else tools)" do
    # A minute of silent tool work is the case this exists for.
    defp tool_tree do
      write_tree([
        {"-Users-cail-felt", @session,
         [
           assistant(@t0 + 1_000, [
             %{"type" => "thinking", "thinking" => "not addressed to anyone"},
             %{
               "type" => "tool_use",
               "name" => "Bash",
               "input" => %{"command" => "mix test", "description" => "run the tests"}
             },
             %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/a.ex"}}
           ]),
           assistant(@t0 + 2_000, [%{"type" => "tool_use", "name" => "Bash", "input" => %{}}]),
           # A tool RESULT is not a call: it must not be counted twice.
           %{
             "type" => "user",
             "timestamp" => iso(@t0 + 2_500),
             "message" => %{"content" => [%{"type" => "tool_result", "content" => "ok"}]}
           },
           assistant(@t0 + 9_000, [%{"type" => "text", "text" => "Done — tests pass."}])
         ]}
      ])
    end

    test "a wordless window answers with its tools" do
      assert %{excerpts: [], tools: "Bash ×2 · Read — run the tests"} =
               Moment.moment(@session, @t0, @t0 + 3_000, root: tool_tree())
    end

    test "words win: a window with prose reports no tools" do
      assert %{excerpts: [%{text: "Done — tests pass."}], tools: nil} =
               Moment.moment(@session, @t0, @t0 + 10_000, root: tool_tree())
    end

    test "an empty window, and an unknown session, are silent in both fields" do
      root = tool_tree()
      assert Moment.moment(@session, @t0 + 100_000, @t0 + 200_000, root: root) ==
               %{excerpts: [], tools: nil}

      assert Moment.moment("../../*", @t0, @t0 + 10_000, root: root) ==
               %{excerpts: [], tools: nil}
    end

    test "the endpoint carries the tools field only when there are no words" do
      root = tool_tree()
      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
      on_exit(fn -> System.delete_env("SHUTTLE_CLAUDE_PROJECTS_DIR") end)

      wordless =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 3_000}"
        })
        |> json_response(200)

      assert wordless["excerpts"] == []
      assert wordless["tools"] == "Bash ×2 · Read — run the tests"

      spoken =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}"
        })
        |> json_response(200)

      refute Map.has_key?(spoken, "tools")
    end
  end

  describe "GET /api/v1/moment (local)" do
    setup do
      root = default_tree()
      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
      on_exit(fn -> System.delete_env("SHUTTLE_CLAUDE_PROJECTS_DIR") end)
      :ok
    end

    test "serves the words with this host's stamp" do
      conn =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}"
        })

      assert %{"host" => host, "excerpts" => excerpts} = json_response(conn, 200)
      assert host == Shuttle.Poller.own_host_id()
      assert Enum.map(excerpts, & &1["role"]) == ["user", "assistant", "notification"]
      assert hd(excerpts)["text"] == "hi french class! pasting some vocab"
    end

    test "a session with no transcript is an empty 200, not a 500" do
      conn =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => "11111111-2222-3333-4444-555555555555",
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}"
        })

      assert %{"excerpts" => []} = json_response(conn, 200)
    end

    test "a missing session or bound is a 400" do
      assert %{"error" => "session is required"} =
               build_conn()
               |> get("/api/v1/moment", %{"from_ms" => "1", "to_ms" => "2"})
               |> json_response(400)

      assert %{"error" => _} =
               build_conn()
               |> get("/api/v1/moment", %{"session" => @session, "to_ms" => "2"})
               |> json_response(400)
    end

    test "an inverted or over-wide window is a 400" do
      assert %{"error" => "to_ms must be >= from_ms"} =
               build_conn()
               |> get("/api/v1/moment", %{
                 "session" => @session,
                 "from_ms" => "#{@t0}",
                 "to_ms" => "#{@t0 - 1}"
               })
               |> json_response(400)

      assert %{"error" => "window too wide: at most 120 minutes"} =
               build_conn()
               |> get("/api/v1/moment", %{
                 "session" => @session,
                 "from_ms" => "#{@t0}",
                 "to_ms" => "#{@t0 + Moment.max_window_ms() + 1}"
               })
               |> json_response(400)
    end
  end

  describe "GET /api/v1/moment (cross-host)" do
    setup do
      start_supervised!(StubGetFileClient)
      prior_client = Application.get_env(:shuttle, :write_forward_client)
      prior_remotes = Application.get_env(:shuttle, :remotes)
      Application.put_env(:shuttle, :write_forward_client, StubGetFileClient)

      Application.put_env(:shuttle, :remotes, [
        %{name: "candide", url: "http://127.0.0.1:19999"}
      ])

      on_exit(fn ->
        restore(:write_forward_client, prior_client)
        restore(:remotes, prior_remotes)
      end)

      :ok
    end

    defp restore(key, nil), do: Application.delete_env(:shuttle, key)
    defp restore(key, value), do: Application.put_env(:shuttle, key, value)

    test "forwards to the named host and relays its words verbatim" do
      body =
        Jason.encode!(%{
          host: "candide",
          excerpts: [%{at_ms: @t0, role: "user", text: "run the pipeline"}]
        })

      StubGetFileClient.set_response({:ok, 200, "application/json", body})

      conn =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 60_000}",
          "host" => "candide"
        })

      assert %{"host" => "candide", "excerpts" => [%{"text" => "run the pipeline"}]} =
               json_response(conn, 200)

      url = StubGetFileClient.last().url
      assert url =~ "http://127.0.0.1:19999/api/v1/moment?"
      assert url =~ "session=#{@session}"
      # `host=local` so the owner serves it as its own read and the hop ends there.
      assert url =~ "host=local"
    end

    test "an unreachable host is an empty 200 that says where the words live" do
      StubGetFileClient.set_response({:error, :econnrefused})

      conn =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 60_000}",
          "host" => "candide"
        })

      assert json_response(conn, 200) == %{
               "host" => "candide",
               "excerpts" => [],
               "note" => "words live on candide"
             }
    end

    test "an unknown host name degrades to a local read" do
      root = default_tree()
      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)
      on_exit(fn -> System.delete_env("SHUTTLE_CLAUDE_PROJECTS_DIR") end)

      conn =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}",
          "host" => "a-host-nobody-configured"
        })

      assert %{"excerpts" => [_ | _]} = json_response(conn, 200)
    end
  end

  describe "Shuttle.SessionLedger.host_for_session/2 (the pairing rung)" do
    test "names the host of the newest line for a session, nil otherwise" do
      path = Path.join(System.tmp_dir!(), "moment_ledger_#{System.unique_integer([:positive])}")
      on_exit(fn -> File.rm(path) end)

      Shuttle.SessionLedger.record(
        fiber: "work/a",
        session: @session,
        kind: "dispatch",
        host: "candide",
        at: @t0,
        path: path
      )

      Shuttle.SessionLedger.record(
        fiber: "work/a",
        session: @session,
        kind: "resume",
        host: "dapmcw68",
        at: @t0 + 1,
        path: path
      )

      assert Shuttle.SessionLedger.host_for_session(@session, path: path) == "dapmcw68"
      assert Shuttle.SessionLedger.host_for_session(@other, path: path) == nil
      assert Shuttle.SessionLedger.host_for_session(nil, path: path) == nil
    end
  end
end
