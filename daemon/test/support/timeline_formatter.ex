defmodule Shuttle.Test.TimelineFormatter do
  @moduledoc false
  # Writes one line per module start/finish and test finish, with milliseconds
  # since suite start, to $SHUTTLE_TEST_TIMELINE.
  use GenServer

  def init(_opts) do
    {:ok, file} = File.open(System.fetch_env!("SHUTTLE_TEST_TIMELINE"), [:write, :utf8])
    {:ok, %{file: file, t0: System.monotonic_time(:millisecond)}}
  end

  def handle_cast({:module_started, %{name: name}}, s), do: log(s, "ms #{inspect(name)}")
  def handle_cast({:module_finished, %{name: name}}, s), do: log(s, "mf #{inspect(name)}")

  def handle_cast({:test_finished, t}, s),
    do:
      log(
        s,
        "tf #{inspect(t.module)} #{div(t.time, 1000)} #{inspect(t.state)} #{inspect(t.name)}"
      )

  def handle_cast({:suite_finished, _}, s) do
    File.close(s.file)
    {:noreply, s}
  end

  def handle_cast(_, s), do: {:noreply, s}

  defp log(s, line) do
    IO.write(s.file, "#{System.monotonic_time(:millisecond) - s.t0} #{line}\n")
    {:noreply, s}
  end
end
