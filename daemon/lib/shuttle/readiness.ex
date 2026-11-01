defmodule Shuttle.Readiness do
  @moduledoc """
  Lock-free boot readiness for the HTTP edge.

  The endpoint reads a persistent snapshot rather than calling a child that may
  still be initializing. The application tree and Poller's observable boot stages
  publish independently; dispatch is ready only after both complete.
  """

  @key {__MODULE__, :boot_state}

  # A test that stages a boot owns its own snapshot (`Shuttle.Env.scope_key/1`);
  # everything else reads the application's. Both are `@key` in production.
  defp key, do: Shuttle.Env.scope_key(@key)
  defp state(default), do: :persistent_term.get(key(), nil) || :persistent_term.get(@key, default)

  @doc false
  def begin_boot do
    poller_boot(nil)

    :persistent_term.put(key(), %{
      ready: false,
      started_at: System.monotonic_time(:millisecond),
      duration_ms: nil
    })

    :ok
  end

  @doc false
  def mark_ready do
    state = state(default_state())
    duration_ms = max(0, System.monotonic_time(:millisecond) - state.started_at)

    :persistent_term.put(key(), %{
      ready: true,
      started_at: state.started_at,
      duration_ms: duration_ms
    })

    duration_ms
  end

  @doc false
  def poller_boot(hold),
    do: :persistent_term.put(Shuttle.Env.scope_key({__MODULE__, :poller_boot}), hold)

  @doc "Returns a cheap readiness snapshot without calling a child."
  def status do
    base = application_status()
    hold = :persistent_term.get(Shuttle.Env.scope_key({__MODULE__, :poller_boot}), nil)

    if hold do
      now = System.monotonic_time(:millisecond)
      {started, progress} = Map.pop(hold, :started_ms, now)
      {retry_at, progress} = Map.pop(progress, :retry_at_ms)
      progress = Map.put(progress, :elapsed_ms, max(0, now - started))

      progress =
        if retry_at, do: Map.put(progress, :retry_in_ms, max(0, retry_at - now)), else: progress

      permanent = hold.reason not in ["booting", "retrying"]

      %{base | ready: false, pending: base.pending ++ ["poller: " <> hold.stage]}
      |> Map.put(:boot, progress)
      |> Map.put(:boot_hold, if(permanent, do: progress))
    else
      base |> Map.put(:boot_hold, nil) |> Map.put(:boot, nil)
    end
  end

  defp application_status do
    case state(nil) do
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

  defp default_state do
    %{ready: false, started_at: System.monotonic_time(:millisecond), duration_ms: nil}
  end
end
