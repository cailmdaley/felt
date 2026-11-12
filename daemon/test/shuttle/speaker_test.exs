defmodule Shuttle.SpeakerTest do
  use ExUnit.Case, async: true
  alias Shuttle.Speaker
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    name = Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}")

    world =
      start_supervised!({Agent, fn -> %{partial: nil, now: 0, target: nil, speaker: name} end})

    parent = self()

    opts = [
      name: name,
      poll_ms: 10,
      hold_ms: 1_500,
      clock: fn -> Agent.get(world, & &1.now) end,
      partial: fn -> Agent.get(world, & &1.partial) end,
      target: fn -> Agent.get(world, & &1.target) end,
      render: fn text, voice ->
        send(parent, {:render, text})
        {:ok, "#{voice}:#{text}"}
      end,
      play: fn path ->
        handle = make_ref()
        send(parent, {:play, path, handle})
        handle
      end,
      stop: fn handle -> send(parent, {:stop, handle}) end,
      slice: fn wav, from -> {:ok, "#{wav}@#{from}"} end,
      # As Voice does, a route moves the card in view.
      retarget: fn item ->
        Agent.update(world, &Map.put(&1, :target, [item.fiber_id]))
        send(parent, {:retarget, item.fiber_id, item.name})
      end,
      fibers: fn -> [] end,
      journal: Path.join(root, "outbox.bin")
    ]

    pid = start_supervised!({Speaker, opts})
    %{pid: pid, server: [server: opts[:name]], world: world, opts: opts}
  end

  # Each state lasts a few polls, so the speaker sees every one.
  defp set(world, change) do
    Agent.update(world, &Map.merge(&1, change))
    polls(world)
  end

  defp polls(world) do
    speaker = Agent.get(world, & &1.speaker)
    for _ <- 1..3, do: send(speaker, :poll)
    :sys.get_state(speaker)
  end

  test "plays lines one at a time in arrival order", %{pid: pid, server: server} do
    assert {:ok, %{voice: "jean", ahead: 0}} =
             Speaker.speak(%{"text" => "first", "voice" => "jean"}, server)

    assert {:ok, %{ahead: 1}} = Speaker.speak(%{"text" => "second", "voice" => "jean"}, server)
    assert_receive {:play, "jean:first", one}
    refute_receive {:play, _, _}, 50
    assert %{speaking: %{text: "first"}, queued: 1, paused: false} = Speaker.show(server)

    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:second", two}
    send(pid, {two, {:exit_status, 0}})
    assert %{speaking: nil, queued: 0} = Speaker.show(server)
  end

  test "the next line renders while the current one plays", %{pid: pid, server: server} do
    {:ok, _} = Speaker.speak(%{"text" => "first", "voice" => "jean"}, server)
    assert_receive {:play, "jean:first", one}
    {:ok, _} = Speaker.speak(%{"text" => "second", "voice" => "jean"}, server)
    assert_receive {:render, "second"}
    refute_receive {:play, _, _}, 50

    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:second", _}
  end

  test "a rendered line whose card left view waits with its card",
       %{pid: pid, server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "now", "voice" => "jean"}, server)
    assert_receive {:play, "jean:now", one}

    {:ok, _} =
      Speaker.speak(%{"text" => "later", "voice" => "jean", "fiber_id" => "a/two"}, server)

    assert_receive {:render, "later"}
    set(world, %{target: ["a/one"]})
    send(pid, {one, {:exit_status, 0}})
    refute_receive {:play, _, _}, 50
    assert %{speaking: nil, held: [%{fiber_id: "a/two", n: 1}]} = Speaker.show(server)

    set(world, %{target: ["a/two"]})
    assert_receive {:play, "jean:later", _}
  end

  test "the line being spoken carries its card's name", %{server: server} do
    fibers = fn -> [%{"uid" => "01CARD", "name" => "The card"}] end

    {:ok, _} =
      Speaker.speak(
        %{"text" => "hello", "voice" => "jean", "fiber_id" => "01CARD"},
        server ++ [fibers: fibers]
      )

    assert_receive {:play, "jean:hello", _}
    assert %{speaking: %{fiber_id: "01CARD", name: "The card"}} = Speaker.show(server)
  end

  test "lines held for a card out of view are named", %{server: server, world: world} do
    fibers = [fibers: fn -> [%{"id" => "a/two", "uid" => "U2", "name" => "Two card"}] end]
    set(world, %{target: ["U1"]})

    for text <- ["one", "two"] do
      {:ok, %{held: true}} =
        Speaker.speak(
          %{"fiber_id" => "a/two", "text" => text, "voice" => "jean"},
          Keyword.merge(server, fibers)
        )
    end

    assert %{held: [%{fiber_id: "a/two", name: "Two card", n: 2}]} = Speaker.show(server)
  end

  test "holds while the user talks and resumes just before where it stopped",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "long", "voice" => "jean"}, server)
    assert_receive {:play, "jean:long", handle}

    set(world, %{now: 1_000, partial: "long, lung"})
    refute_receive {:stop, _}, 50
    set(world, %{now: 2_000, partial: "wait, stop"})
    assert_receive {:stop, ^handle}
    assert %{paused: true} = Speaker.show(server)

    set(world, %{now: 9_000, partial: ""})
    assert_receive {:play, "jean:long@1500", _}
  end

  test "an interruption: held while the user's words grow, resumed 1.5 s after they stop",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "a deliberately long line", "voice" => "jean"}, server)
    assert_receive {:play, "jean:a deliberately long line", handle}

    set(world, %{now: 4_000, partial: "okay I'm"})
    assert_receive {:stop, ^handle}
    set(world, %{now: 5_000, partial: "okay I'm interrupting you"})
    set(world, %{now: 6_000, partial: "okay I'm interrupting you let me see"})
    refute_receive {:play, _, _}, 50

    # His words stay pending but stop changing: quiet after 1.5 s.
    set(world, %{now: 7_000})
    refute_receive {:play, _, _}, 50
    set(world, %{now: 7_600})
    assert_receive {:play, "jean:a deliberately long line@3500", _}
    assert %{paused: false} = Speaker.show(server)
  end

  test "a hold outlasts hark closing the human's line, until the hold runs out",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "a deliberately long line", "voice" => "jean"}, server)
    assert_receive {:play, "jean:a deliberately long line", handle}

    set(world, %{now: 4_000, partial: "wait wait"})
    assert_receive {:stop, ^handle}

    # hark closes the run and clears its pending words.
    set(world, %{now: 4_500, partial: ""})
    refute_receive {:play, _, _}, 50
    set(world, %{now: 5_400})
    refute_receive {:play, _, _}, 50
    set(world, %{now: 5_600})
    assert_receive {:play, "jean:a deliberately long line@3500", _}
  end

  test "a restart resumes the held line and keeps the queue",
       %{server: server, world: world, opts: opts} do
    wav = Path.join(Path.dirname(opts[:journal]), "line.wav")
    File.write!(wav, "")
    opts = Keyword.put(opts, :render, fn _text, _voice -> {:ok, wav} end)
    stop_supervised!(Speaker)
    start_supervised!({Speaker, opts})

    {:ok, _} = Speaker.speak(%{"text" => "held", "voice" => "jean"}, server)
    {:ok, _} = Speaker.speak(%{"text" => "next", "voice" => "jean"}, server)
    assert_receive {:play, ^wav, _}
    set(world, %{now: 2_000, partial: "hold on please"})
    assert_receive {:stop, _}

    stop_supervised!(Speaker)
    start_supervised!({Speaker, opts})
    assert %{speaking: %{text: "held"}, queued: 1, paused: true} = Speaker.show(server)

    set(world, %{now: 10_000})
    assert_receive {:play, play, _}
    assert play == wav <> "@1500"
  end

  test "mute holds the line and the queue without dropping them",
       %{pid: pid, server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "a", "voice" => "jean"}, server)
    assert_receive {:play, "jean:a", handle}
    set(world, %{now: 300})
    assert {:ok, %{muted: true, paused: true}} = Speaker.mute(true, server)
    assert_receive {:stop, ^handle}
    {:ok, _} = Speaker.speak(%{"text" => "b", "voice" => "jean"}, server)
    refute_receive {:play, _, _}, 50

    {:ok, _} = Speaker.mute(false, server)
    assert_receive {:play, "jean:a", again}
    send(pid, {again, {:exit_status, 0}})
    assert_receive {:play, "jean:b", _}
  end

  test "only the constitution in view speaks; the others wait their turn",
       %{pid: pid, server: server, world: world} do
    fibers = [fibers: fn -> [%{"id" => "a/one", "uid" => "U1"}] end]

    say = fn fiber, text ->
      Speaker.speak(
        %{"fiber_id" => fiber, "text" => text, "voice" => "jean"},
        Keyword.merge(server, fibers)
      )
    end

    set(world, %{target: ["U1"]})
    assert {:ok, %{held: true}} = say.("a/two", "two first")
    {:ok, _} = say.("a/one", "one first")
    {:ok, _} = say.("a/two", "two second")
    assert_receive {:play, "jean:one first", one}

    assert %{queued: 0, held: [%{fiber_id: "a/two", n: 2, first: "two first"}]} =
             Speaker.show(server)

    set(world, %{target: ["a/two"]})
    refute_receive {:play, _, _}, 50
    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:two first", two}
    send(pid, {two, {:exit_status, 0}})
    assert_receive {:play, "jean:two second", three}

    {:ok, _} = say.("a/one", "one again")
    set(world, %{target: nil})
    send(pid, {three, {:exit_status, 0}})
    assert_receive {:play, "jean:one again", _}
    assert %{held: []} = Speaker.show(server)
  end

  test "a fiber answers to all its ids, or the one given while the feed is unavailable" do
    fibers = [fibers: fn -> [%{"id" => "U1", "uid" => "U1", "slug" => "a/one"}] end]
    assert Speaker.fiber_keys("a/one", fibers) == ["a/one", "U1"]
    assert Speaker.fiber_keys("U1", fibers) == ["U1", "a/one"]
    assert Speaker.fiber_keys("U1", fibers: fn -> [] end) == ["U1"]
  end

  test "a spoken skip drops the rest of the line, for good",
       %{server: server, world: world, opts: opts} do
    set(world, %{partial: "earlier words"})
    {:ok, _} = Speaker.speak(%{"text" => "first line", "voice" => "jean"}, server)
    {:ok, _} = Speaker.speak(%{"text" => "second line", "voice" => "jean"}, server)
    # The leftover pending words hold the line until they are quiet.
    set(world, %{now: 2_000})
    assert_receive {:play, "jean:first line", one}

    set(world, %{now: 3_000, partial: "earlier words skip this one please"})
    assert_receive {:stop, ^one}
    refute_receive {:play, _, _}, 50

    set(world, %{now: 3_500, partial: "earlier words Skip that."})
    refute_receive {:play, _, _}, 50
    # The next line starts once the skip itself is quiet.
    set(world, %{now: 5_100})
    assert_receive {:play, "jean:second line", _}
    assert %{speaking: %{text: "second line"}, queued: 0} = Speaker.show(server)

    stop_supervised!(Speaker)
    start_supervised!({Speaker, opts})
    assert %{speaking: %{text: "second line"}, queued: 0} = Speaker.show(server)
  end

  test "a skip ending an interruption drops the line once the human is quiet",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "first line", "voice" => "jean"}, server)
    {:ok, _} = Speaker.speak(%{"text" => "second line", "voice" => "jean"}, server)
    assert_receive {:play, "jean:first line", one}

    set(world, %{now: 1_000, partial: "I'd skip"})
    assert_receive {:stop, ^one}
    set(world, %{now: 1_400, partial: "I've heard enough of this, skip"})
    set(world, %{now: 2_500})
    refute_receive {:play, _, _}, 50

    # Quiet with a trailing skip: the line is dropped, not resumed.
    set(world, %{now: 3_000})
    assert_receive {:play, "jean:second line", _}
  end

  test "a skip mid-sentence resumes the line when the sentence goes on",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "first line", "voice" => "jean"}, server)
    assert_receive {:play, "jean:first line", one}
    set(world, %{now: 1_000, partial: "I'd skip"})
    assert_receive {:stop, ^one}
    set(world, %{now: 1_300, partial: "I'd skip the intro next time"})
    set(world, %{now: 3_000})
    assert_receive {:play, "jean:first line@500", _}
  end

  test "skip is the new words alone, or their end" do
    assert Speaker.skip("skip", nil) == :said
    assert Speaker.skip("Skip it!", "") == :said
    assert Speaker.skip("so then skip", "so then") == :said
    assert Speaker.skip("that's enough of that, skip.", nil) == :trailing
    assert Speaker.skip("we covered this. Skip that", nil) == :trailing
    assert Speaker.skip("skip ahead, skip it", nil) == :trailing
    assert Speaker.skip("so then", "so then") == nil
    assert Speaker.skip("don't skip", nil) == nil
    assert Speaker.skip("please do not skip that", nil) == nil
    assert Speaker.skip("skip ahead to the end", nil) == nil
    assert Speaker.skip("I'd skip the intro", nil) == nil
    assert Speaker.skip(nil, nil) == nil
  end

  defp hold_for_cards(server, world) do
    fibers = [
      fibers: fn ->
        [%{"id" => "a/one", "name" => "One card"}, %{"id" => "a/two", "name" => "Two card"}]
      end
    ]

    set(world, %{target: ["elsewhere"]})

    for {fiber, text} <- [{"a/two", "two first"}, {"a/one", "one first"}, {"a/two", "two second"}] do
      {:ok, %{held: true}} =
        Speaker.speak(
          %{"fiber_id" => fiber, "text" => text, "voice" => "jean"},
          Keyword.merge(server, fibers)
        )
    end
  end

  test "play opens the oldest card: its lines, named once, then it waits on that card",
       %{pid: pid, server: server, world: world} do
    hold_for_cards(server, world)
    refute_receive {:play, _, _}, 50

    assert %{
             inbox: %{playing: false, card: nil},
             held: [
               %{fiber_id: "a/two", name: "Two card", n: 2, first: "two first"},
               %{fiber_id: "a/one", name: "One card", n: 1, first: "one first"}
             ]
           } = Speaker.show(server)

    set(world, %{partial: "Play."})
    assert_receive {:retarget, "a/two", "Two card"}
    assert_receive {:play, "jean:Two card: two first", one}
    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:two second", two}
    send(pid, {two, {:exit_status, 0}})
    refute_receive {:play, _, _}, 50

    assert %{
             inbox: %{playing: true, card: %{fiber_id: "a/two", name: "Two card"}},
             held: [%{fiber_id: "a/one", n: 1}],
             speaking: nil
           } = Speaker.show(server)

    # The card's worker answers: in view, it plays at once.
    {:ok, %{held: false}} =
      Speaker.speak(%{"fiber_id" => "a/two", "text" => "reply", "voice" => "jean"}, server)

    assert_receive {:play, "jean:reply", _}
  end

  test "next moves to the next card, and an emptied inbox closes",
       %{pid: pid, server: server, world: world} do
    hold_for_cards(server, world)
    {:ok, %{inbox: %{playing: true}}} = Speaker.inbox(:play, server)
    assert_receive {:play, "jean:Two card: two first", one}
    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:two second", two}
    send(pid, {two, {:exit_status, 0}})

    set(world, %{partial: "next"})
    assert_receive {:retarget, "a/one", "One card"}
    assert_receive {:play, "jean:One card: one first", _}
    assert %{inbox: %{playing: false}, held: []} = Speaker.show(server)
  end

  test "stop closes the inbox and leaves the other cards held",
       %{server: server, world: world} do
    hold_for_cards(server, world)
    set(world, %{partial: "what's waiting"})
    assert_receive {:retarget, "a/two", _}
    set(world, %{now: 2_000})
    assert_receive {:play, "jean:Two card: two first", _}

    set(world, %{partial: "stop"})
    refute_receive {:retarget, _, _}, 50

    assert %{inbox: %{playing: false, card: nil}, held: [%{fiber_id: "a/one", n: 1}]} =
             Speaker.show(server)
  end

  test "a restart mid-inbox carries on with the inbox",
       %{server: server, world: world, opts: opts} do
    hold_for_cards(server, world)
    set(world, %{partial: "play them"})
    set(world, %{now: 2_000})
    assert_receive {:play, "jean:Two card: two first", _}

    stop_supervised!(Speaker)
    start_supervised!({Speaker, opts})
    assert %{inbox: %{playing: true, card: %{fiber_id: "a/two"}}} = Speaker.show(server)
  end

  test "a card the feed cannot name yet is announced by its id's last part",
       %{server: server, world: world} do
    set(world, %{target: ["elsewhere"]})

    Speaker.speak(
      %{"fiber_id" => "loom/tools/holistic-hark", "text" => "hi", "voice" => "jean"},
      server
    )

    {:ok, _} = Speaker.inbox(:play, server)
    assert_receive {:retarget, "loom/tools/holistic-hark", "holistic hark"}
    assert_receive {:play, "jean:holistic hark: hi", _}
  end

  test "inbox words are the new words alone" do
    assert Speaker.inbox_word("Play!", nil) == :play
    assert Speaker.inbox_word("play them", "") == :play
    assert Speaker.inbox_word("So, what's waiting?", "So,") == :play
    assert Speaker.inbox_word("Next.", nil) == :next
    assert Speaker.inbox_word("next one", "") == :next
    assert Speaker.inbox_word("ok stop", "ok") == :stop
    assert Speaker.inbox_word("stop it.", nil) == :stop
    assert Speaker.inbox_word("let's play a game", nil) == nil
    assert Speaker.inbox_word("don't stop", nil) == nil
    assert Speaker.inbox_word(nil, nil) == nil
  end

  test "words pending before the line began don't hold it while its echo grows",
       %{server: server, world: world} do
    set(world, %{partial: "okay then um let's do the"})

    {:ok, _} =
      Speaker.speak(%{"text" => "Holistic hark: the inbox is live", "voice" => "jean"}, server)

    # The leftover words are seen pending as the line begins, then go quiet.
    polls(world)
    set(world, %{now: 2_000})
    assert_receive {:play, "jean:Holistic hark: the inbox is live", _}

    set(world, %{now: 3_000, partial: "okay then um let's do the listic hark"})
    set(world, %{now: 3_500, partial: "okay then um let's do the listic hark the inbox is live"})
    refute_receive {:stop, _}, 50
  end

  test "words of the line being spoken are its echo, not the user" do
    line = "Hello Ada, the outbox is live."
    refute Speaker.talking?(nil, line)
    refute Speaker.talking?("", line)
    refute Speaker.talking?("Hello, Aida. The outbox is live.", line)
    refute Speaker.talking?("stop", line)
    assert Speaker.talking?("hold on a second", line)
    assert Speaker.talking?("the outbox, wait, stop", line)
  end

  test "lists the bank and built-ins with the roles that hold them", %{tmp_dir: root} do
    for {role, front} <- [{"tutor", "voice: borges\n"}, {"scout", "voice: jean\n"}, {"bare", ""}] do
      charter = Path.join([root, ".felt", "roles", role, role <> ".md"])
      File.mkdir_p!(Path.dirname(charter))
      File.write!(charter, "---\nname: #{role}\n#{front}---\n")
    end

    File.write!(Path.join([root, ".felt", "roles", "roles.md"]), "---\nname: Roles\n---\n")
    bank = Path.join(root, "voices")
    File.mkdir_p!(bank)

    for f <- ~w(borges.safetensors borges.wav cohen.safetensors),
        do: File.write!(Path.join(bank, f), "")

    voices = Speaker.voices(bank: bank, stores: fn -> [root] end)

    assert [
             %{name: "borges", kind: "bank", role: "tutor"},
             %{name: "cohen", kind: "bank", role: nil},
             %{name: "alba", kind: "builtin", role: nil} | _
           ] = voices

    assert %{role: "scout"} = Enum.find(voices, &(&1.name == "jean"))
  end

  test "resolves the voice from the fiber's role charter", %{tmp_dir: root, server: server} do
    charter = Path.join([root, ".felt", "roles", "tutor", "tutor.md"])
    File.mkdir_p!(Path.dirname(charter))
    File.write!(charter, "---\nname: Tutor\nvoice: borges\n---\nbody\n")

    fibers = fn ->
      [
        %{"id" => "a/tutored", "uid" => "U1", "shuttle" => %{"role" => "tutor"}},
        %{"id" => "a/plain"},
        %{"id" => "a/unvoiced", "shuttle" => %{"role" => "missing"}}
      ]
    end

    opts = [fibers: fibers, stores: fn -> [root] end] ++ server

    voice = fn fiber_id ->
      {:ok, %{voice: voice}} = Speaker.speak(%{"text" => "hi", "fiber_id" => fiber_id}, opts)
      voice
    end

    assert voice.("a/tutored") == "borges"
    assert voice.("U1") == "borges"
    assert voice.("a/plain") == "dylan_thomas"
    assert voice.("a/unvoiced") == "dylan_thomas"
    assert voice.(nil) == "dylan_thomas"
  end

  test "finds a charter in a mount, the store's own winning a collision", %{
    tmp_dir: root,
    server: server
  } do
    store = Path.join(root, "store")
    shared = Path.join(root, "shared")

    for {dir, role, voice} <- [
          {shared, "analyst", "cosette"},
          {shared, "tutor", "marius"},
          {Path.join(store, ".felt"), "tutor", "jean"},
          {Path.join(shared, "deep"), "buried", "javert"}
        ] do
      charter = Path.join([dir, "roles", role, role <> ".md"])
      File.mkdir_p!(Path.dirname(charter))
      File.write!(charter, "---\nname: #{role}\nvoice: #{voice}\n---\n")
    end

    File.ln_s!(shared, Path.join([store, ".felt", "shared"]))

    fibers = fn ->
      for role <- ~w(analyst tutor buried), do: %{"id" => role, "shuttle" => %{"role" => role}}
    end

    opts = [fibers: fibers, stores: fn -> [store] end] ++ server

    voice = fn fiber_id ->
      {:ok, %{voice: voice}} = Speaker.speak(%{"text" => "hi", "fiber_id" => fiber_id}, opts)
      voice
    end

    assert voice.("analyst") == "cosette"
    assert voice.("tutor") == "jean"
    assert voice.("buried") == "dylan_thomas"

    voices = Speaker.voices(bank: Path.join(root, "none"), stores: fn -> [store] end)
    assert %{role: "analyst"} = Enum.find(voices, &(&1.name == "cosette"))
    assert %{role: "tutor"} = Enum.find(voices, &(&1.name == "jean"))
    assert %{role: nil} = Enum.find(voices, &(&1.name == "marius"))
  end

  describe "echo?/3" do
    @line %{text: "Open Arena and start a draft whenever you like.", from: 10_000, to: 14_000}

    test "the line heard back while it plays, cut off or misheard, is its echo" do
      assert Speaker.echo?("Open arena and start a draft whenever you", {10_200, 13_900}, [@line])
      assert Speaker.echo?("Open arena and start a dra", {10_200, 12_000}, [@line])
      assert Speaker.echo?("Oh pen arena and start a draft", {10_200, 12_000}, [@line])
    end

    test "the human talking over it is not" do
      refute Speaker.echo?("No wait, hold on a second", {11_000, 12_000}, [@line])
      refute Speaker.echo?("Start the next draft tomorrow please", {11_000, 12_000}, [@line])
    end

    test "the line's words long after it played are the human's" do
      refute Speaker.echo?("start a draft", {30_000, 31_000}, [@line])
      assert Speaker.echo?("start a draft", {15_500, 16_000}, [@line])
      assert Speaker.echo?("start a draft", {30_000, 31_000}, [%{@line | to: nil}])
      refute Speaker.echo?("start a draft", {11_000, 12_000}, [])
    end
  end

  test "the played log spans each stretch a line was heard", %{
    pid: pid,
    server: server,
    world: world
  } do
    {:ok, _} = Speaker.speak(%{"text" => "a line to hear", "voice" => "jean"}, server)
    assert_receive {:play, _, one}
    assert [%{text: "a line to hear", to: nil}] = Speaker.played(server)

    set(world, %{partial: "wait wait"})
    assert_receive {:stop, ^one}
    assert [%{to: to}] = Speaker.played(server)
    assert is_integer(to)

    set(world, %{partial: nil, now: 10_000})
    assert_receive {:play, _, two}
    assert [%{to: ^to}, %{text: "a line to hear", to: nil}] = Speaker.played(server)
    send(pid, {two, {:exit_status, 0}})
    assert [_, %{to: stop}] = Speaker.played(server)
    assert is_integer(stop)
  end
end
