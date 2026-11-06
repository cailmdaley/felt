defmodule Shuttle.SpeakerTest do
  use ExUnit.Case, async: true
  alias Shuttle.Speaker
  @moduletag :tmp_dir

  setup do
    {:ok, world} = Agent.start_link(fn -> %{partial: nil, now: 0} end)
    parent = self()

    opts = [
      name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
      poll_ms: 10,
      clock: fn -> Agent.get(world, & &1.now) end,
      partial: fn -> Agent.get(world, & &1.partial) end,
      render: fn text, voice -> {:ok, "#{voice}:#{text}"} end,
      play: fn path ->
        handle = make_ref()
        send(parent, {:play, path, handle})
        handle
      end,
      stop: fn handle -> send(parent, {:stop, handle}) end,
      slice: fn wav, from -> {:ok, "#{wav}@#{from}"} end
    ]

    pid = start_supervised!({Speaker, opts})
    %{pid: pid, server: [server: opts[:name]], world: world}
  end

  defp set(world, change), do: Agent.update(world, &Map.merge(&1, change))

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

  test "words of the line being spoken are its echo, not Cail" do
    line = "Hello Cail, the outbox is live."
    refute Speaker.talking?(nil, line)
    refute Speaker.talking?("", line)
    refute Speaker.talking?("Hello, Kale. The outbox is live.", line)
    refute Speaker.talking?("stop", line)
    assert Speaker.talking?("hold on a second", line)
    assert Speaker.talking?("the outbox, wait, stop", line)
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
