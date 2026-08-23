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
  alias Shuttle.Test.StubGetFileClient
  import Plug.Conn
  import Phoenix.ConnTest
  import Shuttle.Test.EnvHelpers

  alias Shuttle.Moment

  @endpoint ShuttleWeb.Endpoint

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @other "fef866ba-b397-4277-a01b-16fcecc2b256"
  @t0 1_762_000_000_000

  defp iso(ms), do: ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()

  defp user(ms, text),
    do: %{"type" => "user", "timestamp" => iso(ms), "message" => %{"content" => text}}

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

  describe "Shuttle.Moment — the delegation register" do
    defp spawn_block(id, tool, input),
      do: %{"type" => "tool_use", "id" => id, "name" => tool, "input" => input}

    defp result(ms, id, text),
      do: %{
        "type" => "user",
        "timestamp" => iso(ms),
        "message" => %{
          "content" => [%{"type" => "tool_result", "tool_use_id" => id, "content" => text}]
        }
      }

    test "a spawn call becomes an excerpt naming the agent and quoting its prompt" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0 + 1_000, [
               spawn_block("tu_1", "Agent", %{
                 "name" => "chart-hand",
                 "subagent_type" => "Explore",
                 "prompt" => "Trace the lane admission chain and report back."
               })
             ])
           ]}
        ])

      assert [excerpt] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)

      assert excerpt.kind == "spawn"
      assert excerpt.name == "chart-hand"
      assert excerpt.text == "Trace the lane admission chain and report back."
      assert excerpt.role == "assistant"
    end

    test "a spawn with no name of its own falls back to its role, then to its errand" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0 + 1_000, [
               spawn_block("tu_1", "Task", %{"subagent_type" => "Explore", "prompt" => "look"})
             ]),
             assistant(@t0 + 2_000, [
               spawn_block("tu_2", "Workflow", %{
                 "description" => "Sweep the views",
                 "prompt" => "go"
               })
             ])
           ]}
        ])

      assert [first, second] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert first.name == "Explore"
      assert second.name == "Sweep the views"
    end

    test "an ordinary tool call is not a delegation" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0 + 1_000, [
               spawn_block("tu_1", "Bash", %{"command" => "ls", "prompt" => "not a prompt"})
             ])
           ]}
        ])

      assert Moment.excerpts(@session, @t0, @t0 + 10_000, root: root) == []
    end

    test "a tool result closing a spawn is the report coming back" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0 + 1_000, [
               spawn_block("tu_1", "Agent", %{"name" => "chart-hand", "prompt" => "go"}),
               spawn_block("tu_2", "Agent", %{"name" => "type-pass", "prompt" => "also go"})
             ]),
             result(@t0 + 2_000, "tu_1", "Found it: the lane never joined a ledger row."),
             result(@t0 + 3_000, "tu_9", "an ordinary tool's result, not a report")
           ]}
        ])

      assert [_spawn, _spawn2, report] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert report.kind == "return"
      assert report.name == "chart-hand"
      assert report.text == "Found it: the lane never joined a ledger row."
      assert report.role == "user"
    end

    test "the spawn that named an agent may sit outside the window its report lands in" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0, [
               spawn_block("tu_1", "Agent", %{"name" => "chart-hand", "prompt" => "go"})
             ]),
             result(@t0 + 60_000, "tu_1", "done, and here is what I found")
           ]}
        ])

      assert [report] = Moment.excerpts(@session, @t0 + 30_000, @t0 + 90_000, root: root)
      assert report.name == "chart-hand"
    end

    test "a launch receipt is not a report" do
      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0, [
               spawn_block("tu_1", "Agent", %{"name" => "chart-hand", "prompt" => "go"})
             ]),
             result(
               @t0 + 1_000,
               "tu_1",
               "Spawned successfully. (This tool result is internal metadata — never quote it.)"
             )
           ]}
        ])

      assert [only] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert only.kind == "spawn"
    end

    test "a task notification is a report, named by the quotation in its summary" do
      text = """
      <task-notification>
      <task-id>abc123</task-id>
      <status>completed</status>
      <summary>Agent "Explain the moment words" finished</summary>
      <result>The chain is bucket → ledger → transcript.</result>
      </task-notification>
      """

      root = write_tree([{"-slug", @session, [user(@t0 + 1_000, text)]}])

      assert [report] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert report.kind == "return"
      assert report.name == "Explain the moment words"
      assert report.text == "The chain is bucket → ledger → transcript."
    end

    test "a teammate message is a report, and an idle ping is not" do
      report_text = """
      Another Claude session sent a message:
      <teammate-message teammate_id="type-pass" summary="done">
      Typography pass done. Nothing committed.
      </teammate-message>
      """

      idle = """
      <teammate-message teammate_id="type-pass">
      {"type":"idle_notification","from":"type-pass"}
      </teammate-message>
      """

      root =
        write_tree([
          {"-slug", @session, [user(@t0 + 1_000, report_text), user(@t0 + 2_000, idle)]}
        ])

      assert [report] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert report.name == "type-pass"
      assert report.text == "Typography pass done. Nothing committed."
    end

    test "sidechain records say nothing — the spawn/return pair is the summary" do
      root =
        write_tree([
          {"-slug", @session,
           [
             Map.put(user(@t0 + 1_000, "the subagent's own prompt"), "isSidechain", true),
             Map.put(
               assistant(@t0 + 2_000, [%{"type" => "text", "text" => "its own reply"}]),
               "isSidechain",
               true
             ),
             user(@t0 + 3_000, "the parent speaking")
           ]}
        ])

      assert [only] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert only.text == "the parent speaking"
      assert only.kind == "prose"
    end

    test "a delegation is cut shorter than prose, and a full fetch relaxes both" do
      long = String.duplicate("mot ", 400)

      root =
        write_tree([
          {"-slug", @session,
           [
             assistant(@t0 + 1_000, [
               spawn_block("tu_1", "Agent", %{"name" => "x", "prompt" => long})
             ])
           ]}
        ])

      assert [brief] = Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
      assert String.length(brief.text) == 200

      assert [full] =
               Moment.excerpts(@session, @t0, @t0 + 10_000,
                 root: root,
                 max_chars: Moment.max_chars(true)
               )

      assert String.length(full.text) > 1_000
    end

    test "prose carries the register too, so a client never has to guess" do
      root = default_tree()

      assert Moment.excerpts(@session, @t0, @t0 + 10_000, root: root)
             |> Enum.all?(&(&1.kind == "prose" and is_nil(&1.name)))
    end
  end

  describe "Shuttle.Moment.tool_summary/1 (the wordless minute's answer)" do
    test "names the tools in order, deduped with counts" do
      assert Moment.tool_summary([
               {"Bash", nil},
               {"Read", nil},
               {"Bash", nil},
               {"Read", nil},
               {"Read", nil},
               {"Edit", nil}
             ]) == "Bash ×2 · Read ×3 · Edit"
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

  describe "Shuttle.Moment.call_lines/1 (the individual calls, when they fit)" do
    test "one line per call, oldest first, bare name when there is no hint" do
      assert Moment.call_lines([{"Bash", "run the tests"}, {"Read", nil}, {"Bash", nil}]) == [
               "Bash — run the tests",
               "Read",
               "Bash"
             ]
    end

    test "no calls means no lines" do
      assert Moment.call_lines([]) == nil
    end

    test "past the cap the lines give way to the aggregate" do
      calls = for name <- ~w(A B C D E F G), do: {name, nil}
      assert Moment.call_lines(calls) == nil
    end

    test "exactly at the cap still lists individually" do
      calls = for name <- ~w(A B C D E F), do: {name, nil}
      assert Moment.call_lines(calls) == ~w(A B C D E F)
    end
  end

  describe "Shuttle.Moment.moment/4 (words and tools)" do
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

    test "a wordless window with few calls lists them individually" do
      assert %{excerpts: [], tools: "Bash — run the tests\nRead — a.ex\nBash"} =
               Moment.moment(@session, @t0, @t0 + 3_000, root: tool_tree())
    end

    test "a wordless window with many calls falls back to the aggregate" do
      root =
        write_tree([
          {"-Users-cail-felt", @session,
           [
             assistant(@t0 + 1_000, [
               %{
                 "type" => "tool_use",
                 "name" => "Bash",
                 "input" => %{"description" => "run the tests"}
               },
               %{"type" => "tool_use", "name" => "Bash", "input" => %{}},
               %{"type" => "tool_use", "name" => "Bash", "input" => %{}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/a.ex"}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/b.ex"}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/c.ex"}},
               %{"type" => "tool_use", "name" => "Edit", "input" => %{"file_path" => "/a.ex"}}
             ])
           ]}
        ])

      assert %{excerpts: [], tools: "Bash ×3 · Read ×3 · Edit — run the tests"} =
               Moment.moment(@session, @t0, @t0 + 3_000, root: root)
    end

    test "a Bash call with no description falls back to its command" do
      # Bare "Bash" tells a reader nothing they did not already know from the
      # fact that the minute had tool calls in it. The command is the next best
      # account of what happened — collapsed of newlines and cut to 48 chars,
      # so a heredoc becomes one readable line.
      root =
        write_tree([
          {"-Users-cail-felt", @session,
           [
             assistant(@t0 + 1_000, [
               %{
                 "type" => "tool_use",
                 "name" => "Bash",
                 "input" => %{"command" => "git status\n  --short"}
               },
               %{
                 "type" => "tool_use",
                 "name" => "Bash",
                 "input" => %{"command" => String.duplicate("x", 60)}
               }
             ])
           ]}
        ])

      assert %{
               excerpts: [],
               tools: "Bash — git status --short\n" <> long
             } = Moment.moment(@session, @t0, @t0 + 3_000, root: root)

      assert long == "Bash — " <> String.duplicate("x", 47) <> "…"
    end

    test "the aggregate's dominant-tool hint takes the same fallback" do
      root =
        write_tree([
          {"-Users-cail-felt", @session,
           [
             assistant(@t0 + 1_000, [
               %{"type" => "tool_use", "name" => "Bash", "input" => %{"command" => "make test"}},
               %{
                 "type" => "tool_use",
                 "name" => "Bash",
                 "input" => %{"command" => "make daemon"}
               },
               %{"type" => "tool_use", "name" => "Bash", "input" => %{"command" => "ls"}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/a.ex"}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/b.ex"}},
               %{"type" => "tool_use", "name" => "Read", "input" => %{"file_path" => "/c.ex"}},
               %{"type" => "tool_use", "name" => "Edit", "input" => %{"file_path" => "/a.ex"}}
             ])
           ]}
        ])

      # First appearance fixes which command becomes the hint, exactly as a
      # description would have.
      assert %{excerpts: [], tools: "Bash ×3 · Read ×3 · Edit — make test"} =
               Moment.moment(@session, @t0, @t0 + 3_000, root: root)
    end

    test "a description still wins over the command when the call carries one" do
      root =
        write_tree([
          {"-Users-cail-felt", @session,
           [
             assistant(@t0 + 1_000, [
               %{
                 "type" => "tool_use",
                 "name" => "Bash",
                 "input" => %{"command" => "mix test", "description" => "run the tests"}
               }
             ])
           ]}
        ])

      assert %{excerpts: [], tools: "Bash — run the tests"} =
               Moment.moment(@session, @t0, @t0 + 3_000, root: root)
    end

    test "a window with prose reports BOTH the words and the tools that ran" do
      assert %{excerpts: [%{text: "Done — tests pass."}], tools: tools} =
               Moment.moment(@session, @t0, @t0 + 10_000, root: tool_tree())

      # The two are facts about the same minute, not alternatives: suppressing
      # the calls left a client able to count them and unable to name them.
      assert tools =~ "Bash"
    end

    test "an empty window, and an unknown session, are silent in every field" do
      root = tool_tree()
      empty = %{excerpts: [], excerpt_count: 0, tools: nil, tool_lines: [], tool_count: 0}

      assert Moment.moment(@session, @t0 + 100_000, @t0 + 200_000, root: root) == empty
      assert Moment.moment("../../*", @t0, @t0 + 10_000, root: root) == empty
    end

    # THE CLAIM AND THE LIST COME FROM ONE PASS. `tool_count` is what a `×N`
    # beside the listing is allowed to say, and `tool_lines` is what that N
    # refers to — cut on a hover, whole on a pin, and the difference is
    # legible from the response alone rather than inferred.
    test "the counts say how much was cut, and a full read cuts nothing" do
      root =
        write_tree([
          {"-Users-cail-felt", @session,
           [
             assistant(
               @t0 + 1_000,
               for i <- 1..9 do
                 %{"type" => "tool_use", "name" => "Bash", "input" => %{"command" => "step #{i}"}}
               end
             )
           ]}
        ])

      brief = Moment.moment(@session, @t0, @t0 + 10_000, root: root)
      assert brief.tool_count == 9
      assert length(brief.tool_lines) == 6
      assert hd(brief.tool_lines) =~ "Bash"

      full = Moment.moment(@session, @t0, @t0 + 10_000, root: root, full: true)
      assert full.tool_count == 9
      assert length(full.tool_lines) == 9
    end

    test "the endpoint carries the tools field whether or not there are words" do
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
      assert wordless["tools"] == "Bash — run the tests\nRead — a.ex\nBash"

      spoken =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @session,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}"
        })
        |> json_response(200)

      assert spoken["excerpts"] != []
      assert spoken["tools"] =~ "Bash"
    end
  end

  describe "Shuttle.Moment — pi transcripts (the second harness)" do
    # The claude root is pinned absent in every lookup below: the fixture
    # session ids are real-shaped and the claude glob runs first, so an
    # unpinned root lets a same-uuid transcript in the real ~/.claude tree
    # shadow the fixture.
    @absent_root "/nope/not/here"

    # A pi-shaped tree: <pi_root>/<encoded-cwd>/<ISO-stamp>_<uuid>.jsonl.
    defp write_pi_tree(files) do
      root =
        Path.join(System.tmp_dir!(), "shuttle_moment_pi_#{System.unique_integer([:positive])}")

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

        File.write!(Path.join(dir, "2026-08-21T18-19-21-052Z_#{session}.jsonl"), body <> "\n")
      end)

      on_exit(fn -> File.rm_rf(root) end)
      root
    end

    defp pi_user(ms, text),
      do: %{
        "type" => "message",
        "timestamp" => iso(ms),
        "message" => %{"role" => "user", "content" => [%{"type" => "text", "text" => text}]}
      }

    defp pi_assistant(ms, blocks),
      do: %{
        "type" => "message",
        "timestamp" => iso(ms),
        "message" => %{"role" => "assistant", "content" => blocks}
      }

    defp pi_tool_call(id, name, args),
      do: %{"type" => "toolCall", "id" => id, "name" => name, "arguments" => args}

    defp pi_tool_result(ms, id, name, text),
      do: %{
        "type" => "message",
        "timestamp" => iso(ms),
        "message" => %{
          "role" => "toolResult",
          "toolCallId" => id,
          "toolName" => name,
          "content" => [%{"type" => "text", "text" => text}]
        }
      }

    defp pi_tree do
      write_pi_tree([
        {"--Users-cail-french--", @session,
         [
           # Non-conversation lines: skipped, none by none.
           %{
             "type" => "session",
             "version" => 3,
             "id" => @session,
             "timestamp" => iso(@t0),
             "cwd" => "/users/cail/french"
           },
           %{
             "type" => "model_change",
             "id" => "mc1",
             "timestamp" => iso(@t0),
             "provider" => "p",
             "modelId" => "m"
           },
           %{
             "type" => "custom_message",
             "customType" => "felt-context",
             "timestamp" => iso(@t0),
             "content" => "# Felt Workflow Context"
           },
           # The conversation.
           pi_user(@t0 + 1_000, "hi french class! pasting some vocab"),
           pi_assistant(@t0 + 2_000, [
             %{"type" => "thinking", "thinking" => "let me consider"},
             %{"type" => "text", "text" => "Bien sûr — here are the definitions."}
           ]),
           # Tool call and result: activity, not words.
           pi_assistant(@t0 + 3_000, [
             pi_tool_call("c1", "bash", %{"command" => "git status --short"})
           ]),
           pi_tool_result(@t0 + 3_500, "c1", "bash", "ok"),
           # After the window.
           pi_user(@t0 + 600_000, "much later")
         ]}
      ])
    end

    test "recovers the conversation and skips the machinery" do
      root = pi_tree()

      assert Enum.map(
               Moment.excerpts(@session, @t0, @t0 + 10_000, root: @absent_root, pi_root: root),
               &{&1.role, &1.text}
             ) == [
               {"user", "hi french class! pasting some vocab"},
               {"assistant", "Bien sûr — here are the definitions."}
             ]
    end

    test "transcript_path finds a pi transcript the claude root does not have" do
      root = pi_tree()

      assert Moment.transcript_path(@session, root: "/nope/not/here", pi_root: root) =~
               "#{@session}.jsonl"

      assert Moment.transcript_path("11111111-2222-3333-4444-555555555555",
               root: "/nope/not/here",
               pi_root: root
             ) == nil
    end

    test "tool calls read like claude's — capitalized name, its own words" do
      root = pi_tree()

      assert %{tool_lines: lines, tool_count: 1} =
               Moment.moment(@session, @t0, @t0 + 10_000, root: @absent_root, pi_root: root)

      assert lines == ["Bash — git status --short"]
    end

    test "a subagent call and its toolResult form the delegation register" do
      root =
        write_pi_tree([
          {"--Users-cail-french--", @session,
           [
             pi_assistant(@t0 + 1_000, [
               pi_tool_call("c2", "subagent", %{
                 "agent" => "reviewer",
                 "task" => "Read the diff and report findings."
               })
             ]),
             pi_user(@t0 + 2_000, "a human turn between the two ends"),
             pi_tool_result(@t0 + 3_000, "c2", "subagent", "Found two issues, both minor.")
           ]}
        ])

      excerpts = Moment.excerpts(@session, @t0, @t0 + 10_000, root: @absent_root, pi_root: root)

      assert Enum.map(excerpts, &{&1.kind, &1.name, &1.text}) == [
               {"spawn", "reviewer", "Read the diff and report findings."},
               {"prose", nil, "a human turn between the two ends"},
               {"return", "reviewer", "Found two issues, both minor."}
             ]
    end
  end

  describe "Shuttle.Moment — Codex rollouts (the third harness)" do
    @absent_root "/nope/not/here"

    defp write_codex_tree(records),
      do: write_codex_tree_at(records, Shuttle.HarnessPaths.local_today())

    defp write_codex_tree_at(records, date) do
      root =
        Path.join(System.tmp_dir!(), "shuttle_moment_codex_#{System.unique_integer([:positive])}")

      dir =
        Path.join([
          root,
          "#{date.year}",
          String.pad_leading("#{date.month}", 2, "0"),
          String.pad_leading("#{date.day}", 2, "0")
        ])

      File.mkdir_p!(dir)

      body =
        records
        |> Enum.map(fn
          line when is_binary(line) -> line
          record -> Jason.encode!(record)
        end)
        |> Enum.join("\n")

      File.write!(
        Path.join(dir, "rollout-2026-08-23T18-19-21-052Z-#{@session}.jsonl"),
        body <> "\n"
      )

      on_exit(fn -> File.rm_rf(root) end)
      root
    end

    defp codex_item(ms, payload),
      do: %{"type" => "response_item", "timestamp" => iso(ms), "payload" => payload}

    defp codex_message(ms, role, blocks),
      do: codex_item(ms, %{"type" => "message", "role" => role, "content" => blocks})

    defp codex_text(type, text), do: %{"type" => type, "text" => text}

    defp codex_custom_call(ms, id, name, input),
      do:
        codex_item(ms, %{
          "type" => "custom_tool_call",
          "call_id" => id,
          "name" => name,
          "input" => input
        })

    defp codex_function_call(ms, id, name, arguments),
      do:
        codex_item(ms, %{
          "type" => "function_call",
          "call_id" => id,
          "name" => name,
          "arguments" => Jason.encode!(arguments)
        })

    defp codex_tool_output(ms, id, output),
      do:
        codex_item(ms, %{"type" => "custom_tool_call_output", "call_id" => id, "output" => output})

    test "finds a Codex rollout in its local date fan-out" do
      root = write_codex_tree([])

      assert Moment.transcript_path(@session,
               root: @absent_root,
               pi_root: @absent_root,
               codex_root: root
             ) =~
               "#{@session}.jsonl"

      assert Moment.transcript_path("11111111-2222-3333-4444-555555555555",
               root: @absent_root,
               pi_root: @absent_root,
               codex_root: root
             ) == nil
    end

    test "finds a historical Codex rollout outside the capture date fan-out" do
      root =
        write_codex_tree_at(
          [codex_message(@t0 + 1_000, "user", [codex_text("input_text", "old codex turn")])],
          Date.add(Shuttle.HarnessPaths.local_today(), -7)
        )

      assert Moment.transcript_path(@session,
               root: @absent_root,
               pi_root: @absent_root,
               codex_root: root
             ) =~ "#{@session}.jsonl"

      assert [%{text: "old codex turn"}] =
               Moment.excerpts(@session, @t0, @t0 + 10_000,
                 root: @absent_root,
                 pi_root: @absent_root,
                 codex_root: root
               )
    end

    test "normalizes words, tools, delegation and peer returns into the shared reader" do
      root =
        write_codex_tree([
          %{
            "type" => "session_meta",
            "timestamp" => iso(@t0),
            "payload" => %{"agent_nickname" => nil}
          },
          codex_message(@t0 + 1_000, "user", [codex_text("input_text", "hello codex")]),
          codex_message(@t0 + 1_500, "developer", [codex_text("input_text", "injected context")]),
          codex_message(@t0 + 2_000, "assistant", [codex_text("output_text", "I can help.")]),
          codex_custom_call(
            @t0 + 3_000,
            "exec-1",
            "exec",
            "const result = await tools.exec_command({cmd: \"git status --short\"});"
          ),
          codex_tool_output(@t0 + 3_500, "exec-1", [codex_text("input_text", "ok")]),
          codex_function_call(@t0 + 4_000, "spawn-1", "spawn_agent", %{
            "task_name" => "reviewer",
            "message" => "gAAAA-encrypted-prompt"
          }),
          codex_tool_output(@t0 + 5_000, "spawn-1", [codex_text("input_text", "review complete")]),
          codex_item(@t0 + 6_000, %{
            "type" => "agent_message",
            "author" => "reviewer",
            "recipient" => "/root",
            "content" => [codex_text("input_text", "peer report")]
          }),
          codex_item(@t0 + 6_500, %{
            "type" => "agent_message",
            "author" => "/root",
            "recipient" => "/root/reviewer",
            "content" => [codex_text("input_text", "outgoing coordination")]
          }),
          codex_item(@t0 + 7_000, %{"type" => "reasoning", "summary" => []})
        ])

      moment =
        Moment.moment(@session, @t0, @t0 + 10_000,
          root: @absent_root,
          pi_root: @absent_root,
          codex_root: root
        )

      assert Enum.map(moment.excerpts, &{&1.kind, &1.name, &1.text}) == [
               {"prose", nil, "hello codex"},
               {"prose", nil, "I can help."},
               {"spawn", "reviewer", "reviewer"},
               {"return", "reviewer", "review complete"},
               {"return", "reviewer", "peer report"}
             ]

      assert moment.tool_lines == ["Exec", "Subagent"]
      assert moment.tool_count == 2
    end

    test "does not turn a spawn launch receipt into a peer report" do
      root =
        write_codex_tree([
          %{
            "type" => "session_meta",
            "timestamp" => iso(@t0),
            "payload" => %{"agent_nickname" => nil}
          },
          codex_function_call(@t0 + 1_000, "spawn-1", "spawn_agent", %{
            "task_name" => "reviewer",
            "message" => "gAAAA-encrypted-prompt"
          }),
          codex_tool_output(
            @t0 + 2_000,
            "spawn-1",
            Jason.encode!(%{"task_name" => "/root/reviewer"})
          ),
          codex_item(@t0 + 3_000, %{
            "type" => "agent_message",
            "author" => "reviewer",
            "recipient" => "/root",
            "content" => [codex_text("input_text", "real peer report")]
          })
        ])

      assert Enum.map(
               Moment.excerpts(@session, @t0, @t0 + 10_000,
                 root: @absent_root,
                 pi_root: @absent_root,
                 codex_root: root
               ),
               &{&1.kind, &1.name, &1.text}
             ) == [
               {"spawn", "reviewer", "reviewer"},
               {"return", "reviewer", "real peer report"}
             ]
    end

    test "uses a child rollout's agent_path for native peer returns" do
      root =
        write_codex_tree([
          %{
            "type" => "session_meta",
            "timestamp" => iso(@t0),
            "payload" => %{
              "agent_nickname" => "reviewer",
              "agent_path" => "/root/review_task",
              "thread_source" => "subagent"
            }
          },
          codex_item(@t0 + 1_000, %{
            "type" => "agent_message",
            "author" => "reviewer",
            "recipient" => "/root/review_task",
            "content" => [codex_text("input_text", "child report")]
          }),
          # A later neutral metadata record must not reset the child identity
          # to /root while reading a compacted or inherited rollout.
          %{
            "type" => "session_meta",
            "timestamp" => iso(@t0 + 2_000),
            "payload" => %{"agent_nickname" => nil, "agent_path" => nil}
          },
          codex_item(@t0 + 3_000, %{
            "type" => "agent_message",
            "author" => "reviewer",
            "recipient" => "/root/review_task",
            "content" => [codex_text("input_text", "child report after metadata")]
          })
        ])

      assert Enum.map(
               Moment.excerpts(@session, @t0, @t0 + 10_000,
                 root: @absent_root,
                 pi_root: @absent_root,
                 codex_root: root
               ),
               &{&1.kind, &1.name, &1.text}
             ) == [
               {"return", "reviewer", "child report"},
               {"return", "reviewer", "child report after metadata"}
             ]
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

    test "full=1 serves the excerpt untruncated; the ordinary fetch still cuts it" do
      # The pinned tooltip's fetch. Relaxing the CSS is not enough — the
      # ellipsis is already in the string the hover fetch was served, so
      # reading the whole sentence takes a round trip.
      long = String.duplicate("la ", 400) |> String.trim()

      root =
        write_tree([{"-Users-cail-french", @other, [user(@t0 + 1_000, long)]}])

      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)

      ask = fn params ->
        build_conn()
        |> get(
          "/api/v1/moment",
          Map.merge(
            %{"session" => @other, "from_ms" => "#{@t0}", "to_ms" => "#{@t0 + 10_000}"},
            params
          )
        )
        |> json_response(200)
      end

      %{"excerpts" => [hover]} = ask.(%{})
      assert String.length(hover["text"]) == Moment.max_chars()
      assert String.ends_with?(hover["text"], "…")

      %{"excerpts" => [pinned]} = ask.(%{"full" => "1"})
      assert pinned["text"] == long
      refute String.ends_with?(pinned["text"], "…")

      # A client that never heard of the parameter, or sends it off, is
      # unaffected — the hover path must not change under it.
      assert ask.(%{"full" => "0"}) == ask.(%{})
    end

    test "full=1 still bounds a pathological turn rather than serving it whole" do
      huge = String.duplicate("x", Moment.max_chars(true) + 500)
      root = write_tree([{"-Users-cail-french", @other, [user(@t0 + 1_000, huge)]}])
      System.put_env("SHUTTLE_CLAUDE_PROJECTS_DIR", root)

      %{"excerpts" => [excerpt]} =
        build_conn()
        |> get("/api/v1/moment", %{
          "session" => @other,
          "from_ms" => "#{@t0}",
          "to_ms" => "#{@t0 + 10_000}",
          "full" => "1"
        })
        |> json_response(200)

      assert String.length(excerpt["text"]) == Moment.max_chars(true)
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
        restore_app_env(:write_forward_client, prior_client)
        restore_app_env(:remotes, prior_remotes)
      end)

      :ok
    end

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
      # The ordinary hover carries no `full`; the owner's default is the same
      # default this daemon would have applied.
      refute url =~ "full="
    end

    test "carries full=1 across the hop, so a pinned remote minute is untruncated too" do
      StubGetFileClient.set_response(
        {:ok, 200, "application/json", Jason.encode!(%{host: "candide", excerpts: []})}
      )

      build_conn()
      |> get("/api/v1/moment", %{
        "session" => @session,
        "from_ms" => "#{@t0}",
        "to_ms" => "#{@t0 + 60_000}",
        "host" => "candide",
        "full" => "1"
      })
      |> json_response(200)

      assert StubGetFileClient.last().url =~ "full=1"
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
