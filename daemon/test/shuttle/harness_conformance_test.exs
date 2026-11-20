defmodule Shuttle.HarnessConformanceTest do
  @moduledoc """
  Every harness module against the shared conformance fixtures
  (`test/fixtures/harnesses/`): the Go registry's table of facts, and per
  harness a fixed agent record with its expected command lines and a recorded
  transcript. The Go suite reads the same table and transcripts
  (`internal/harness`, `internal/transcriptindex`).
  """
  use ExUnit.Case, async: true

  alias Shuttle.{Agents, Harness, TranscriptUsage}

  @fixtures Path.expand("../fixtures/harnesses", __DIR__)
  @facts @fixtures |> Path.join("facts.json") |> File.read!() |> Jason.decode!()
  @names Path.expand("../fixtures/harness_names.json", __DIR__)
         |> File.read!()
         |> Jason.decode!()
         |> Map.fetch!("names")

  defp fixture(harness, file), do: Path.join([@fixtures, harness, file])

  test "each harness in the Go table has one module, which answers as the table does" do
    assert length(Harness.modules()) == length(@facts)

    for facts <- @facts do
      module = Harness.module(facts["name"])
      assert module, "no Shuttle.Harness module for #{facts["name"]}"
      assert Harness.module(facts["ledger"]) == module
      assert module.name() == facts["name"]
      assert module.ledger_name() == facts["ledger"]
      assert module.binary() == facts["binary"]
      assert module.identity() == facts["identity"]
      assert module.idle_signal?() == facts["idle_signal"]
      assert module.interrupts?() == facts["interrupts"]
      assert module.takes_paste?() == facts["delivery"] in ["paste", "inject"]
    end
  end

  test "names normalize to the shared address vocabulary" do
    for {spelling, canonical} <- @names do
      assert Harness.normalize(spelling) == canonical
      assert Harness.supported?(spelling)
    end

    assert Harness.ledger_name("claude") == "claude-code"
    assert Harness.ledger_name("claude-code") == "claude-code"
    assert Harness.ledger_name("unknown") == nil
    assert Harness.ledger_name(nil) == nil
    refute Harness.supported?("unknown")
  end

  test "each harness renders the fixture record's launch and resume command lines" do
    for %{"name" => name} <- @facts do
      cases = name |> fixture("commands.json") |> File.read!() |> Jason.decode!()
      agent = Agents.from_resolved(cases["agent"])
      opts = [session_id: cases["session"], work_dir: cases["work_dir"]]
      expect = cases["expect"]

      assert Agents.build_command(agent, cases["prompt"], opts) == expect["launch"], name

      assert Agents.build_command(%{agent | headless: true}, cases["prompt"], opts) ==
               expect["launch_headless"],
             name

      assert Agents.build_resume_command(agent, cases["session"], cases["prompt"], opts) ==
               expect["resume"],
             name

      assert Agents.build_resume_command(agent, cases["session"], "  ", opts) ==
               expect["resume_quiet"],
             name
    end
  end

  test "each harness's readers take every record of its recorded transcript" do
    for %{"name" => name, "interrupts" => interrupts?} <- @facts do
      module = Harness.module(name)

      records =
        name
        |> fixture("transcript.jsonl")
        |> File.stream!()
        |> Enum.map(&Jason.decode!/1)

      for record <- records do
        assert is_list(module.usage_entries(record))
        turn = module.turn_record(record)
        assert turn in [nil, :other] or match?({:interrupted, _, _}, turn)
        if not interrupts?, do: assert(turn == nil)
      end
    end
  end

  @tag :tmp_dir
  test "an Antigravity worker's conversation is the session start its hooks reported", %{
    tmp_dir: tmp
  } do
    id = "e63c2d73-3d33-457e-9457-0ab8670fac39"
    work = Path.join(tmp, "work")
    File.mkdir_p!(work)
    brain = Path.join(tmp, "brain")
    logs = Path.join([brain, id, ".system_generated", "logs"])
    File.mkdir_p!(logs)
    File.cp!(fixture("antigravity", "transcript.jsonl"), Path.join(logs, "transcript_full.jsonl"))
    events = Path.join(tmp, "events.jsonl")
    Shuttle.Test.Env.put_env("SHUTTLE_ANTIGRAVITY_BRAIN_DIR", brain)
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", events)
    dispatched = ~U[2026-11-20 00:02:49Z]
    at = DateTime.to_unix(dispatched, :millisecond)

    start = fn id, cwd, at ->
      Jason.encode!(%{
        "type" => "session_start",
        "harness" => "antigravity",
        "sessionId" => id,
        "cwd" => cwd,
        "timestamp" => at
      }) <> "\n"
    end

    # Another conversation in the same checkout, and one from before the dispatch.
    File.write!(
      events,
      start.(id, work, at - 60_000) <>
        start.(id, work, at + 1_000) <>
        start.("ffffffff-0000-4000-8000-000000000000", work, at + 2_000)
    )

    agy = Shuttle.Harness.Antigravity
    assert {:ok, ^id} = agy.find_session(work, dispatched, fiber_id: "demo/fixture")
    assert :error = agy.find_session(work, dispatched, fiber_id: "demo/other")
    assert :error = agy.find_session(tmp, dispatched, fiber_id: "demo/fixture")
    assert :error = agy.find_session(work, DateTime.add(dispatched, 60), fiber_id: "demo/fixture")
    assert agy.transcript_cwd(Path.join(logs, "transcript_full.jsonl")) == work
    assert Shuttle.Transcript.path(id) == Path.join(logs, "transcript_full.jsonl")
  end

  # Capture once matched `Fiber: a/b` as a substring, so a worker on fiber
  # `a/b` bound the conversation of a concurrently started `a/b-review` in the
  # same checkout (pi and Codex, and Antigravity after them). Real fiber ids
  # also carry `.` and non-ASCII letters (`.../comparison.partial`). Each
  # extending conversation starts later, so both scans meet it first.
  @tag :tmp_dir
  test "a fiber's capture never binds the conversation of a fiber whose id extends it", %{
    tmp_dir: tmp
  } do
    work = Path.join(tmp, "work")
    File.mkdir_p!(work)
    dispatched = DateTime.utc_now()
    at = DateTime.to_unix(dispatched, :millisecond)

    fibers = [
      {"11111111-1111-4111-8111-111111111111", "a/b"},
      {"22222222-2222-4222-8222-222222222222", "a/b-review"},
      {"33333333-3333-4333-8333-333333333333", "a/b.c"},
      {"44444444-4444-4444-8444-444444444444", "a/bé"}
    ]

    prompt = fn fiber -> "You are a Shuttle worker.\nFiber: #{fiber}\nGo." end

    Shuttle.Test.Env.put_env("SHUTTLE_PI_SESSIONS_DIR", Path.join(tmp, "pi"))
    sessions = Shuttle.HarnessPaths.pi_sessions_dir(work)
    File.mkdir_p!(sessions)

    for {{id, fiber}, n} <- Enum.with_index(fibers, 1) do
      header = %{
        "type" => "session",
        "id" => id,
        "cwd" => work,
        "timestamp" => DateTime.to_iso8601(dispatched)
      }

      message = %{"type" => "message", "content" => prompt.(fiber)}

      File.write!(
        Path.join(sessions, "#{n}.jsonl"),
        Jason.encode!(header) <> "\n" <> Jason.encode!(message) <> "\n"
      )
    end

    for {id, fiber} <- fibers do
      assert {:ok, ^id} = Harness.Pi.find_session(work, dispatched, fiber_id: fiber)
    end

    brain = Path.join(tmp, "brain")
    events = Path.join(tmp, "events.jsonl")
    Shuttle.Test.Env.put_env("SHUTTLE_ANTIGRAVITY_BRAIN_DIR", brain)
    Shuttle.Test.Env.put_env("SHUTTLE_EVENTS_FILE", events)

    for {{id, fiber}, n} <- Enum.with_index(fibers, 1) do
      logs = Path.join([brain, id, ".system_generated", "logs"])
      File.mkdir_p!(logs)
      step = %{"source" => "USER_EXPLICIT", "type" => "USER_INPUT", "content" => prompt.(fiber)}
      File.write!(Path.join(logs, "transcript_full.jsonl"), Jason.encode!(step) <> "\n")

      start = %{
        "type" => "session_start",
        "harness" => "antigravity",
        "sessionId" => id,
        "cwd" => work,
        "timestamp" => at + 100 * n
      }

      File.write!(events, Jason.encode!(start) <> "\n", [:append])
    end

    for {id, fiber} <- fibers do
      assert {:ok, ^id} = Harness.Antigravity.find_session(work, dispatched, fiber_id: fiber)
    end
  end

  test "an Antigravity transcript's tail gives its latest turn's context and cache reads" do
    usage = TranscriptUsage.read(fixture("antigravity", "transcript.jsonl"), "antigravity")

    assert %{context: 13_687, cached: 11_435, hit_share: hit_share, at: at} = usage
    assert at == DateTime.to_unix(~U[2026-11-20 00:03:34Z], :millisecond)

    assert hit_share ==
             Float.round((11_212 + 11_348 + 11_435) / (13_261 + 13_393 + 13_476 + 13_687), 3)
  end
end
