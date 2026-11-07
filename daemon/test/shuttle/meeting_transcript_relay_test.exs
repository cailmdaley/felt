defmodule Shuttle.Meeting.TranscriptRelayTest do
  use ExUnit.Case, async: true
  alias Shuttle.Meeting.TranscriptRelay
  alias Shuttle.Test.Env
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_DATA_DIR", root)
    now = start_supervised!(Supervisor.child_spec({Agent, fn -> 1_000 end}, id: :clock))

    observation =
      start_supervised!(
        Supervisor.child_spec(
          {Agent,
           fn ->
             {:ok, %{meeting: %{launch: "launch", state: "live", error: nil}}}
           end},
          id: :observation
        )
      )

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
      deliver: deliver,
      cold: fn _ -> false end
    ]

    {:ok,
     name: name,
     opts: opts,
     now: now,
     observation: observation,
     path: Path.join(root, "meeting.txt"),
     root: root}
  end

  test "a relay ignores the port exits its trapped shell calls leave behind" do
    state = %{marker: true}
    port = Port.open({:spawn, "true"}, [])
    exit = {:EXIT, port, :normal}

    assert TranscriptRelay.Worker.handle_info(exit, state) == {:noreply, state}
    assert TranscriptRelay.Coordinator.handle_info(exit, state) == {:noreply, state}
  end

  test "a blocked worker status does not block the coordinator", c do
    File.write!(c.path, "")
    start_monitor(c)
    pid = worker(c)
    :ok = :sys.suspend(pid)
    on_exit(fn -> if Process.alive?(pid), do: :sys.resume(pid) end)
    task = Task.async(fn -> TranscriptRelay.status("launch", server: c.name, timeout: 100) end)

    assert %{pending: nil, last: nil, error: nil} =
             TranscriptRelay.status("other", server: c.name, timeout: 50)

    assert Task.await(task) == :timeout
    :ok = :sys.resume(pid)
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
    assert first.kind == "meeting"
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

  test "quiet counts from the spoken end, and speech in progress holds the batch", c do
    {date, {hour, minute, second}} = :calendar.local_time()
    ended = NaiveDateTime.from_erl!({date, {hour, minute, second}}) |> NaiveDateTime.add(-10)
    stamp = ended |> NaiveDateTime.to_time() |> Time.to_iso8601()
    partial = Path.rootname(c.path) <> ".partial"
    File.write!(partial, "me: still talking")
    File.write!(c.path, "#{stamp}-#{stamp} me finished a while ago\n")
    start_monitor(c)
    poll(c)
    refute_receive {:delivery, _}, 20
    File.write!(partial, "")
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "finished a while ago"
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
    record(c.path, "2026-11-06T10:00:11Z", "new words send")
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: first}}, 1_000
    sync_tasks(c)
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: late}}, 1_000
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: new}}, 1_000
    assert first =~ "first phrase"
    assert late =~ "late old words"
    assert new =~ "new words"
    assert new == "me: new words\n"
    refute new =~ "room speech"
    refute new =~ "Cail's spoken words"
    refute new =~ "10:00:11"
    refute first =~ "new words"
    refute new =~ "late old words"
  end

  test "voice skips hark's name, pause and loss records and keeps delivering", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")

    File.write!(
      Path.rootname(c.path) <> ".jsonl",
      [
        ~s({"wall": "2026-11-06T10:00:01", "name": {"speaker": "S1", "as": "me"}}),
        ~s({"wall": "2026-11-06T10:00:02", "pause": {"track": "mic", "state": "paused"}}),
        ~s({"wall": "2026-11-06T10:00:03", "lost": {"track": "mic", "at": "10:00:02"}}),
        ~s({"wall": "2026-11-06T10:00:04+00:00", "track": "mic", "speaker": "S1", "name": "me", "start": 4.0, "end": 5.0, "text": "still heard send"})
      ]
      |> Enum.join("\n")
      |> Kernel.<>("\n")
    )

    start_monitor(c, kind: "voice", routes: routes)
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: text}}, 1_000
    assert text =~ "me: still heard"
  end

  test "subsecond spoken starts choose the route on their own side of a switch", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00.100000Z", "fiber-a")
    route(routes, "2026-11-06T10:00:00.500000Z", "fiber-b")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:00.499999Z", "old send")
    record(c.path, "2026-11-06T10:00:00.500000Z", "new send")
    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: old}}, 1_000
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: new}}, 1_000
    assert old =~ "old"
    assert new =~ "new"
  end

  test "voice batches stay FIFO within a target while other targets are independent", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "first send")
    record(c.path, "2026-11-06T10:00:02Z", "second send")
    parent = self()

    deliver = fn msg ->
      send(parent, {:attempt, self(), msg})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, first, %{text: text}}, 1_000
    assert text =~ "first"
    poll(c)
    refute_receive {:attempt, _, _}, 20
    send(first, :accept)
    sync_tasks(c)
    poll(c)
    assert_receive {:attempt, second, %{text: text}}, 1_000
    assert text =~ "second"
    send(second, :accept)
    sync_tasks(c)
  end

  test "a recorder restart cannot overtake a pending batch to the same destination", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "old send")
    parent = self()

    deliver = fn message ->
      send(parent, {:attempt, self(), message})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, old, %{text: text}}, 1_000
    assert text =~ "old"
    next = Path.join(c.root, "next.txt")
    File.write!(next, "")
    record(next, "2026-11-06T10:00:02Z", "new send")

    assert :ok =
             TranscriptRelay.start(
               %{
                 launch: "next",
                 transcript: next,
                 kind: "voice",
                 routes_path: routes,
                 started_at: "2026-11-06T10:00:02Z"
               },
               nil,
               nil,
               server: c.name
             )

    refute_receive {:attempt, _, _}, 50
    send(old, :accept)
    assert_receive {:attempt, new, %{text: text}}, 1_000
    assert text =~ "new"
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
    assert text =~ "last spoken words\n"
    refute text =~ "# ended"
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
    assert text =~ "complete words"
    refute text =~ "#"
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
        "text" => "Claude make this plot, send"
      }) <> "\n"
    )

    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text == "S2: Claude make this plot\n"
  end

  test "voice groups consecutive speakers without headers or timestamps", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")

    for {at, speaker, text} <- [
          {"2026-11-06T10:00:01Z", "me", "one"},
          {"2026-11-06T10:00:02Z", "me", "two"},
          {"2026-11-06T10:00:03Z", "S2", "three"},
          {"2026-11-06T10:00:04Z", "S2", "four"},
          {"2026-11-06T10:00:05Z", "me", "five send"}
        ] do
      File.write!(
        Path.rootname(c.path) <> ".jsonl",
        Jason.encode!(%{wall: at, speaker: speaker, text: text}) <> "\n",
        [:append]
      )
    end

    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, %{text: first}}, 1_000
    assert first == "me: one two\nS2: three four\nme: five\n"
    sync_tasks(c)
    record(c.path, "2026-11-06T10:10:05Z", "no timestamp send")
    poll(c)
    assert_receive {:delivery, %{text: "me: no timestamp\n"}}, 1_000
    sync_tasks(c)
    record(c.path, "2026-11-06T10:20:06Z", "after silence send")
    poll(c)
    assert_receive {:delivery, %{text: "me: after silence\n"}}, 1_000
  end

  test "a slow or failed voice destination does not hold a later target or retry forever", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    route(routes, "2026-11-06T10:00:10Z", "fiber-b")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:09Z", "old send")
    record(c.path, "2026-11-06T10:00:11Z", "new send")
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
    sync_target(c, "fiber-b")
    send(stalled, :fail)
    sync_tasks(c)
    poll(c)
    refute_receive {:attempt, _, _}, 20

    assert %{last: %{"status" => "failed", "fiber_id" => "fiber-a", "detail" => detail}} =
             TranscriptRelay.status("launch", server: c.name)

    assert detail =~ "owner unavailable"
  end

  test "capture waits for the claim while live and then delivers from byte zero",
       c do
    File.write!(c.path, "10:00:01 me early words\n# ended\n")
    {:ok, claim} = Agent.start_link(fn -> nil end)
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

  test "failed meeting deliveries retain their message id across a monitor restart", c do
    File.write!(c.path, "10:00:01 me Claude keep this\n# ended\n")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivery, message})
      {503, %{delivered: false}}
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

  test "an unconfirmed voice delivery is reported honestly without automatic replay", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "unconfirmed probe send")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivery, message})

      {202,
       %{"delivered" => nil, "detail" => "native acknowledgement lacked correlated evidence"}}
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:delivery, _}, 1_000
    sync_tasks(c)

    assert %{
             last: %{
               "status" => "unconfirmed",
               "detail" => "The message may have arrived. The transcript retains the words."
             }
           } =
             TranscriptRelay.status("launch", server: c.name)

    poll(c)
    refute_receive {:delivery, _}, 20
    stop_supervised!(TranscriptRelay)
    start_supervised!({TranscriptRelay, Keyword.put(c.opts, :deliver, deliver)})
    :sys.get_state(Module.concat(c.name, Coordinator))
    refute_receive {:delivery, _}, 20
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

  test "an unclaimed capture completes when the meeting ends and cannot claim a later meeting",
       c do
    File.write!(c.path, "early words\n# ended\n")
    {:ok, claim} = Agent.start_link(fn -> nil end)
    opts = Keyword.put(c.opts, :claim, fn _ -> Agent.get(claim, & &1) end)
    start_monitor(%{c | opts: opts}, fiber: nil)
    poll(c)
    pid = worker(c)
    ref = Process.monitor(pid)
    Agent.update(c.observation, fn _ -> {:ok, %{meeting: nil}} end)
    send(pid, :poll)
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 1_000
    assert %{"completed" => true} = Jason.decode!(File.read!(relay_path(c, "launch")))
    assert File.read!(c.path) == "early words\n# ended\n"
    Agent.update(claim, fn _ -> {"later/fiber", "owner"} end)

    assert :ok =
             TranscriptRelay.start(%{launch: "launch", transcript: c.path}, nil, nil,
               server: c.name
             )

    refute_receive {:delivery, _}, 20
  end

  test "new voice captures retain only the launch anchor and in-capture switches across recovery",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    # More than one route read chunk, with irrelevant global history.
    for i <- 1..2_000 do
      route(routes, "2026-11-05T10:00:00Z", "old-#{i}")
    end

    route(routes, "2026-11-06T09:59:59Z", "anchor")
    route(routes, "2026-11-06T10:00:10Z", "fiber-b")
    route(routes, "2026-11-06T10:00:20Z", "fiber-c")
    File.write!(c.path, "")
    # A partial route must not prevent reading utterances.
    File.write!(routes, "{", [:append])
    record(c.path, "2026-11-06T10:00:11Z", "initial words")
    start_monitor(c, kind: "voice", routes: routes)
    assert %{error: nil} = poll(c)
    config = Jason.decode!(File.read!(relay_path(c, "launch")))

    assert [%{"fiber_id" => "anchor"}, %{"fiber_id" => "fiber-b"}, %{"fiber_id" => "fiber-c"}] =
             config["routes"]

    stop_supervised!(TranscriptRelay)
    record(c.path, "2026-11-06T10:00:01Z", "late anchor Claude")
    record(c.path, "2026-11-06T10:00:12Z", "late middle Claude")
    start_supervised!({TranscriptRelay, c.opts})
    assert_receive {:delivery, %{fiber_id: "anchor", text: anchor}}, 1_000
    assert anchor =~ "late anchor Claude"
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: initial}}, 1_000
    assert initial =~ "initial words"
    sync_tasks(c)
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-b", text: middle}}, 1_000
    assert middle =~ "late middle Claude"
    refute middle =~ "late anchor"
  end

  test "idle polling does not rewrite unchanged durable relay state", c do
    File.write!(c.path, "pending words\n")
    start_monitor(c)
    poll(c)
    path = relay_path(c, "launch")
    %{inode: inode} = File.stat!(path)
    bytes = File.read!(path)
    for _ <- 1..3, do: assert(%{error: nil} = poll(c))
    assert %{inode: ^inode} = File.stat!(path)
    assert File.read!(path) == bytes
  end

  for {label, line} <- [
        {"JSON", "not-json"},
        {"timestamp", ~s({"t":"not-a-time","fiber_id":"fiber-a"})},
        {"shape", ~s({"t":"2026-11-06T10:00:00Z","fiber_id":23})}
      ] do
    test "malformed route #{label} degrades only that relay and exposes an error", c do
      routes = Path.join(c.root, "routes.jsonl")
      File.write!(routes, unquote(line) <> "\n")
      assert_isolated_failure(c, %{kind: "voice", routes_path: routes})
    end
  end

  for {label, line} <- [
        {"JSON", "not-json"},
        {"timestamp", ~s({"wall":"not-a-time","speaker":"me","text":"Claude"})},
        {"shape", ~s({"wall":"2026-11-06T10:00:00Z","speaker":{},"text":5})}
      ] do
    test "malformed voice transcript #{label} degrades only that relay", c do
      routes = Path.join(c.root, "routes.jsonl")
      route(routes, "2026-11-06T10:00:00Z", "fiber-a")
      File.write!(Path.rootname(c.path) <> ".jsonl", unquote(line) <> "\n")
      assert_isolated_failure(c, %{kind: "voice", routes_path: routes})
    end
  end

  test "invalid text encoding degrades one meeting relay without a restart cascade", c do
    assert_isolated_failure(c, %{}, <<255, 10>>)
  end

  for {label, bytes} <- [
        {"JSON", "{"},
        {"outbox", ~s({"launch":"broken","transcript":"ignored","offset":0,"outbox":[42]})},
        {"buffers", ~s({"launch":"broken","transcript":"ignored","offset":0,"buffers":{}})}
      ] do
    test "malformed durable #{label} is isolated during recovery and start returns an error", c do
      File.mkdir_p!(Path.join(c.root, "relays"))
      File.write!(relay_path(c, "broken"), unquote(bytes))
      File.write!(c.path, "Claude healthy\n")
      start_monitor(c)
      assert_receive {:delivery, %{text: text}}, 1_000
      assert text =~ "healthy"
      assert %{error: error} = TranscriptRelay.status("broken", server: c.name)
      assert is_binary(error) and error != ""

      assert {:error, _} =
               TranscriptRelay.start(%{launch: "broken", transcript: c.path}, "fiber-a", "owner",
                 server: c.name
               )

      assert Process.alive?(Process.whereis(Module.concat(c.name, Supervisor)))
    end
  end

  test "start returns errors for unavailable coordinator and unwritable relay directory", c do
    assert {:error, _} = TranscriptRelay.start(%{}, nil, nil, server: c.name)
    directory = Path.join(c.root, "relays")
    File.write!(directory, "not a directory")
    start_supervised!({TranscriptRelay, c.opts})
    coordinator = Process.whereis(Module.concat(c.name, Coordinator))

    assert {:error, _} =
             TranscriptRelay.start(%{launch: "launch", transcript: c.path}, "fiber-a", "owner",
               server: c.name
             )

    assert %{error: error} = TranscriptRelay.status("launch", server: c.name)
    assert is_binary(error)
    assert Process.alive?(coordinator)
    File.rm!(directory)
    File.write!(c.path, "Claude still healthy\n")

    assert :ok =
             TranscriptRelay.start(%{launch: "healthy", transcript: c.path}, "fiber-a", "owner",
               server: c.name
             )

    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "still healthy"
  end

  test "a failed state write retains the durable offset and outbox without sending new words",
       c do
    File.write!(c.path, "buffered words\n")
    start_monitor(c)
    poll(c)
    path = relay_path(c, "launch")
    bytes = File.read!(path)
    File.rename!(path, path <> ".saved")
    File.mkdir!(path)
    File.write!(c.path, "Claude trigger\n", [:append])
    assert %{error: error} = poll(c)
    assert is_binary(error) and error != ""
    refute_receive {:delivery, _}, 20
    assert File.read!(path <> ".saved") == bytes
    assert Process.alive?(Process.whereis(Module.concat(c.name, Supervisor)))
    # Repair and restart recovers the unacknowledged suffix from the durable offset.
    stop_supervised!(TranscriptRelay)
    File.rmdir!(path)
    File.rename!(path <> ".saved", path)
    start_supervised!({TranscriptRelay, c.opts})
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text =~ "buffered words\nClaude trigger"
  end

  test "a failed acknowledgement write does not replay voice after restart", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "durable words send")
    File.mkdir!(Shuttle.Voice.last_path())
    start_monitor(c, kind: "voice", routes: routes)
    assert_receive {:delivery, first}, 1_000
    sync_tasks(c)
    assert %{error: error} = TranscriptRelay.status("launch", server: c.name)
    assert is_binary(error) and error != ""
    assert [%{"message_id" => id}] = Jason.decode!(File.read!(relay_path(c, "launch")))["outbox"]
    assert id == first.message_id
    assert Process.alive?(Process.whereis(Module.concat(c.name, Supervisor)))
    stop_supervised!(TranscriptRelay)
    File.rmdir!(Shuttle.Voice.last_path())
    start_supervised!({TranscriptRelay, c.opts})

    assert %{last: %{"status" => "unconfirmed", "fiber_id" => "fiber-a"}} =
             TranscriptRelay.status("launch", server: c.name)

    refute_receive {:delivery, _}, 100
  end

  test "a delivery task exiting after its side effect leaves voice unconfirmed and is not replayed",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "once send")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivered_side_effect, message})
      exit(:lost_receipt)
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:delivered_side_effect, %{kind: "voice"}}, 1_000
    sync_tasks(c)

    assert %{last: %{"status" => "unconfirmed"}} =
             TranscriptRelay.status("launch", server: c.name)

    stop_supervised!(TranscriptRelay)
    start_supervised!({TranscriptRelay, Keyword.put(c.opts, :deliver, deliver)})
    refute_receive {:delivered_side_effect, _}, 100
  end

  test "an in-flight voice batch is not replayed after relay restart", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "once send")
    parent = self()

    deliver = fn message ->
      send(parent, {:delivery, message})

      receive do
        :finish -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:delivery, %{kind: "voice"}}, 1_000
    stop_supervised!(TranscriptRelay)
    start_supervised!({TranscriptRelay, Keyword.put(c.opts, :deliver, deliver)})

    assert %{last: %{"status" => "unconfirmed"}} =
             TranscriptRelay.status("launch", server: c.name)

    refute_receive {:delivery, _}, 100
  end

  test "a non-encodable start row returns an error without stopping existing relays", c do
    File.write!(c.path, "waiting words\n")
    start_monitor(c)
    poll(c)
    pid = worker(c)

    assert {:error, _} =
             TranscriptRelay.start(
               %{launch: "broken", transcript: c.path, title: {:bad}},
               "fiber-a",
               "owner",
               server: c.name
             )

    assert Process.alive?(pid)

    assert %{pending: %{text: "waiting words"}, error: nil} =
             TranscriptRelay.status("launch", server: c.name)
  end

  test "voice start requires actual capture time instead of guessing from relay registration",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    start_supervised!({TranscriptRelay, c.opts})
    row = %{launch: "launch", transcript: c.path, kind: "voice", routes_path: routes}

    for at <- [nil, "not-a-time"] do
      assert {:error, :capture_start_required} =
               TranscriptRelay.start(Map.put(row, :started_at, at), nil, nil, server: c.name)
    end

    refute File.exists?(relay_path(c, "launch"))

    assert :ok =
             TranscriptRelay.start(Map.put(row, :started_at, "2026-11-06T10:00:00Z"), nil, nil,
               server: c.name
             )

    assert %{error: nil} = poll(c)
  end

  for failure <- [:startup, :poll] do
    test "a recovered relay quarantined during #{failure} releases its nil-owned lane reservations",
         c do
      File.mkdir_p!(Path.join(c.root, "relays"))
      File.write!(c.path, "")
      routes = Path.join(c.root, "routes.jsonl")
      File.write!(routes, "not-json\n")

      for {launch, at} <- [{"old", "2026-11-06T10:00:00Z"}, {"new", "2026-11-06T10:01:00Z"}] do
        config = %{
          "launch" => launch,
          "created_at" => at,
          "kind" => if(launch == "old", do: "voice", else: "meeting"),
          "transcript" => c.path,
          "routes_path" => routes,
          "offset" => 0,
          "ended" => launch == "new",
          "outbox" => [
            %{
              "fiber_id" => "fiber-a",
              "origin" => "owner",
              "text" => launch,
              "message_id" => launch
            }
          ]
        }

        path =
          if launch == "old" and unquote(failure) == :startup,
            do: Path.join([c.root, "relays", "old.json"]),
            else: relay_path(c, launch)

        File.write!(path, Jason.encode!(config))
      end

      if unquote(failure) == :startup, do: File.mkdir!(relay_path(c, "old"))
      start_supervised!({TranscriptRelay, c.opts})
      # The old relay never attaches its reserved outbox to a delivery request.
      # Its quarantine must not permanently hold the newer same-target batch.
      assert_receive {:delivery, %{text: "new", fiber_id: "fiber-a"}}, 1_000
      refute_receive {:delivery, %{text: "old"}}, 20
      assert %{error: error} = TranscriptRelay.status("old", server: c.name)
      assert is_binary(error) and error != ""

      old_path =
        if unquote(failure) == :startup,
          do: Path.join([c.root, "relays", "old.json"]),
          else: relay_path(c, "old")

      assert [%{"message_id" => "old"}] = Jason.decode!(File.read!(old_path))["outbox"]
    end
  end

  defp assert_isolated_failure(c, fields, bytes \\ "") do
    File.write!(c.path, bytes)
    start_supervised!({TranscriptRelay, c.opts})
    supervisor = Process.whereis(Module.concat(c.name, Supervisor))
    coordinator = Process.whereis(Module.concat(c.name, Coordinator))

    assert :ok =
             TranscriptRelay.start(
               Map.merge(
                 %{launch: "launch", transcript: c.path, started_at: "2026-11-06T10:00:00Z"},
                 fields
               ),
               "fiber-a",
               "owner",
               server: c.name
             )

    pid = worker(c)
    assert %{error: error} = GenServer.call(pid, :status)
    assert is_binary(error) and error != ""

    for _ <- 1..5 do
      send(pid, :poll)
      assert %{error: ^error} = GenServer.call(pid, :status)
    end

    assert Process.whereis(Module.concat(c.name, Supervisor)) == supervisor
    assert Process.whereis(Module.concat(c.name, Coordinator)) == coordinator
    assert Process.alive?(pid)
    healthy = Path.join(c.root, "healthy.txt")
    File.write!(healthy, "Claude healthy relay\n")

    assert :ok =
             TranscriptRelay.start(%{launch: "healthy", transcript: healthy}, "other", "owner",
               server: c.name
             )

    assert_receive {:delivery, %{fiber_id: "other", text: text}}, 1_000
    assert text =~ "healthy relay"
  end

  test "unsummoned cold voice drops on word, quiet, switch and end triggers", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")

    record(
      c.path,
      "2026-11-06T10:00:01Z",
      "one two three four five six seven eight nine ten eleven"
    )

    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> true end)
    assert %{pending: nil, error: nil} = poll(c)
    record(c.path, "2026-11-06T10:00:02Z", "quiet words")
    assert %{pending: %{fiber_id: "fiber-a"}} = poll(c)
    Agent.update(c.now, fn _ -> 90_000 end)
    assert %{pending: nil} = poll(c)
    record(c.path, "2026-11-06T10:00:03Z", "switched away")
    route(routes, "2026-11-06T10:00:10Z", "fiber-b")
    record(c.path, "2026-11-06T10:00:11Z", "another card")
    assert %{pending: %{fiber_id: "fiber-b"}} = poll(c)
    Agent.update(c.observation, fn _ -> {:ok, %{meeting: nil}} end)
    monitor = Process.monitor(worker(c))
    send(worker(c), :poll)
    assert_receive {:DOWN, ^monitor, :process, _, :normal}
    refute_receive {:delivery, _}, 20
  end

  for spoken_name <- ~w(claude cloud clawed klaud clot clod claud) do
    test "cold name #{spoken_name} sends the buffered speech once in warm voice format", c do
      routes = Path.join(c.root, "routes.jsonl")
      route(routes, "2026-11-06T10:00:00Z", "fiber-a")
      File.write!(c.path, "")
      record(c.path, "2026-11-06T10:00:01Z", "first words")
      start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> true end)
      poll(c)
      refute_receive {:delivery, _}, 20
      record(c.path, "2026-11-06T10:00:02Z", "please #{unquote(spoken_name)}")
      poll(c)
      refute_receive {:delivery, _}, 20
      Agent.update(c.now, fn _ -> 5_000 end)
      poll(c)
      assert_receive {:delivery, %{kind: "voice", text: text}}, 1_000
      assert text == "me: first words please #{unquote(spoken_name)}\n"
      sync_tasks(c)
      poll(c)
      refute_receive {:delivery, _}, 20
    end
  end

  test "a name mid-sentence waits for quiet: warm speech batches as usual, cold speech is let through",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    cold = start_supervised!(Supervisor.child_spec({Agent, fn -> false end}, id: :cold))
    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> Agent.get(cold, & &1) end)
    record(c.path, "2026-11-06T10:00:01Z", "the Claude Island part is next")
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.now, fn _ -> 5_000 end)
    poll(c)
    assert_receive {:delivery, %{text: "me: the Claude Island part is next\n"}}, 1_000
    sync_tasks(c)

    Agent.update(cold, fn _ -> true end)
    record(c.path, "2026-11-06T10:00:02Z", "unnamed aside")
    poll(c)
    Agent.update(c.now, fn _ -> 10_000 end)
    poll(c)
    refute_receive {:delivery, _}, 20
    record(c.path, "2026-11-06T10:00:03Z", "ask Claude about the plot")
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.now, fn _ -> 15_000 end)
    poll(c)
    assert_receive {:delivery, %{text: "me: ask Claude about the plot\n"}}, 1_000
  end

  test "the closing phrase summons a cold target at once", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> true end)
    record(c.path, "2026-11-06T10:00:01Z", "open the notebook, send.")
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: "me: open the notebook\n"}}
  end

  test "the closing send leaves the message, and a send inside it stays", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    start_monitor(c, kind: "voice", routes: routes)
    record(c.path, "2026-11-06T10:00:01Z", "send Ana the plot")
    record(c.path, "2026-11-06T10:00:02Z", "Send.")
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: "me: send Ana the plot\n"}}, 1_000
  end

  test "a batch that was only the closing send delivers nothing", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    start_monitor(c, kind: "voice", routes: routes)
    record(c.path, "2026-11-06T10:00:01Z", "Send.")
    poll(c)
    refute_receive {:delivery, _}, 300
    record(c.path, "2026-11-06T10:00:02Z", "then this, send")
    poll(c)
    assert_receive {:delivery, %{fiber_id: "fiber-a", text: "me: then this\n"}}, 1_000
  end

  test "a worker warming by another path resumes ordinary quiet triggers with its buffered speech",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "early words")
    cold = start_supervised!(Supervisor.child_spec({Agent, fn -> true end}, id: :cold))
    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> Agent.get(cold, & &1) end)
    poll(c)
    Agent.update(cold, fn _ -> false end)
    record(c.path, "2026-11-06T10:00:02Z", "warm words")
    poll(c)
    refute_receive {:delivery, _}, 20
    Agent.update(c.now, fn _ -> 5_000 end)
    poll(c)
    assert_receive {:delivery, %{text: "me: early words warm words\n"}}, 1_000
  end

  test "a named buffer still delivers if the target turns cold before quiet", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "Claude wake")
    cold = start_supervised!(Supervisor.child_spec({Agent, fn -> false end}, id: :cold))
    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> Agent.get(cold, & &1) end)
    poll(c)
    Agent.update(cold, fn _ -> true end)
    Agent.update(c.now, fn _ -> 5_000 end)
    poll(c)
    assert_receive {:delivery, %{text: "me: Claude wake\n"}}, 1_000
  end

  test "meeting delivery task exits retain their batch for retry", c do
    File.write!(c.path, "Claude meeting words\n")
    parent = self()
    calls = start_supervised!(Supervisor.child_spec({Agent, fn -> 0 end}, id: :attempts))

    deliver = fn message ->
      send(parent, {:delivery, message})

      case Agent.get_and_update(calls, fn n -> {n, n + 1} end) do
        0 -> exit(:transient_failure)
        _ -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, deliver: deliver)
    assert_receive {:delivery, first}, 1_000
    sync_tasks(c)
    assert [_] = Jason.decode!(File.read!(relay_path(c, "launch")))["outbox"]
    poll(c)
    assert_receive {:delivery, second}, 1_000
    assert second == first
  end

  test "voice speaker comments never strand a buffer before finalized speech", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "# S2 = colleague\n")
    File.write!(Path.rootname(c.path) <> ".jsonl", "")
    start_monitor(c, kind: "voice", routes: routes, cold: fn _ -> true end)
    assert %{error: nil} = poll(c)
    assert %{error: nil} = poll(c)
    record(c.path, "2026-11-06T10:00:01Z", "final words")
    assert %{error: nil, pending: %{fiber_id: "fiber-a", text: "me final words"}} = poll(c)
    refute_receive {:delivery, _}, 20
  end

  test "discard drops voice words not yet sent, and the utterance in progress, but not the outbox",
       c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    record(c.path, "2026-11-06T10:00:01Z", "already sending send")
    record(c.path, "2026-11-06T10:00:02Z", "a private thought")
    parent = self()

    deliver = fn message ->
      send(parent, {:attempt, self(), message})

      receive do
        :accept -> {200, %{delivered: true}}
      end
    end

    start_monitor(c, kind: "voice", routes: routes, deliver: deliver)
    assert_receive {:attempt, first, %{text: "me: already sending\n"}}, 1_000

    assert %{pending: %{text: "me a private thought"}, pending_words: 4} = poll(c)

    assert {:ok, 4} = TranscriptRelay.discard("launch", server: c.name)
    assert %{pending: nil, pending_words: 0} = TranscriptRelay.status("launch", server: c.name)

    assert [%{"text" => "me: already sending\n"}] =
             :sys.get_state(worker(c)).config["outbox"]

    assert File.read!(Path.rootname(c.path) <> ".jsonl") =~ "a private thought"

    # Begun before the discard, finished after: dropped. Begun after: a fresh buffer.
    now = DateTime.utc_now()
    record(c.path, now |> DateTime.add(-1) |> DateTime.to_iso8601(), "the rest of it")
    record(c.path, now |> DateTime.add(1) |> DateTime.to_iso8601(), "something new")
    assert %{pending: %{text: "me something new"}, pending_words: 3} = poll(c)

    send(first, :accept)
    sync_tasks(c)
    assert {:ok, 0} = TranscriptRelay.discard("other", server: c.name)
  end

  test "discard empties a meeting's buffer and later lines start a fresh one", c do
    File.write!(c.path, "10:00:01 me some words\n10:00:02 S2 more words\n")
    start_monitor(c)
    assert %{pending_words: 6} = poll(c)
    assert {:ok, 6} = TranscriptRelay.discard("launch", server: c.name)
    assert %{pending: nil, pending_words: 0} = poll(c)
    File.write!(c.path, "10:00:03 me after\n", [:append])
    assert %{pending: %{text: "10:00:03 me after"}, pending_words: 2} = poll(c)
    Agent.update(c.now, fn _ -> 10_000 end)
    poll(c)
    assert_receive {:delivery, %{text: text}}, 1_000
    assert text == "Meeting transcript update (Weekly sync):\n10:00:03 me after\n"
  end

  test "a batch naming speech held elsewhere is dropped on load, never reported delivered", c do
    routes = Path.join(c.root, "routes.jsonl")
    route(routes, "2026-11-06T10:00:00Z", "fiber-a")
    File.write!(c.path, "")
    batch = %{"fiber_id" => "fiber-a", "origin" => "owner"}

    File.mkdir_p!(Path.join(c.root, "relays"))

    File.write!(
      relay_path(c, "launch"),
      Jason.encode!(%{
        "launch" => "launch",
        "transcript" => c.path,
        "kind" => "voice",
        "routes_path" => routes,
        "started_at" => "2026-11-06T10:00:00Z",
        "offset" => 0,
        "json_offset" => 0,
        "route_offset" => 0,
        "routes" => [],
        "buffers" => [],
        "outbox" => [
          Map.merge(batch, %{
            "text" => "",
            "message_id" => "meeting-held",
            "held" => %{"id" => "h"}
          }),
          Map.merge(batch, %{"text" => "me: kept\n", "message_id" => "meeting-kept"})
        ]
      })
    )

    start_supervised!({TranscriptRelay, c.opts})
    assert_receive {:delivery, %{message_id: "meeting-kept", text: "me: kept\n"}}, 1_000
    refute_receive {:delivery, %{message_id: "meeting-held"}}, 50
  end

  defp relay_path(c, launch) do
    digest = :crypto.hash(:sha256, launch) |> Base.encode16(case: :lower)
    Path.join([c.root, "relays", digest <> ".json"])
  end

  defp start_monitor(c, extra \\ []) do
    opts = Keyword.merge(c.opts, Keyword.take(extra, [:deliver, :cold]))
    start_supervised!({TranscriptRelay, opts})

    row = %{
      launch: "launch",
      transcript: c.path,
      title: "Weekly sync",
      kind: Keyword.get(extra, :kind, "meeting"),
      routes_path: extra[:routes],
      started_at: Keyword.get(extra, :started_at, "2026-11-06T10:00:00Z")
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

  defp sync_target(c, fiber_id) do
    pid = worker(c)
    state = :sys.get_state(pid)

    for {ref, id} <- state.tasks,
        Enum.any?(
          state.config["outbox"],
          &(&1["message_id"] == id and &1["fiber_id"] == fiber_id)
        ) do
      task = state.task_handles[ref]
      monitor = Process.monitor(task.pid)
      assert_receive {:DOWN, ^monitor, :process, _, _}, 1_000
    end

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
