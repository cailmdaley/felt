defmodule Shuttle.VoiceLoadTest do
  @moduledoc """
  On a loaded machine the transcript relay answers a status request slowly, so
  every read of the live drafts waits up to the relay's timeout. Many readers
  poll Listen at once (each Claude session's voice band every 150-500 ms, each
  board every 2 s, Rex focus every second), so a slow relay must slow those
  reads, not queue them behind one another until they time out.
  """
  use ExUnit.Case, async: true
  alias Shuttle.Test.Env
  alias Shuttle.Voice
  @moduletag :tmp_dir

  # A relay busy past the reader's patience: what a status call to a relay worker
  # costs while the machine is loaded.
  @relay_ms 250

  setup %{tmp_dir: root} do
    Env.put_env("SHUTTLE_VOICE_FILE", Path.join(root, "voice.json"))
    Env.put_env("SHUTTLE_DATA_DIR", root)
    Env.put_app_env(:hark_dir, Path.join(root, "hark"))
    Env.put_app_env(:remotes, [])

    capture = %{
      kind: "voice",
      launch: "live",
      state: "live",
      fiber: "project/sync",
      paused: false
    }

    opts = [
      name: Module.concat(__MODULE__, "S#{System.unique_integer([:positive])}"),
      poll_ms: 60_000,
      reconcile: fn _enabled, _opts -> {:ok, %{available: true, capture: capture}} end,
      relay: fn _, _ -> :ok end,
      monitor: fn "live" ->
        Process.sleep(@relay_ms)
        %{pending: nil, last: nil, pending_words: 3, sends_in_ms: 900}
      end
    ]

    Env.start_scoped!({Voice, opts})
    {:ok, %{enabled: true}} = Voice.update(%{"enabled" => true})
    :ok
  end

  test "forty readers at once each wait for the relay once, not for one another" do
    readers =
      for n <- 1..40 do
        Task.async(fn ->
          read = if rem(n, 4) == 0, do: &Voice.snapshot/0, else: &Voice.show/0
          :timer.tc(fn -> exit_or(read) end, :millisecond)
        end)
      end

    results = Task.await_many(readers, 15_000)

    for {elapsed, result} <- results do
      assert %{enabled: true, state: "listening"} = result
      assert elapsed < 4 * @relay_ms, "a read took #{elapsed} ms"
    end
  end

  test "a write is not held behind readers waiting on the relay" do
    for _ <- 1..20, do: Task.async(fn -> exit_or(&Voice.show/0) end)
    Process.sleep(20)

    {elapsed, result} = :timer.tc(fn -> Voice.update(%{"words" => 150}) end, :millisecond)
    assert {:ok, %{words: 150}} = result
    assert elapsed < 10 * @relay_ms, "the write took #{elapsed} ms"
  end

  defp exit_or(fun) do
    fun.()
  catch
    :exit, reason -> {:exit, reason}
  end
end
