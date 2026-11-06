defmodule Shuttle.Meeting.TranscriptRelayTest do
  use ExUnit.Case, async: true
  alias Shuttle.Meeting.TranscriptRelay
  alias Shuttle.Test.Env
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_DATA_DIR", root)
    {:ok, now} = Agent.start_link(fn -> 1_000 end)

    {:ok, observation} =
      Agent.start_link(fn ->
        {:ok, %{meeting: %{launch: "launch", state: "live", error: nil}}}
      end)

    name = Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivery, message})
      {200, %{delivered: true}}
    end

    opts = [
      name: name,
      directory: Path.join(root, "relays"),
      poll_ms: 60_000,
      clock: fn -> Agent.get(now, & &1) end,
      observe: fn -> Agent.get(observation, & &1) end,
      thresholds: fn _ -> %{"words" => 10, "quiet_seconds" => 4} end,
      deliver: deliver
    ]

    {:ok,
     name: name,
     opts: opts,
     now: now,
     observation: observation,
     path: Path.join(root, "meeting.txt"),
     root: root}
  end

  test "word and name triggers preserve comments, ranges and the closing marker", c do
    File.write!(
      c.path,
      "# S2 = Martin\n10:00:01-10:00:04 S2 one two three four five six seven eight nine\n10:00:05 me hey Klaud\n# ended 10:00:06\n"
    )

    start_monitor(c)
    assert_receive {:delivery, %{text: words} = first}, 1_000
    assert words =~ "Meeting transcript update (Weekly sync)"
    assert words =~ "# S2 = Martin"
    assert words =~ "10:00:01-10:00:04 S2 one two"
    sync_tasks(c)
    poll(c)
    assert_receive {:delivery, %{text: name}}, 1_000
    assert name =~ "hey Klaud"
    sync_tasks(c)
    poll(c)
    assert_receive {:delivery, %{text: ended}}, 1_000
    assert ended =~ "# ended"
    assert first.fiber_id == "fiber-a"
  end

  test "quiet means since the last speech, not the first line or a comment", c do
    File.write!(c.path, "10:00:01 me first words\n")
    start_monitor(c)
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.now, fn _ -> 4_000 end)
    File.write!(c.path, "10:00:02 me another phrase\n", [:append])
    poll(c)
    Agent.update(c.now, fn _ -> 7_000 end)
    File.write!(c.path, "# S2 = Martin\n", [:append])
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.now, fn _ -> 8_000 end)
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "first words\n10:00:02 me another phrase\n# S2 = Martin"
  end

  test "a switch flushes the old buffer, and a late line spoken before it still reaches that target",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "first phrase")
    start_monitor(c, kind: "voice", routes: routes)
    poll(c)

    assert %{pending: %{fiber_id: "fiber-a", text: "me first phrase"}} =
             TranscriptRelay.status("launch", server: c.name)

    route(routes, "2026-11-06T10:00:10Z", "fiber-b")
    # This arrives after the switch, but started before it.
    record(c.path, "2026-11-06T10:00:09Z", "late old words")
    record(c.path, "2026-11-06T10:00:11Z", "new words Claude")
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: first}}, 1_000
    sync_tasks(c)
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: late}}, 1_000
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: new}}, 1_000
    assert first =~ "first phrase"
    assert late =~ "late old words"
    assert new =~ "new words Claude"
    assert new =~ "Live voice:\nme new words Claude"
    refute new =~ "room speech"
    refute new =~ "Cail's spoken words"
    refute new =~ "10:00:11"
    refute first =~ "new words"
    refute new =~ "late old words"
  end

  test "subsecond spoken starts choose the route on their own side of a switch", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00.100000Z", "fiber-a")
    route(routes, "2026-11-06T10:00:00.500000Z", "fiber-b")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:00.499999Z", "old Claude")
    record(c.path, "2026-11-06T10:00:00.500000Z", "new Claude")
    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: old}}, 1_000
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: new}}, 1_000
    assert old =~ "old Claude"
    assert new =~ "new Claude"
  end

  test "voice batches stay FIFO within a target while other targets are independent", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "first Claude")
    record(c.path, "2026-11-06T10:00:02Z", "second Claude")
    parent = self()

    deliver = fn msg ->
      send(parent, {:attempt, self(), msg})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, first, %{text: text}}, 1_000
    assert text =~ "first Claude"
    poll(c)
    refute_receive {:attempt, _, _}, 20
    send(first, :accept)
    sync_tasks(c)
    poll(c)
    assert_receive {:attempt, second, %{text: text}}, 1_000
    assert text =~ "second Claude"
    send(second, :accept)
    sync_tasks(c)
  end

  test "a recorder restart cannot overtake a pending batch to the same destination", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "old Claude")
    parent = self()

    deliver = fn message ->
      send(parent, {:attempt, self(), message})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, old, %{text: text}}, 1_000
    assert text =~ "old Claude"
    next = Path.join(c.root, "next.txt")
    File.write!(next, "")
    record(next, "2026-11-06T10:00:02Z", "new Claude")

    assert :ok =
             TranscriptRelay.start(
               %{launch: "next", transcript: next, kind: "voice", routes_path: routes},
               nil,
               nil,
               server: c.name
             )

    refute_receive {:attempt, _, _}, 50
    send(old, :accept)
    assert_receive {:attempt, new, %{text: text}}, 1_000
    assert text =~ "new Claude"
    send(new, :accept)
  end

  test "recovery reserves older outboxes before a newer launch can register delivery", c do
    directory = Path.join(c.root, "relays")
    File.mkdir_p!(directory)

    for {launch, at, word} <- [
          {"old", "2026-11-06T10:00:00Z", "old"},
          {"new", "2026-11-06T10:01:00Z", "new"}
        ] do
      digest = :crypto.hash(:sha256, launch) |> Base.encode16(case: :lower)

      config = %{
        "launch" => launch,
        "created_at" => at,
        "kind" => "voice",
        "transcript" => c.path,
        "offset" => 0,
        "routes_path" => Path.join(c.root, "routes.jsonl"),
        "ended" => true,
        "outbox" => [
          %{"fiber_id" => "fiber-a", "origin" => "owner", "text" => word, "message_id" => launch}
        ]
      }

      File.write!(Path.join(directory, digest <> ".json"), Jason.encode!(config))
    end

    parent = self()

    deliver = fn message ->
      send(parent, {:attempt, self(), message})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_supervised!({TranscriptRelay, Keyword.put(c.opts, :deliver, deliver)})
    assert_receive {:attempt, old, %{text: "old"}}, 1_000
    refute_receive {:attempt, _, _}, 20
    send(old, :accept)
    assert_receive {:attempt, new, %{text: "new"}}, 1_000
    send(new, :accept)
  end

  test "a final JSON utterance arriving during exit observation is drained before the footer",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "# ended\n")

    observe = fn ->
      record(c.path, "2026-11-06T10:00:01Z", "last spoken words")
      {:ok, %{meeting: nil}}
    end

    c = %{c | opts: Keyword.put(c.opts, :observe, observe)}
    start_monitor(c, kind: "voice", routes: routes)
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "last spoken words\n# ended"
  end

  test "an incomplete final JSON row closes after recorder exit without losing complete words",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "# S2 = colleague\n# ended\n")
    record(c.path, "2026-11-06T10:00:01Z", "complete words")
    json = Path.rootname(c.path) <> ".jsonl"
    File.write!(json, "{\"wall\":", [:append])
    start_monitor(c, kind: "voice", routes: routes)
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.observation, fn _ -> {:ok, %{meeting: nil}} end)
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "me complete words"
    assert text =~ "# S2 = colleague"
    assert text =~ "# incomplete final voice JSON row retained in transcript"
    assert text =~ "# ended"
    assert File.read!(json) =~ "{\"wall\":"
    sync_tasks(c)
    pid = worker(c)
    ref = Process.monitor(pid)
    send(pid, :poll)
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 1_000
  end

  test "a colleague's speaker label is kept without attributing their request to Cail", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")

    File.write!(
      Path.rootname(c.path) <> ".jsonl",
      Jason.encode!(%{
        "wall" => "2026-11-06T10:00:01Z",
        "speaker" => "S2",
        "text" => "Claude make this plot"
      }) <> "\n"
    )

    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text == "Live voice:\nS2 Claude make this plot\n"
  end

  test "a slow or failed voice destination does not hold a later target or retry forever", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    route(routes, "2026-11-06T10:00:10Z", "fiber-b")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:09Z", "old Claude")
    record(c.path, "2026-11-06T10:00:11Z", "new Claude")
    parent = self()

    deliver = fn message ->
      send(parent, {:attempt, self(), message})

      if message.fiber_id == "fiber-a" do
        receive do
          :fail -> {503, %{delivered: false, error: "owner unavailable"}}
        end
      else
        {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, stalled, %{fiber_id: "fiber-a"}}, 1_000
    assert_receive {:attempt, _, %{fiber_id: "fiber-b"}}, 1_000
    send(stalled, :fail)
    sync_tasks(c)
    poll(c)
    refute_receive {:attempt, _, _}, 20

    assert %{last: %{"status" => "failed", "fiber_id" => "fiber-a", "detail" => detail}} =
             TranscriptRelay.status("launch", server: c.name)

    assert detail =~ "owner unavailable"
  end

  test "capture waits for the claim and then delivers from byte zero even after recording ended",
       c do
    File.write!(c.path, "10:00:01 me early words\n# ended\n")
    {:ok, claim} = Agent.start_link(fn -> nil end)
    Agent.update(c.observation, fn _ -> {:ok, %{meeting: nil}} end)
    opts = Keyword.put(c.opts, :claim, fn _ -> Agent.get(claim, & &1) end)
    start_monitor(%{c | opts: opts}, fiber: nil)
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(claim, fn _ -> {"claimed/fiber", "owner"} end)
    poll(c)
    assert_receive {:delivery, %{fiber_id: "claimed/fiber", origin: "owner", text: text}}, 1_000
    assert text =~ "early words"
    assert text =~ "# ended"
  end

  test "the scribe can rename its provisional fiber without changing the relay destination", c do
    File.write!(c.path, "10:00:01 me early words\n")
    uid = "01M6S8NKA5PKK6W95RW3R1FD8P"

    {:ok, fiber} =
      Agent.start_link(fn ->
        %{
          "uid" => uid,
          "id" => uid,
          "slug" => "meetings/provisional",
          "shuttle" => %{"host" => "owner", "runtime" => %{"meeting" => "launch"}}
        }
      end)

    Env.put_app_env(:meeting_fibers, fn -> [Agent.get(fiber, & &1)] end)

    Agent.update(c.observation, fn _ ->
      {:ok,
       %{meeting: %{launch: "launch", fiber: "meetings/provisional", state: "live", error: nil}}}
    end)

    start_monitor(c, fiber: nil)
    poll(c)
    Agent.update(fiber, &Map.put(&1, "slug", "meetings/real-title"))
    File.write!(c.path, "10:00:02 me Claude\n", [:append])
    poll(c)
    assert_receive {:delivery, %{fiber_id: ^uid, text: text}}, 1_000
    assert text =~ "early words"
  end

  test "restart recovers buffered words and reads only the appended suffix", c do
    File.write!(c.path, "10:00:01 me before crash\n")
    start_monitor(c)
    poll(c)
    stop_supervised!(TranscriptRelay)
    File.write!(c.path, "10:00:02 me after restart Claude\n", [:append])
    start_supervised!({TranscriptRelay, c.opts})
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "before crash"
    assert text =~ "after restart Claude"
    assert length(Regex.scan(~r/before crash/, text)) == 1
  end

  test "unconfirmed meeting deliveries retain their message id across a monitor restart", c do
    File.write!(c.path, "10:00:01 me Claude keep this\n# ended\n")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivery, message})
      {202, %{delivered: nil}}
    end

    c = %{c | opts: Keyword.put(c.opts, :deliver, deliver)}
    start_monitor(c)
    assert_receive {:delivery, first}, 1_000
    stop_supervised!(TranscriptRelay)
    start_supervised!({TranscriptRelay, c.opts})
    assert_receive {:delivery, retry}, 1_000
    assert retry.message_id == first.message_id
    assert retry.text == first.text
  end

  test "completed launches are not replayed when the recorder is still stopping or the daemon restarts",
       c do
    File.write!(c.path, "one line\n# ended\n")
    start_monitor(c)
    assert_receive {:delivery, _}, 1_000
    sync_tasks(c)
    worker = worker(c)
    ref = Process.monitor(worker)
    send(worker, :poll)
    assert_receive {:DOWN, ^ref, :process, ^worker, :normal}, 1_000

    assert :ok =
             TranscriptRelay.start(%{launch: "launch", transcript: c.path}, "fiber-a", "owner",
               server: c.name
             )

    stop_supervised!(TranscriptRelay)
    start_supervised!({TranscriptRelay, c.opts})
    :sys.get_state(Module.concat(c.name, Coordinator))
    refute_receive {:delivery, _}, 20
  end

  test "partial lines stay unconsumed and the reader never rereads the consumed prefix", c do
    File.write!(c.path, "10:00:01 me buffered\n10:00:02 me Cla")
    start_monitor(c)
    poll(c)
    refute_receive {:delivery, _}, 20
    # Replace the consumed bytes with equally long junk. Offset reading must not see it.
    {:ok, file} = :file.open(c.path, [:read, :write, :binary])
    :ok = :file.pwrite(file, 0, String.duplicate("X", byte_size("10:00:01 me buffered")))
    :ok = :file.close(file)
    File.write!(c.path, "ude\n", [:append])
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "buffered\n10:00:02 me Claude"
    refute text =~ "XXXXX"
  end

  defp start_monitor(c, extra \\ []) do
    opts = Keyword.merge(c.opts, Keyword.take(extra, [:deliver]))
    start_supervised!({TranscriptRelay, opts})

    row = %{
      launch: "launch",
      transcript: c.path,
      title: "Weekly sync",
      kind: Keyword.get(extra, :kind, "meeting"),
      routes_path: extra[:routes]
    }

    assert :ok =
             TranscriptRelay.start(row, Keyword.get(extra, :fiber, "fiber-a"), "owner",
               server: c.name
             )
  end

  defp worker(c) do
    [{_, pid, _, _}] = DynamicSupervisor.which_children(Module.concat(c.name, DynamicSupervisor))
    pid
  end

  defp poll(c) do
    pid = worker(c)
    send(pid, :poll)
    GenServer.call(pid, :status)
  end

  defp sync_tasks(c) do
    pid = worker(c)
    state = :sys.get_state(pid)

    for {ref, _} <- state.tasks do
      # Task result is sent before :DOWN; observing the task exit and then the
      # worker mailbox gives the worker a deterministic completion barrier.
      case Process.info(pid, :monitors) do
        {:monitors, monitors} ->
          for {:process, task} <- monitors, is_pid(task) do
            task_ref = Process.monitor(task)

            receive do
              {:DOWN, ^task_ref, :process, ^task, _} -> :ok
            after
              1_000 -> flunk("delivery did not finish #{inspect(ref)}")
            end
          end

        nil ->
          :ok
      end
    end

    GenServer.call(pid, :status)
  end

  defp route(path, at, fiber),
    do:
      File.write!(
        path,
        Jason.encode!(%{"t" => at, "fiber_id" => fiber, "origin" => "owner"}) <> "\n",
        [:append]
      )

  defp record(path, at, text),
    do:
      File.write!(
        Path.rootname(path) <> ".jsonl",
        Jason.encode!(%{"wall" => at, "speaker" => "me", "text" => text}) <> "\n",
        [:append]
      )
end
