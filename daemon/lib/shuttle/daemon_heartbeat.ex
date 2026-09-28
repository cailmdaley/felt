defmodule Shuttle.DaemonHeartbeat do
  @moduledoc """
  The daemon's own liveness record on disk, and the boot-time verdict it
  supports: *was this restart a hard kill of a healthy daemon, back within
  seconds, or anything else?*

  ## What it is for

  `Shuttle.Poller`'s boot quarantine parks every genuinely-fresh autonomous
  dispatch on each (re)start until a human runs `bin/shuttle release`. That is
  right for the restarts it was built for — a crash loop on an overloaded login
  node, a deploy, a machine coming back after hours down — because the danger
  is mass re-dispatch of stale work, and a deploy puts a new build in front of
  the fleet.

  It is wrong for a restart nobody asked for and nothing was stale across. A
  host that hard-caps every process at some number of CPU-seconds SIGKILLs the
  beam mid-flight and a supervisor respawns it seconds later; the workers keep
  running (tmux owns them, and `SessionReconciliation.adopt_orphans/1`
  re-adopts them), but all *new* work silently stops until a person notices.

  ## Asked-for versus hard: the signal decides

  Every asked-for stop — `make stop`, `bin/shuttle`'s stop before installing a
  supervisor, `bin/shuttle-deploy`'s listener kill, `systemctl --user restart`,
  `launchctl kickstart -k` — sends SIGTERM first. SIGTERM runs `init:stop/0`,
  whose first act is `Shuttle.Application.prep_stop/1`, which calls `retire/2`:
  the file is deleted, and no later write can re-create it. The next boot finds
  no heartbeat and holds. A hard kill runs nothing, so only a hard kill leaves
  the file behind to be judged. (If a write is wedged in the filesystem longer
  than `retire/2`'s bounded wait, its rename can still land after the delete;
  the next boot then judges it like a hard kill.)

  ## Shape

  One JSON object, rewritten whole every 10s of uptime (write-temp-then-rename,
  so a kill mid-write leaves the previous complete file rather than a truncated
  one):

      {"v":1,
       "at":1764500000000,         # wall clock of THIS write, epoch ms
       "booted_at":1764499000000,  # when the writing incarnation booted
       "host":"…", "node":"…",     # its own_host_id and OS node name
       "workers":["fiber-uid", …], # runtime keys it had live at this write
       "boots":[…,1764499000000]}  # ring of recent boot times, newest last

  Writes run off the Poller (`write_async/2`), are best-effort and never raise:
  the Poller must not die, stall or log-spam because a filesystem misbehaved.
  The *first* write happens at boot, which is what makes the crash-loop brake
  work — an incarnation that dies two seconds in still leaves its own
  `booted_at` behind.

  ## The conditions for an automatic release

  `verdict/2` releases the quarantine only when all of these hold. Anything
  else — a missing file, a truncated one, a key of the wrong type, a stale
  timestamp — **holds** (fail closed: the quarantine is the safe state, and the
  cost of holding is a human typing one command, versus a mass re-dispatch of
  stale work if we guess wrong).

  1. **Same daemon, same machine** — the record's `host` equals this daemon's
     `own_host_id` and its `node` equals this machine's node name. `~/.shuttle`
     can sit on a `$HOME` shared by several login nodes that all carry the same
     fleet host id; an idle daemon on another node keeps a fresh heartbeat
     with no workers, which says nothing about this node's restart.

  2. **Fresh** — `|now - at| <= 60_000` ms, and `at` is no older than the
     machine's own boot (`/proc/stat` `btime`, where available). The write
     interval is 10_000 ms, so the grace is 6× the interval: it has to absorb
     the last write's lag plus the respawn plus this daemon's own boot (a `felt
     shuttle contract` probe and a tmux scan) on a login node under
     contention, while staying far too short to cover any restart a human
     would call an outage.

  3. **Worker continuity** — every runtime key the heartbeat recorded as live
     is live NOW, as established by this boot's adoption, never by trusting
     the file. Workers recorded and gone means something ended the workers
     too: not a fast bounce. `Shuttle.Poller` asks for a verdict only once
     adoption's tmux scan has completed (`adopted?`), because an empty recorded
     set is vacuously continuous — an idle daemon that bounced in seconds has no
     stale backlog to withhold, but a daemon that has not looked cannot claim
     that. App workers do not count as observed: adoption re-adopts them from
     their own JSON record, so a recorded app worker holds.

  4. **Not a crash loop** — a crash loop *also* has a fresh heartbeat, so
     condition 2 cannot see it. Two brakes, coarse and fine:

       * the previous incarnation lived at least 90_000 ms
         (`at - booted_at`), the same number `Shuttle.Poller`'s resume-loop
         breaker calls a healthy run: below it, the daemon is dying faster than
         it can do useful work and a human should look;
       * at most 3 boots, this one included, in the preceding 600_000 ms
         (the resume-loop cooldown's window), counted from the `boots` ring
         plus the boot being judged. The first brake only measures the
         incarnation that wrote last; the ring bounds churn across several,
         including the pattern where each incarnation lives just over the
         threshold.

  The contract-skew gate (`contract_check.ok`) is deliberately outside all of
  this: it has no release endpoint by design, so `Shuttle.Poller` does not even
  ask for a verdict while skewed.
  """

  require Logger

  @version 1

  # Write cadence. Ten seconds is cheap (one small rename per tick) and well
  # under the freshness grace, so a single missed write can never make a healthy
  # daemon look stale.
  @default_write_interval_ms 10_000

  # Freshness grace: 6× the write interval. See the moduledoc.
  @default_grace_ms 60_000

  # "The previous incarnation was a healthy run." Mirrors
  # `Shuttle.Poller`'s @resume_loop_rapid_exit_threshold_ms — the codebase
  # already calls 90s the line between a real run and instant death, and the
  # same reasoning applies to the daemon itself: a config-, port- or
  # stack-level failure dies in seconds, while an rlimit kill only lands after
  # the beam has burned its CPU budget, which takes minutes of wall clock.
  @min_healthy_run_ms 90_000

  # Churn bound: at most 3 boots in 10 minutes, counting the boot being judged
  # (the ring holds only previous boots; this one is appended after the
  # verdict). The window is the resume-loop cooldown (@resume_loop_cooldown_ms),
  # for the same reason it was chosen there — long enough that a genuine loop
  # cannot hide inside it, short enough that yesterday's incident does not hold
  # today's work. Three allows this boot plus two earlier ones (say a deploy and
  # one rlimit kill) while refusing a daemon that is coming back every few
  # minutes.
  @crash_loop_window_ms 600_000
  @max_boots_in_window 3

  # How many boot times the ring keeps. Enough to answer the window question
  # above with room to spare; the file stays one short line.
  @boots_ring_size 8

  @type record :: %{String.t() => term()}
  @type verdict :: {:release, String.t()} | {:hold, String.t()}

  @doc """
  The heartbeat path, honoring the same env the rest of the daemon's host-local
  state does: `SHUTTLE_HEARTBEAT_FILE`, else `$SHUTTLE_DATA_DIR/heartbeat.json`,
  default `~/.shuttle/heartbeat.json`.
  """
  @spec default_path() :: String.t()
  def default_path do
    System.get_env("SHUTTLE_HEARTBEAT_FILE") || Path.join(Shuttle.data_dir(), "heartbeat.json")
  end

  @spec default_write_interval_ms() :: pos_integer()
  def default_write_interval_ms, do: @default_write_interval_ms

  @spec grace_ms() :: pos_integer()
  def grace_ms, do: @default_grace_ms

  @spec min_healthy_run_ms() :: pos_integer()
  def min_healthy_run_ms, do: @min_healthy_run_ms

  @doc """
  Read the heartbeat left by the previous incarnation.

  `{:ok, record}` only for a file that parses into an object carrying a numeric
  `at` and `booted_at`; everything else is `{:error, reason}` and the caller
  holds. Never raises.
  """
  @spec read(String.t()) :: {:ok, record()} | {:error, term()}
  def read(path) when is_binary(path) do
    with {:ok, body} <- File.read(path),
         {:ok, %{} = json} <- Jason.decode(body),
         {:ok, at} <- fetch_ms(json, "at"),
         {:ok, booted_at} <- fetch_ms(json, "booted_at") do
      {:ok,
       %{
         "v" => json["v"],
         "at" => at,
         "booted_at" => booted_at,
         "host" => string_or_nil(json["host"]),
         "node" => string_or_nil(json["node"]),
         "workers" => string_list(json["workers"]),
         "boots" => ms_list(json["boots"])
       }}
    else
      {:error, reason} -> {:error, reason}
      {:ok, _not_an_object} -> {:error, :malformed}
    end
  rescue
    # A heartbeat read can never be the reason the daemon fails to boot.
    error -> {:error, error}
  end

  @doc """
  Write the heartbeat for this incarnation.

  `workers` is the set (or list) of runtime keys currently live; `boots` is the
  ring to persist, newest last. Always `:ok` — a failed write logs at debug and
  is retried by the next tick; the only consequence of losing writes is that the
  next boot holds the quarantine, which is the safe direction.
  """
  @spec write(String.t(), keyword()) :: :ok
  def write(path, opts) when is_binary(path) and is_list(opts) do
    record = %{
      "v" => @version,
      "at" => Keyword.get(opts, :at, System.system_time(:millisecond)),
      "booted_at" => Keyword.fetch!(opts, :booted_at),
      "host" => Keyword.get(opts, :host),
      "node" => Keyword.get(opts, :node),
      "workers" => opts |> Keyword.get(:workers, []) |> Enum.to_list() |> Enum.map(&to_string/1),
      "boots" => Keyword.get(opts, :boots, [])
    }

    tmp = path <> ".tmp"

    with :ok <- File.mkdir_p(Path.dirname(path)),
         {:ok, body} <- Jason.encode(record),
         :ok <- File.write(tmp, body),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, reason} ->
        Logger.debug("daemon heartbeat write failed (#{path}): #{inspect(reason)}")
        _ = File.rm(tmp)
        :ok
    end
  rescue
    error ->
      Logger.debug("daemon heartbeat write raised (#{path}): #{inspect(error)}")
      :ok
  end

  @doc """
  Write the heartbeat off the caller's process.

  The caller (the Poller's liveness tick) keeps the timer, because handling the
  tick is what proves the daemon alive; the write itself runs in an unlinked
  process so a slow filesystem never stalls the Poller. At most one write per
  path is in flight: the writer holds a `:global` name for the path while it
  works, and a tick that finds the name taken skips its write rather than
  queueing behind a stuck one. A writer checks `retired?/1` only after taking the
  name, which is what lets `retire/2` guarantee no write lands after it returns.
  """
  @spec write_async(String.t(), keyword()) :: :ok
  def write_async(path, opts) when is_binary(path) and is_list(opts) do
    {:ok, _pid} =
      Task.start(fn ->
        name = writer_name(path)

        if :global.register_name(name, self()) == :yes do
          try do
            unless retired?(path), do: write(path, opts)
          after
            :global.unregister_name(name)
          end
        end
      end)

    :ok
  end

  @doc """
  Remove the heartbeat for good, for a graceful shutdown.

  A SIGTERM'd daemon (`make stop`, `bin/shuttle stop`, a supervisor restart, a
  deploy's listener kill) is a restart someone asked for, and must arm the next
  boot's quarantine. Removing the file is how it says so: the next boot finds no
  heartbeat and holds. Only a hard kill (an rlimit SIGKILL) leaves the file for
  the next boot to judge.

  Marks `path` retired first, so no later write can re-create it, then waits up
  to `wait_ms` for a write already in flight to finish, then deletes the file.
  A writer takes its name before it checks the mark, so every writer either
  finished before the wait or sees the mark and writes nothing. Never raises.
  """
  @spec retire(String.t(), non_neg_integer()) :: :ok
  def retire(path, wait_ms \\ 2_000) when is_binary(path) do
    :persistent_term.put({__MODULE__, :retired, path}, true)

    case :global.whereis_name(writer_name(path)) do
      pid when is_pid(pid) ->
        ref = Process.monitor(pid)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          wait_ms -> Process.demonitor(ref, [:flush])
        end

      :undefined ->
        :ok
    end

    _ = File.rm(path)
    _ = File.rm(path <> ".tmp")
    :ok
  rescue
    error ->
      Logger.warning("daemon heartbeat retire failed (#{path}): #{inspect(error)}")
      :ok
  end

  @doc "Whether `retire/2` has run for `path` in this VM."
  @spec retired?(String.t()) :: boolean()
  def retired?(path), do: :persistent_term.get({__MODULE__, :retired, path}, false)

  defp writer_name(path), do: {__MODULE__, :writer, path}

  @doc """
  Append `boot_at` to `boots`, keeping the newest `#{@boots_ring_size}`.
  """
  @spec push_boot([integer()], integer()) :: [integer()]
  def push_boot(boots, boot_at) when is_list(boots) and is_integer(boot_at) do
    (boots ++ [boot_at]) |> Enum.take(-@boots_ring_size)
  end

  @doc """
  The boot-time verdict: may this daemon release its own boot quarantine?

  `observed` is what this daemon established for itself, never what the file
  claims:

    * `:now_ms` — wall clock, epoch ms;
    * `:live` — the runtime keys reconciliation/adoption has just found live;
    * `:host` — this daemon's `own_host_id`;
    * `:node` — this machine's OS node name (`node_name/0`);
    * `:app` — the live keys whose worker is an app conversation (optional);
    * `:machine_booted_at_ms` — when this machine booted (`machine_booted_at_ms/0`;
      optional, `nil` where unknown).

  Returns `{:release, reason}` or `{:hold, reason}`; the reason is logged.
  """
  @spec verdict({:ok, record()} | {:error, term()}, map()) :: verdict()
  def verdict(read_result, observed)

  # Fail closed, loudly enough to explain itself: no usable heartbeat means the
  # daemon has no evidence this restart was a fast bounce, and "no evidence" is
  # a hold. This is the first-boot case, the graceful-shutdown case, the
  # wiped-data-dir case, and the truncated/garbage-file case alike.
  def verdict({:error, reason}, _observed),
    do: {:hold, "no usable daemon heartbeat (#{inspect(reason)})"}

  def verdict({:ok, hb}, %{now_ms: now_ms, live: live_workers} = observed) do
    age_ms = now_ms - hb["at"]
    previous_run_ms = hb["at"] - hb["booted_at"]
    recorded = MapSet.new(hb["workers"] || [])
    live = MapSet.new(live_workers)
    recent_boots = 1 + Enum.count(hb["boots"] || [], &(now_ms - &1 <= @crash_loop_window_ms))

    cond do
      hb["host"] != Map.get(observed, :host) or hb["node"] != Map.get(observed, :node) ->
        {:hold,
         "daemon heartbeat was written by host #{inspect(hb["host"])} on node " <>
           "#{inspect(hb["node"])}, not this daemon (host #{inspect(Map.get(observed, :host))} " <>
           "on node #{inspect(Map.get(observed, :node))})"}

      age_ms > @default_grace_ms or age_ms < -@default_grace_ms ->
        {:hold, "daemon heartbeat is #{age_ms}ms old (grace #{@default_grace_ms}ms)"}

      predates_machine_boot?(hb["at"], Map.get(observed, :machine_booted_at_ms)) ->
        {:hold, "daemon heartbeat predates this machine's boot"}

      not MapSet.subset?(recorded, live) ->
        missing = recorded |> MapSet.difference(live) |> Enum.sort()

        {:hold, "workers recorded live in the heartbeat are gone: #{Enum.join(missing, ", ")}"}

      # An app conversation's liveness is not observed by adoption: the daemon
      # re-adopts it from its own JSON record (`Shuttle.AppWorkers.active/0`),
      # so for app workers the continuity check would only compare the file
      # with itself. Hold rather than release on a proof that degenerates.
      not MapSet.disjoint?(recorded, MapSet.new(Map.get(observed, :app, []))) ->
        app = recorded |> MapSet.intersection(MapSet.new(observed.app)) |> Enum.sort()

        {:hold,
         "heartbeat recorded app workers, whose liveness adoption cannot observe: " <>
           Enum.join(app, ", ")}

      previous_run_ms < @min_healthy_run_ms ->
        {:hold,
         "previous daemon incarnation lived #{previous_run_ms}ms " <>
           "(< #{@min_healthy_run_ms}ms); looks like a crash loop"}

      recent_boots > @max_boots_in_window ->
        {:hold,
         "#{recent_boots} daemon boots, this one included, in the last " <>
           "#{div(@crash_loop_window_ms, 60_000)}m " <>
           "(> #{@max_boots_in_window}); looks like a crash loop"}

      true ->
        {:release,
         "fast bounce: heartbeat #{age_ms}ms old, previous incarnation ran #{previous_run_ms}ms, " <>
           "#{MapSet.size(recorded)} worker(s) still live"}
    end
  end

  @doc """
  When this machine booted, epoch ms, from `/proc/stat`'s `btime`; `nil` where
  that is unavailable (non-Linux, unreadable). A heartbeat older than the
  machine's boot was written before a reboot, however fresh its clock says it
  is.
  """
  @spec machine_booted_at_ms() :: integer() | nil
  def machine_booted_at_ms do
    with {:ok, stat} <- File.read("/proc/stat"),
         [_, secs] <- Regex.run(~r/^btime (\d+)$/m, stat) do
      String.to_integer(secs) * 1000
    else
      _ -> nil
    end
  end

  defp predates_machine_boot?(at, booted) when is_integer(booted), do: at < booted
  defp predates_machine_boot?(_at, _booted), do: false

  @doc """
  This machine's OS node name. The heartbeat's `host` is the fleet identity
  (`own_host_id`), which several login nodes sharing one `$HOME` can all carry;
  the node name is what tells their heartbeats apart.
  """
  @spec node_name() :: String.t() | nil
  def node_name do
    case :inet.gethostname() do
      {:ok, name} -> to_string(name)
      _ -> nil
    end
  end

  # ── Parsing ──

  defp fetch_ms(json, key) do
    case Map.get(json, key) do
      value when is_integer(value) -> {:ok, value}
      value when is_float(value) -> {:ok, trunc(value)}
      _ -> {:error, {:malformed, key}}
    end
  end

  defp string_or_nil(value) when is_binary(value), do: value
  defp string_or_nil(_), do: nil

  defp string_list(value) when is_list(value), do: Enum.filter(value, &is_binary/1)
  defp string_list(_), do: []

  defp ms_list(value) when is_list(value), do: Enum.filter(value, &is_integer/1)
  defp ms_list(_), do: []
end
