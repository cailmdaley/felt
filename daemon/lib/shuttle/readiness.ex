defmodule Shuttle.Readiness do
  @moduledoc """
  Lock-free boot readiness for the HTTP edge.

  The endpoint reads a persistent snapshot rather than calling a child that may
  still be initializing. Readiness changes exactly once: after the application's
  supervisor has started every child successfully.
  """

  @key {__MODULE__, :boot_state}

  @doc false
  def begin_boot do
    :persistent_term.put(@key, %{
      ready: false,
      started_at: System.monotonic_time(:millisecond),
      duration_ms: nil
    })

    :ok
  end

  @doc false
  def mark_ready do
    state = :persistent_term.get(@key, default_state())
    duration_ms = max(0, System.monotonic_time(:millisecond) - state.started_at)

    :persistent_term.put(@key, %{
      ready: true,
      started_at: state.started_at,
      duration_ms: duration_ms
    })

    duration_ms
  end

  @doc "Returns a cheap readiness snapshot without calling a child."
  def status do
    case :persistent_term.get(@key, nil) do
      %{ready: true, duration_ms: duration_ms} ->
        %{ready: true, duration_ms: duration_ms, pending: []}

      %{started_at: started_at} ->
        %{
          ready: false,
          duration_ms: max(0, System.monotonic_time(:millisecond) - started_at),
          pending: ["application"]
        }

      _ ->
        %{ready: false, duration_ms: 0, pending: ["application"]}
    end
  end

  def ready?, do: status().ready

  defp default_state do
    %{ready: false, started_at: System.monotonic_time(:millisecond), duration_ms: nil}
  end
end
