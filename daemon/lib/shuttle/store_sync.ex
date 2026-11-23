defmodule Shuttle.StoreSync do
  @moduledoc """
  Periodic read-only fast-forward sync for clean felt store repositories.

  When enabled (`Shuttle.Host.auto_ff_stores?/0`), discovers every git
  repository backing a configured felt store and any symlinked mounted store
  under `.felt/`, deduplicated by realpath. For each repository, it fetches
  from upstream and runs `git merge --ff-only @{u}` ONLY when:

    * an upstream tracking branch is configured (not detached HEAD),
    * no git merge/rebase/cherry-pick/revert/bisect operation is in progress,
    * `git status --porcelain` is completely empty (no staged, unstaged, or
      untracked files), and
    * the branch has zero local commits ahead of upstream (`ahead == 0`) and
      at least one commit behind (`behind > 0`).

  It never commits, pushes, rebases, stashes, resets, checks out, or cleans.
  In any other state it leaves the repository untouched and records why it is
  stale or could not be synced, which `/api/v1/version` and `shuttle doctor`
  surface.

  Git work runs in a supervised, unlinked task so it never occupies this
  GenServer's mailbox or the Poller's critical path.
  """

  use GenServer
  require Logger

  @boot_delay_ms 10_000
  @default_interval_ms 300_000
  @git_timeout_ms 30_000
  @pass_timeout_ms 180_000
  @max_substore_scan_depth 16

  @in_progress_markers [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG"
  ]

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
  def sync_now(server \\ Shuttle.Env.server(__MODULE__), timeout \\ 30_000) do
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

  # Ticks arriving during a pass do not overlap another git pass.
  def handle_info(:sync, state), do: {:noreply, state}

  def handle_info({ref, result}, %{task: %{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: %{ref: ref}} = state) do
    {:noreply, finish(state, {:error, "store sync task exited: #{inspect(reason)}"})}
  end

  def handle_info({:sync_timeout, ref}, %{task: %{ref: ref, pid: pid}} = state) do
    Process.exit(pid, :kill)
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, {:error, "store sync pass exceeded its deadline"})}
  end

  def handle_info(_, state), do: {:noreply, state}

  # ── Pass orchestration ──

  defp start_pass(state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    owner = self()
    opts = state.opts
    callers = Shuttle.Env.callers()
    pass_timeout = Keyword.get(opts, :pass_timeout_ms, @pass_timeout_ms)

    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        Shuttle.Env.adopt_callers(callers)
        run_pass(opts)
      end)

    watch_owner(owner, task.pid)
    deadline = Process.send_after(self(), {:sync_timeout, task.ref}, pass_timeout)

    %{
      state
      | task: %{pid: task.pid, ref: task.ref, deadline: deadline},
        timer: nil,
        started: System.monotonic_time(:millisecond),
        status: %{state.status | state: :running}
    }
  end

  defp finish(state, result) do
    Process.cancel_timer(state.task.deadline)
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

  defp watch_owner(owner, task) do
    spawn(fn ->
      owner_ref = Process.monitor(owner)
      task_ref = Process.monitor(task)

      receive do
        {:DOWN, ^owner_ref, :process, _, _} -> Process.exit(task, :kill)
        {:DOWN, ^task_ref, :process, _, _} -> :ok
      end
    end)
  end

  # ── Pure sync pass & repo discovery ──

  @doc false
  def run_pass(opts \\ []) do
    enabled? = Keyword.get_lazy(opts, :enabled, &Shuttle.Host.auto_ff_stores?/0)

    if enabled? do
      stores = Keyword.get_lazy(opts, :stores, &Shuttle.FeltStores.configured_stores/0)
      repos = discover_repos(stores, opts)
      results = Enum.map(repos, &sync_repo(&1, opts))
      {:ok, results}
    else
      :disabled
    end
  end

  @doc """
  Discover unique git repository roots backing `stores` and any symlinked
  mounted stores under their `.felt/` directories, deduplicated by realpath.
  """
  @spec discover_repos([String.t()], keyword()) :: [String.t()]
  def discover_repos(stores, opts \\ []) when is_list(stores) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    timeout_ms = Keyword.get(opts, :git_timeout_ms, @git_timeout_ms)

    stores
    |> Enum.flat_map(&expand_store_and_mounts/1)
    |> Enum.map(&resolve_realpath/1)
    |> Enum.uniq()
    |> Enum.flat_map(&git_toplevel(&1, runner, timeout_ms))
    |> Enum.map(&resolve_realpath/1)
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp expand_store_and_mounts(store) do
    expanded = Shuttle.Env.expand(store)
    felt_real = resolve_realpath(Path.join(expanded, ".felt"))
    mounts = scan_symlinked_mounts(felt_real, felt_real, 0)
    [expanded | mounts]
  end

  # Walk real directories under `.felt/` up to @max_substore_scan_depth,
  # collecting the parent of any symlink resolving to a directory named `.felt`
  # outside the linking store. Never descends into symlinks.
  defp scan_symlinked_mounts(_store_real, _dir, depth) when depth > @max_substore_scan_depth,
    do: []

  defp scan_symlinked_mounts(store_real, dir, depth) do
    case File.ls(dir) do
      {:ok, entries} ->
        Enum.flat_map(entries, fn entry ->
          path = Path.join(dir, entry)

          case Shuttle.FS.lstat(path) do
            {:ok, %File.Stat{type: :symlink}} ->
              case Shuttle.Realpath.resolve(path) do
                {:ok, target} ->
                  if Path.basename(target) == ".felt" and
                       not inside?(target, store_real) and
                       Shuttle.FS.dir?(target) do
                    [Path.dirname(target)]
                  else
                    []
                  end

                {:error, _} ->
                  []
              end

            {:ok, %File.Stat{type: :directory}} ->
              scan_symlinked_mounts(store_real, path, depth + 1)

            _ ->
              []
          end
        end)

      {:error, _} ->
        []
    end
  end

  defp inside?(path, prefix), do: path == prefix or String.starts_with?(path, prefix <> "/")

  defp resolve_realpath(path) do
    expanded = Shuttle.Env.expand(path)

    case Shuttle.Realpath.resolve(expanded) do
      {:ok, resolved} -> resolved
      {:error, _} -> expanded
    end
  end

  defp git_toplevel(dir, runner, timeout_ms) do
    case git(runner, dir, ["rev-parse", "--show-toplevel"], timeout_ms) do
      {output, 0} ->
        case String.trim(output) do
          "" -> []
          root -> [root]
        end

      _ ->
        []
    end
  end

  @doc """
  Inspect one git repository and fast-forward it iff clean, on a tracked branch
  with zero commits ahead, and behind upstream.
  """
  @spec sync_repo(String.t(), keyword()) :: map()
  def sync_repo(repo, opts \\ []) do
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    timeout_ms = Keyword.get(opts, :git_timeout_ms, @git_timeout_ms)

    with {:ok, upstream} <- resolve_upstream(runner, repo, timeout_ms),
         :ok <- fetch_upstream(runner, repo, upstream, timeout_ms),
         {:ok, ahead, behind} <- ahead_behind(runner, repo, upstream, timeout_ms) do
      check_and_fast_forward(runner, repo, upstream, ahead, behind, timeout_ms)
    else
      {:no_upstream, reason} ->
        %{
          path: repo,
          status: :no_upstream,
          upstream: nil,
          ahead: nil,
          behind: nil,
          reason: reason
        }

      {:fetch_failed, upstream, reason} ->
        Logger.warning("StoreSync: fetch failed for #{repo}: #{reason}")

        %{
          path: repo,
          status: :fetch_failed,
          upstream: upstream,
          ahead: nil,
          behind: nil,
          reason: reason
        }

      {:error, upstream, reason} ->
        %{
          path: repo,
          status: :fetch_failed,
          upstream: upstream,
          ahead: nil,
          behind: nil,
          reason: reason
        }
    end
  end

  defp resolve_upstream(runner, repo, timeout_ms) do
    case git(runner, repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], timeout_ms) do
      {output, 0} ->
        case String.trim(output) do
          "" -> {:no_upstream, "detached HEAD or no upstream configured"}
          upstream -> {:ok, upstream}
        end

      _ ->
        {:no_upstream, "detached HEAD or no upstream configured"}
    end
  end

  defp fetch_upstream(runner, repo, upstream, timeout_ms) do
    case git(runner, repo, ["fetch", "--quiet"], timeout_ms) do
      {_output, 0} ->
        :ok

      {output, status} ->
        {:fetch_failed, upstream, format_git_error("git fetch", output, status)}
    end
  end

  defp ahead_behind(runner, repo, upstream, timeout_ms) do
    case git(runner, repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"], timeout_ms) do
      {output, 0} ->
        case String.split(String.trim(output)) do
          [ahead_s, behind_s] ->
            with {ahead, ""} <- Integer.parse(ahead_s),
                 {behind, ""} <- Integer.parse(behind_s) do
              {:ok, ahead, behind}
            else
              _ -> {:error, upstream, "unexpected rev-list count: #{String.trim(output)}"}
            end

          _ ->
            {:error, upstream, "unexpected rev-list count: #{String.trim(output)}"}
        end

      {output, status} ->
        {:error, upstream, format_git_error("git rev-list", output, status)}
    end
  end

  defp check_and_fast_forward(runner, repo, upstream, ahead, behind, timeout_ms) do
    cond do
      git_op_in_progress?(runner, repo, timeout_ms) ->
        %{
          path: repo,
          status: :stale_dirty,
          upstream: upstream,
          ahead: ahead,
          behind: behind,
          reason: "git operation in progress"
        }

      dirty_tree?(runner, repo, timeout_ms) ->
        %{
          path: repo,
          status: :stale_dirty,
          upstream: upstream,
          ahead: ahead,
          behind: behind,
          reason: "working tree has uncommitted changes"
        }

      ahead == 0 and behind == 0 ->
        %{
          path: repo,
          status: :up_to_date,
          upstream: upstream,
          ahead: 0,
          behind: 0,
          reason: nil
        }

      ahead == 0 and behind > 0 ->
        fast_forward(runner, repo, upstream, behind, timeout_ms)

      ahead > 0 and behind == 0 ->
        %{
          path: repo,
          status: :ahead,
          upstream: upstream,
          ahead: ahead,
          behind: 0,
          reason: "#{ahead} local commit(s) ahead of #{upstream}"
        }

      true ->
        %{
          path: repo,
          status: :stale_diverged,
          upstream: upstream,
          ahead: ahead,
          behind: behind,
          reason: "branch has diverged (#{ahead} ahead, #{behind} behind #{upstream})"
        }
    end
  end

  defp fast_forward(runner, repo, upstream, behind, timeout_ms) do
    prev_sha = short_sha(runner, repo, timeout_ms)

    case git(runner, repo, ["merge", "--ff-only", "@{u}"], timeout_ms) do
      {_output, 0} ->
        new_sha = short_sha(runner, repo, timeout_ms)
        Logger.info("StoreSync: fast-forwarded #{repo} (#{prev_sha}..#{new_sha}, #{behind} commit(s))")

        %{
          path: repo,
          status: :fast_forwarded,
          upstream: upstream,
          ahead: 0,
          behind: 0,
          previous_sha: prev_sha,
          sha: new_sha,
          commits: behind,
          synced_at: now_iso(),
          reason: nil
        }

      {output, status} ->
        reason = format_git_error("git merge --ff-only", output, status)
        Logger.warning("StoreSync: fast-forward refused for #{repo}: #{reason}")

        %{
          path: repo,
          status: :stale_dirty,
          upstream: upstream,
          ahead: 0,
          behind: behind,
          reason: reason
        }
    end
  end

  defp git_op_in_progress?(runner, repo, timeout_ms) do
    case git(runner, repo, ["rev-parse", "--git-dir"], timeout_ms) do
      {output, 0} ->
        raw = String.trim(output)
        git_dir = if Path.type(raw) == :absolute, do: raw, else: Path.expand(raw, repo)
        Enum.any?(@in_progress_markers, &File.exists?(Path.join(git_dir, &1)))

      _ ->
        true
    end
  end

  defp dirty_tree?(runner, repo, timeout_ms) do
    case git(runner, repo, ["status", "--porcelain"], timeout_ms) do
      {"", 0} -> false
      _ -> true
    end
  end

  defp short_sha(runner, repo, timeout_ms) do
    case git(runner, repo, ["rev-parse", "--short", "HEAD"], timeout_ms) do
      {output, 0} -> String.trim(output)
      _ -> nil
    end
  end

  defp git(runner, dir, args, timeout_ms) do
    runner.cmd("git", ["-C", dir | args],
      stderr_to_stdout: true,
      timeout_ms: timeout_ms,
      env: [{"GIT_TERMINAL_PROMPT", "0"}]
    )
  end

  defp format_git_error(cmd, output, :timeout) do
    trimmed = String.trim(output)
    if trimmed == "", do: "#{cmd} timed out", else: String.slice(trimmed, 0, 240)
  end

  defp format_git_error(cmd, output, status) do
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
