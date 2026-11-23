defmodule Shuttle.StoreSync do
  @moduledoc """
  Periodic read-only fast-forward sync for clean felt store repositories.

  When enabled (`Shuttle.Host.auto_ff_stores?/0`), shells
  `felt -C <store> sync --ff-only --json` for each configured felt store.
  `felt sync --ff-only` owns Git locking (`felt-sync.lock`), mount discovery
  (e.g. `~/loom` and mounted `~/pando`), bounded network fetch timeouts, and
  uninterruptible local `git merge --ff-only` execution.

  The daemon runs `felt` with `timeout_ms: :infinity` and never SIGKILLs it
  mid-pass, so a local fast-forward merge is never interrupted while holding
  Git's `index.lock`. Results are cached in this GenServer and exposed via
  `/api/v1/version` and `shuttle doctor`.
  """

  use GenServer
  require Logger

  @boot_delay_ms 10_000
  @default_interval_ms 300_000
  @default_fetch_timeout "30s"

  # ── Public API ──

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "The latest store-sync status report for `/api/v1/version`."
  @spec status(GenServer.server()) :: map()
  def status(server \\ Shuttle.Env.server(__MODULE__)) do
    GenServer.call(server, :status, 500)
  catch
    :exit, _ ->
      %{
        enabled: false,
        state: :unavailable,
        last_run_at: nil,
        duration_ms: nil,
        repos: []
      }
  end

  @doc """
  Run one sync pass immediately (or await an in-flight pass) and return the
  resulting status report.
  """
  @spec sync_now(GenServer.server(), timeout()) :: map()
  def sync_now(server \\ Shuttle.Env.server(__MODULE__), timeout \\ :infinity) do
    GenServer.call(server, :sync_now, timeout)
  end

  # ── GenServer callbacks ──

  @impl true
  def init(opts) do
    state = %{
      opts: opts,
      task: nil,
      timer: nil,
      started: nil,
      waiters: [],
      status: %{
        enabled: nil,
        state: :scheduled,
        last_run_at: nil,
        duration_ms: nil,
        repos: []
      }
    }

    boot_delay = Keyword.get(opts, :boot_delay_ms, @boot_delay_ms)
    {:ok, schedule(state, boot_delay)}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply, state.status, state}
  end

  def handle_call(:sync_now, from, %{task: nil} = state) do
    state = start_pass(state)
    {:noreply, %{state | waiters: [from | state.waiters]}}
  end

  def handle_call(:sync_now, from, state) do
    {:noreply, %{state | waiters: [from | state.waiters]}}
  end

  @impl true
  def handle_info(:sync, %{task: nil} = state) do
    {:noreply, start_pass(state)}
  end

  # Ticks arriving during a pass do not overlap another sync pass.
  def handle_info(:sync, state), do: {:noreply, state}

  def handle_info({ref, result}, %{task: %{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref}} = state) do
    {:noreply, finish(state, {:error, "store sync task exited: #{inspect(reason)}"})}
  end

  def handle_info(_, state), do: {:noreply, state}

  # ── Pass orchestration ──

  defp start_pass(state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    opts = state.opts
    callers = Shuttle.Env.callers()

    # Unlinked task with no hard kill timer: `felt sync --ff-only` bounds its
    # own network fetch with `--fetch-timeout` and lets local merges finish
    # without risking a killed Git process holding index.lock.
    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        Shuttle.Env.adopt_callers(callers)
        run_pass(opts)
      end)

    %{
      state
      | task: %{pid: task.pid, ref: task.ref},
        timer: nil,
        started: System.monotonic_time(:millisecond),
        status: %{state.status | state: :running}
    }
  end

  defp finish(state, result) do
    duration = System.monotonic_time(:millisecond) - state.started

    status =
      case result do
        :disabled ->
          %{
            enabled: false,
            state: :disabled,
            last_run_at: nil,
            duration_ms: nil,
            repos: []
          }

        {:ok, repos} ->
          %{
            enabled: true,
            state: :idle,
            last_run_at: now_iso(),
            duration_ms: duration,
            repos: repos
          }

        {:error, error} ->
          error = error |> String.trim() |> String.slice(0, 500)
          Logger.warning("StoreSync: #{error}")

          %{
            enabled: true,
            state: :error,
            last_run_at: now_iso(),
            duration_ms: duration,
            error: error,
            repos: state.status.repos
          }
      end

    Enum.each(state.waiters, &GenServer.reply(&1, status))

    schedule(
      %{state | task: nil, started: nil, waiters: [], status: status},
      interval_ms(state.opts)
    )
  end

  defp interval_ms(opts) do
    case Keyword.fetch(opts, :interval_ms) do
      {:ok, value} -> value
      :error -> Shuttle.Env.app(:store_sync_interval_ms, @default_interval_ms)
    end
  end

  defp schedule(state, :infinity), do: %{state | timer: nil}
  defp schedule(state, delay), do: %{state | timer: Process.send_after(self(), :sync, delay)}

  # ── Sync pass via `felt sync --ff-only --json` ──

  @doc false
  def run_pass(opts \\ []) do
    enabled? = Keyword.get_lazy(opts, :enabled, &Shuttle.Host.auto_ff_stores?/0)

    if enabled? do
      stores = Keyword.get_lazy(opts, :stores, &Shuttle.FeltStores.configured_stores/0)
      runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
      fetch_timeout = Keyword.get(opts, :fetch_timeout, @default_fetch_timeout)

      {repos, _seen} =
        Enum.reduce(stores, {[], MapSet.new()}, fn store, {acc, seen} ->
          store_real = resolve_realpath(store)

          if MapSet.member?(seen, store_real) do
            {acc, seen}
          else
            case sync_store(store, store_real, runner, fetch_timeout) do
              {:ok, store_repos} ->
                new_repos = Enum.reject(store_repos, &MapSet.member?(seen, &1.path))

                new_seen =
                  Enum.reduce(store_repos, MapSet.put(seen, store_real), fn r, s ->
                    MapSet.put(s, r.path)
                  end)

                {acc ++ new_repos, new_seen}

              {:error, repo_error} ->
                {acc ++ [repo_error], MapSet.put(seen, store_real)}
            end
          end
        end)

      {:ok, repos}
    else
      :disabled
    end
  end

  defp sync_store(store, store_real, runner, fetch_timeout) do
    args = [
      "-C",
      store,
      "sync",
      "--ff-only",
      "--json",
      "--fetch-timeout",
      fetch_timeout
    ]

    case runner.cmd("felt", args, stderr_to_stdout: true, timeout_ms: :infinity) do
      {output, 0} ->
        decode_report(output, store_real)

      {output, status} ->
        reason = concise_error("felt sync --ff-only", output, status)
        Logger.warning("StoreSync: #{store_real}: #{reason}")
        {:error, %{path: store_real, status: :error, reason: reason}}
    end
  end

  defp decode_report(output, store_real) do
    case Jason.decode(output) do
      {:ok, %{"repos" => repos}} when is_list(repos) ->
        normalized = Enum.map(repos, &normalize_repo/1)
        Enum.each(normalized, &log_repo/1)
        {:ok, normalized}

      _ ->
        reason = "felt sync --ff-only returned invalid JSON"
        Logger.warning("StoreSync: #{store_real}: #{reason}")
        {:error, %{path: store_real, status: :error, reason: reason}}
    end
  end

  defp normalize_repo(repo) when is_map(repo) do
    %{
      path: repo["path"],
      status: normalize_status(repo["status"]),
      upstream: repo["upstream"],
      ahead: repo["ahead"],
      behind: repo["behind"],
      previous_sha: repo["previous_sha"],
      sha: repo["sha"],
      commits: repo["commits"],
      synced_at: repo["synced_at"],
      reason: repo["reason"]
    }
    |> Enum.reject(fn {_k, v} -> is_nil(v) end)
    |> Map.new()
  end

  @known_statuses %{
    "up_to_date" => :up_to_date,
    "fast_forwarded" => :fast_forwarded,
    "stale_dirty" => :stale_dirty,
    "stale_diverged" => :stale_diverged,
    "ahead" => :ahead,
    "no_upstream" => :no_upstream,
    "fetch_failed" => :fetch_failed,
    "error" => :error
  }

  defp normalize_status(status), do: Map.get(@known_statuses, status, :error)

  defp log_repo(%{status: :fast_forwarded, path: path} = repo) do
    Logger.info(
      "StoreSync: fast-forwarded #{path} (#{repo[:previous_sha]}..#{repo[:sha]}, #{repo[:commits]} commit(s))"
    )
  end

  defp log_repo(%{status: :fetch_failed, path: path, reason: reason}) do
    Logger.warning("StoreSync: fetch failed for #{path}: #{reason}")
  end

  defp log_repo(_), do: :ok

  defp resolve_realpath(path) do
    expanded = Shuttle.Env.expand(path)

    case Shuttle.Realpath.resolve(expanded) do
      {:ok, resolved} -> resolved
      {:error, _} -> expanded
    end
  end

  defp concise_error(cmd, output, status) do
    first_line =
      output
      |> String.trim()
      |> String.split("\n", parts: 2)
      |> List.first("")
      |> String.trim()

    if first_line == "" do
      "#{cmd} exited #{inspect(status)}"
    else
      String.slice(first_line, 0, 240)
    end
  end

  defp now_iso do
    DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end
end
