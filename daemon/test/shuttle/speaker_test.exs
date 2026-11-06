defmodule Shuttle.SpeakerTest do
  use ExUnit.Case, async: true
  alias Shuttle.Speaker
  @moduletag :tmp_dir

  setup %{tmp_dir: root} do
    world = start_supervised!({Agent, fn -> %{partial: nil, now: 0, target: nil} end})
    parent = self()

    opts = [
      name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
      poll_ms: 10,
      clock: fn -> Agent.get(world, & &1.now) end,
      partial: fn -> Agent.get(world, & &1.partial) end,
      target: fn -> Agent.get(world, & &1.target) end,
      render: fn text, voice -> {:ok, "#{voice}:#{text}"} end,
      play: fn path ->
        handle = make_ref()
        send(parent, {:play, path, handle})
        handle
      end,
      stop: fn handle -> send(parent, {:stop, handle}) end,
      slice: fn wav, from -> {:ok, "#{wav}@#{from}"} end,
      journal: Path.join(root, "outbox.bin")
    ]

    pid = start_supervised!({Speaker, opts})
    %{pid: pid, server: [server: opts[:name]], world: world, opts: opts}
  end

  # Each state lasts a few polls, so the speaker sees every one.
  defp set(world, change) do
    Agent.update(world, &Map.merge(&1, change))
    Process.sleep(30)
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
    Process.sleep(20)
    assert %{speaking: nil, queued: 0} = Speaker.show(server)
  end

  test "holds while Cail talks and resumes just before where it stopped",
       %{server: server, world: world} do
    {:ok, _} = Speaker.speak(%{"text" => "long", "voice" => "jean"}, server)
    assert_receive {:play, "jean:long", handle}

    set(world, %{now: 1_000, partial: "long, Kale"})
    refute_receive {:stop, _}, 50
    set(world, %{now: 2_000, partial: "wait, stop"})
    assert_receive {:stop, ^handle}
    assert %{paused: true} = Speaker.show(server)

    set(world, %{now: 9_000, partial: ""})
    assert_receive {:play, "jean:long@1500", _}
  end

  test "Cail's interruption: held while his words grow, resumed 1.5 s after they stop",
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

    set(world, %{target: "U1"})
    assert {:ok, %{held: true}} = say.("a/two", "two first")
    {:ok, _} = say.("a/one", "one first")
    {:ok, _} = say.("a/two", "two second")
    assert_receive {:play, "jean:one first", one}
    assert %{queued: 0, held: %{"a/two" => 2}} = Speaker.show(server)

    set(world, %{target: "a/two"})
    refute_receive {:play, _, _}, 50
    send(pid, {one, {:exit_status, 0}})
    assert_receive {:play, "jean:two first", two}
    send(pid, {two, {:exit_status, 0}})
    assert_receive {:play, "jean:two second", three}

    {:ok, _} = say.("a/one", "one again")
    set(world, %{target: nil})
    send(pid, {three, {:exit_status, 0}})
    assert_receive {:play, "jean:one again", _}
    assert %{held: %{}} = Speaker.show(server)
  end

  test "words of the line being spoken are its echo, not Cail" do
    line = "Hello Cail, the outbox is live."
    refute Speaker.talking?(nil, line)
    refute Speaker.talking?("", line)
    refute Speaker.talking?("Hello, Kale. The outbox is live.", line)
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

  test "resolves the voice from the fiber's role charter", %{tmp_dir: root} do
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

    opts = [fibers: fibers, stores: fn -> [root] end]
    assert Speaker.voice_for("a/tutored", opts) == "borges"
    assert Speaker.voice_for("U1", opts) == "borges"
    assert Speaker.voice_for("a/plain", opts) == "dylan_thomas"
    assert Speaker.voice_for("a/unvoiced", opts) == "dylan_thomas"
    assert Speaker.voice_for(nil, opts) == "dylan_thomas"
  end
end
