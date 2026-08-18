defmodule Shuttle.BoundedIO do
  @moduledoc """
  Run a blocking filesystem call with a deadline, in someone else's process.

  Filesystem calls have no timeout. That is fine against a local disk and wrong
  against the paths this daemon is routinely pointed at: a `project_dir` or a
  felt store inside iCloud Drive or `~/Library/CloudStorage` is behind macOS's
  TCC layer, and the first reach into one raises a consent dialog that blocks
  the calling process until a human clicks it. A bare `File.dir?/1` on such a
  path, evaluated on the `Shuttle.Poller` process, stops the daemon answering
  anything — every board read is a `GenServer.call` into that same mailbox.

  `run/3` moves the call onto a throwaway task and gives the caller a deadline.
  Past it the caller gets `default` and carries on.

  **The task must do its filesystem work raw** — `Shuttle.RawFS`, not `File.*`.
  A `File.*` call from inside the task still executes on the shared OTP file
  server, so the deadline would release this caller while every other filesystem
  call in the VM queued behind the same wedged probe: isolation in name only.
  `dir?/2` below is raw for that reason.

  ## What this does and does not buy

  It bounds the **caller**, not the operating system. A task parked in a
  blocking filesystem call cannot be killed out of it — `exit(:kill)` is
  recorded but the process only dies once the kernel returns — and while it
  waits it holds one of the VM's ten dirty IO schedulers. So an abandoned task
  is genuinely abandoned: `run/3` does not try to shut it down, it demonitors
  and walks away, and the scheduler it is sitting on stays occupied until the
  kernel returns. Call this at the same cadence you would have made the bare
  call at, never in a retry loop: ten simultaneously parked probes is the whole
  budget, and the tenth wedges every filesystem call in the VM (measured — see
  `Shuttle.RawFS`). The point is that a stalled path degrades one decision, not
  that the daemon can poll a stalled path for free.

  The default is therefore the answer to "what should we believe while the
  world is not answering?" — for an availability check, `false`: we cannot see
  the directory, so we do not act as though it is there.
  """

  require Logger

  @default_timeout_ms 500

  @doc """
  Run `fun` with a deadline, returning its value or `default` on expiry.

  `label` names the call in the timeout warning — make it say which path.
  """
  @spec run((-> result), timeout_ms :: non_neg_integer(), default: result, label: String.t()) ::
          result
        when result: term()
  def run(fun, timeout_ms \\ @default_timeout_ms, opts \\ []) do
    default = Keyword.get(opts, :default)
    label = Keyword.get(opts, :label, "filesystem call")

    task = Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fun)

    case Task.yield(task, timeout_ms) do
      {:ok, value} ->
        value

      {:exit, reason} ->
        Logger.warning("#{label} crashed (#{inspect(reason)}); assuming #{inspect(default)}")
        default

      nil ->
        # Deliberately not `Task.shutdown/2`: it would wait on a process that
        # cannot leave a blocking filesystem call, reintroducing the very stall
        # this function exists to bound.
        #
        # Abandoning is clean, not merely tolerable, and the reason is worth
        # knowing: a `Task`'s ref is a *process alias* (OTP 24+), and the task
        # replies by sending to that alias. `demonitor/2` deactivates the alias,
        # so a reply that arrives minutes later — when the path finally answers
        # — is dropped by the runtime and never reaches this mailbox at all.
        # Verified empirically, not assumed: with the demonitor removed, the
        # late `{ref, value}` does land. `:flush` handles the `:DOWN`. So the
        # `Shuttle.Poller` process picks up no stray messages from a probe it
        # gave up on. (`bounded_io_test.exs` pins this.)
        Process.demonitor(task.ref, [:flush])

        Logger.warning(
          "#{label} did not answer within #{timeout_ms}ms; assuming #{inspect(default)}. " <>
            "On macOS this is usually a consent dialog on an iCloud/CloudStorage path — " <>
            "look behind your other windows."
        )

        default
    end
  catch
    # The only exit reachable here is `async_nolink/2` failing to start the
    # child — no task supervisor (a unit test with the app not started, a
    # supervisor mid-restart). An abnormally-exiting TASK does not land here:
    # `async_nolink` does not link, so `Task.yield/2` reports that as
    # `{:exit, reason}` and the clause above handles it. So this means "we could
    # not get a process to do the work in", and the honest fallback is to make
    # the call inline rather than not at all. The caller blocks, exactly as it
    # did before this function existed.
    :exit, _ -> fun.()
  end

  @doc """
  `Shuttle.RawFS.dir?/1` under a deadline. Returns `false` when the path does
  not answer in time — "we cannot see it" and "it is not there" lead to the same decision
  here, and both are safer than dispatching a worker into a directory we could
  not confirm.
  """
  @spec dir?(Path.t(), non_neg_integer()) :: boolean()
  def dir?(path, timeout_ms \\ @default_timeout_ms) do
    run(fn -> Shuttle.RawFS.dir?(path) end, timeout_ms,
      default: false,
      label: "dir?(#{path})"
    )
  end
end
