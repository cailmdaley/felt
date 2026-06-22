defmodule Shuttle.LoomSync do
  @moduledoc """
  Periodic, publish-only git sync of the home loom (`~/loom`).

  `loom-sync.sh` historically fired ONLY on Claude Code Stop/SessionEnd hooks, so
  an *idle* host's loom froze: it stopped pulling canonical updates. A real case —
  cineca drifted ~6h / 20 commits behind, surfacing stale cross-host fiber state.

  This per-host timer makes the always-on daemon the steward of its own loom's
  freshness. Every interval it runs `loom-sync.sh` in **publish-only** mode (pull
  `--rebase --autostash` + push, NO auto-commit) — the daemon never authors
  commits, matching the hook's publish mode and preserving the "only sessions
  commit" principle. The SessionEnd `--commit` hook still handles residue.

  Decentralized by design: each host keeps its own loom current regardless of the
  Mac or any tunnel (cron is unavailable on the HPC remotes, and the daemon is the
  natural always-on per-host process, so the timer lives here).

  The sync runs in a detached Task so a slow/hung git op never stalls the cadence;
  `loom-sync.sh` is flock-guarded, so an overlapping tick is a safe no-op. Disabled
  (init → `:ignore`) when the interval is 0 or the script is absent. Tunables:

    * `SHUTTLE_LOOM_SYNC_INTERVAL_MS` — interval (default #{600_000}; 0 disables)
    * `SHUTTLE_LOOM_SYNC_SCRIPT`      — script path (default `~/loom/hooks/loom-sync.sh`)
  """

  use GenServer
  require Logger

  @default_interval_ms 600_000
  @initial_delay_ms 15_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, configured_interval_ms())
    script = Keyword.get(opts, :script, default_script())
    initial = Keyword.get(opts, :initial_delay_ms, @initial_delay_ms)

    cond do
      interval <= 0 ->
        Logger.info("LoomSync: disabled (interval_ms=#{interval})")
        :ignore

      not script_runnable?(script) ->
        Logger.info("LoomSync: disabled (no loom-sync script at #{inspect(script)})")
        :ignore

      true ->
        Logger.info("LoomSync: every #{interval}ms via #{script}")
        Process.send_after(self(), :sync, initial)
        {:ok, %{interval_ms: interval, script: script}}
    end
  end

  @impl true
  def handle_info(:sync, state) do
    # Schedule the next tick *first* so a slow/hung git op never stalls the
    # cadence. loom-sync.sh is flock-guarded, so an overlapping tick no-ops.
    Process.send_after(self(), :sync, state.interval_ms)
    run_sync(state.script)
    {:noreply, state}
  end

  defp run_sync(script) do
    Task.start(fn ->
      case System.cmd("bash", [script], stderr_to_stdout: true) do
        {_out, 0} -> :ok
        {out, code} -> Logger.warning("LoomSync: loom-sync.sh exited #{code}: #{String.trim(out)}")
      end
    end)
  end

  defp configured_interval_ms do
    case System.get_env("SHUTTLE_LOOM_SYNC_INTERVAL_MS") do
      raw when is_binary(raw) and raw != "" ->
        case Integer.parse(raw) do
          {n, _} when n >= 0 -> n
          _ -> @default_interval_ms
        end

      _ ->
        @default_interval_ms
    end
  end

  defp default_script do
    System.get_env("SHUTTLE_LOOM_SYNC_SCRIPT") ||
      Path.join([System.user_home() || ".", "loom", "hooks", "loom-sync.sh"])
  end

  defp script_runnable?(script), do: is_binary(script) and File.exists?(script)
end
