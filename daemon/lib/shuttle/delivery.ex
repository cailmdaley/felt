defmodule Shuttle.Delivery do
  @moduledoc """
  Puts a message in front of a fiber's worker on this host.

  A live worker receives it through session messaging (`Shuttle.Messaging`),
  woken as for any task request. A fiber with no live worker launches with the
  message as its From User, under the dispatcher's `"continue"` rule: it
  resumes a previous conversation that ended without a handoff when its
  transcript is on this host and belongs to that dispatch; otherwise it starts
  fresh — after a clean handoff, a missing transcript, or no previous run.

  A `resume_mode` option carries the board's explicit verb. `"previous"` forces
  the resume and still messages a live worker; `"fresh"` starts a new session,
  cutting a live worker.

  Everything else reaches a worker through the fiber's inbox (`context/4`):
  consumption offers it to a live worker as context, wakes it or replaces it
  with a fresh session, and starts a session for a fiber with none when an
  entry asks for a turn and `inbox_gate/2` allows it (`start_for_inbox/1`).

  A conversation a human resumed from the card is its worker
  (`Shuttle.SessionResume`), so it is addressed like any other.
  """

  alias Shuttle.{Harnesses, Messaging, Poller, SessionLedger}

  @type result ::
          {:message, pos_integer(), map()}
          | {:launch, String.t(), term()}
          | {:error, pos_integer(), String.t()}

  @spec deliver(String.t(), String.t(), keyword()) :: result()
  def deliver(fiber_id, text, opts \\ []) do
    worker = if opts[:resume_mode] != "fresh", do: Poller.live_worker(fiber_id)

    cond do
      worker && opts[:live_input] -> input(fiber_id, text)
      worker && opts[:message_after_launch] -> await_message_address(fiber_id, text, opts)
      worker -> message(worker, text, opts)
      opts[:message_after_launch] -> launch_then_message(fiber_id, text, opts)
      true -> launch(fiber_id, text, opts)
    end
  end

  defp input(fiber_id, text) do
    result =
      Poller.dispatch_fiber(fiber_id,
        force: true,
        ad_hoc: true,
        existing_only: true,
        resume_mode: "previous",
        user_message: text
      )

    {:input, result}
  end

  # A transcript batch is always a native message, including the first one to
  # a dormant constitution. Its message_id therefore has the same durable
  # receipt whether the daemon dies before or after the worker starts.
  defp launch_then_message(fiber_id, text, opts) do
    result =
      Poller.dispatch_fiber(fiber_id,
        force: true,
        ad_hoc: true,
        resume_mode: opts[:resume_mode] || "continue"
      )

    case result do
      {:ok, _} -> await_message_address(fiber_id, text, opts)
      {:error, :already_running} -> await_message_address(fiber_id, text, opts)
      _ -> {:launch, "fresh", result}
    end
  end

  defp await_message_address(fiber_id, text, opts) do
    deadline =
      System.monotonic_time(:millisecond) + Shuttle.Env.app(:delivery_address_wait_ms, 30_000)

    await_message_address(fiber_id, text, opts, deadline)
  end

  defp await_message_address(fiber_id, text, opts, deadline) do
    worker = Poller.live_worker(fiber_id)

    cond do
      worker && is_binary(worker[:session_uuid]) ->
        message(worker, text, opts)

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, 503,
         "the worker started but has no addressable conversation yet; the transcript retains this batch"}

      true ->
        Process.sleep(100)
        await_message_address(fiber_id, text, opts, deadline)
    end
  end

  defp launch(fiber_id, text, opts) do
    since = System.system_time(:millisecond)

    # The dispatcher reads the fiber itself, so it alone decides whether there
    # is a conversation worth resuming.
    result =
      Poller.dispatch_fiber(fiber_id,
        force: true,
        ad_hoc: true,
        user_message: text,
        resume_mode:
          opts[:resume_mode] || if(opts[:live_input], do: "resume_or_start", else: "continue")
      )

    # A worker that appeared between the look and the launch takes the message.
    with {:error, :already_running} <- result,
         worker when is_map(worker) <- Poller.live_worker(fiber_id) do
      message(worker, text, opts)
    else
      _ -> {:launch, launch_mode(result, fiber_id, since), result}
    end
  end

  # Which launch the dispatcher chose, from the session ledger: a resume
  # records its `resume` row before the dispatch returns.
  defp launch_mode({:ok, session}, fiber_id, since) do
    resumed? =
      SessionLedger.read_since(since)
      |> Enum.any?(fn row ->
        row["kind"] == "resume" and (row["tmux"] == session or row["fiber"] == fiber_id)
      end)

    if resumed?, do: "previous", else: "fresh"
  end

  defp launch_mode(_result, _fiber_id, _since), do: "fresh"

  defp message(%{session_uuid: native, cli: cli}, text, opts) do
    case harness(cli) do
      harness when is_binary(harness) and is_binary(native) ->
        address = Messaging.address("local", harness, native)

        payload = %{
          "address" => address,
          "text" => text,
          "from" => opts[:from] || "shuttle",
          "wake" => true,
          "message_id" => Keyword.get(opts, :message_id) || message_id()
        }

        case Messaging.send_message(payload) do
          {:ok, status, receipt} -> {:message, status, receipt}
          {:error, status, error} -> {:error, status, error}
        end

      _ ->
        {:error, 409,
         "the live worker has no addressable conversation yet; try again once it has started"}
    end
  end

  defp harness(cli) do
    if Harnesses.supported?(cli), do: Harnesses.normalize(cli)
  end

  defp message_id,
    do: "deliver-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

  @doc """
  Store context and its delivery wishes in the owning fiber's inbox, then
  trigger consumption. The inbox keeps it, deduplicated by `message_id`, until
  a worker takes it.

  Options: `:turn` (`"ask"` or `"force"`; `:wake` means `"ask"`) makes the
  entry ask for a turn. Consumption decides whether a live worker is offered
  it as context, woken or replaced by a fresh session; a fiber with no worker
  is started for it when it may be (`start_for_inbox/1`). Without a turn the
  entry is context for whichever worker comes next. `:from` labels the sender
  (default `"shuttle"`); `:unless_live` refuses with `{:error, :live_worker}`
  while a worker is live, queueing nothing, so the sender messages that worker
  directly. A `thread-` id names the event it reports, so its first capture
  stands whatever a retry states.

  Answers `{:ok, :queued}`, `{:ok, :starting}` when a session is starting for
  the entry, or `{:ok, {:waiting, detail}}` saying what a waking entry waits
  for.
  """
  def context(entry, text, message_id, opts \\ []) do
    worker = live_context_worker(entry)
    turn = opts[:turn] || if(opts[:wake], do: "ask")

    cond do
      get_in(entry.fiber, ["shuttle", "host"]) != Poller.own_host_id() ->
        {:error, :not_owner}

      Keyword.get(opts, :unless_live, false) and worker != nil ->
        {:error, :live_worker}

      true ->
        from = Keyword.get(opts, :from) || "shuttle"
        args = ["context-mailbox", "put", context_key(entry), message_id, text, "--from", from]

        args = if opts[:reply_to], do: args ++ ["--reply-to", opts[:reply_to]], else: args

        args =
          if opts[:notify_address],
            do: args ++ ["--notify-address", opts[:notify_address]],
            else: args

        args = if opts[:notify_when_idle], do: args ++ ["--notify-when-idle"], else: args
        args = if opts[:notify_wake], do: args ++ ["--notify-wake"], else: args
        args = if turn, do: args ++ ["--turn", turn], else: args

        args =
          if String.starts_with?(message_id, "thread-"), do: args ++ ["--derived"], else: args

        args =
          if opts[:thread_signal],
            do: args ++ ["--thread-signal", Jason.encode!(opts[:thread_signal])],
            else: args

        args =
          if opts[:retained_at], do: args ++ ["--retained-at", opts[:retained_at]], else: args

        with {:ok, _} <- Shuttle.CLI.run(args) do
          case flush_context(entry) do
            {:error, :no_worker} when turn != nil -> {:ok, start_for_inbox(entry)}
            _ -> {:ok, :queued}
          end
        end
    end
  end

  @doc """
  Whether a non-human inbox entry may start a session on `fiber`: a
  constitution `own_host` owns, open or active, not at rest, and not a
  standing constitution whose schedule is paused or whose scheduled run is due
  (that run takes the entries). Answers `:ok` or `{:error, reason}`; entries
  for a fiber refused here wait for whichever worker comes next.
  """
  def inbox_gate(fiber, own_host) do
    standing? = Poller.fiber_kind(fiber) == "standing"

    cond do
      get_in(fiber, ["shuttle", "host"]) != own_host -> {:error, :not_owner}
      fiber["status"] not in ["open", "active"] -> {:error, :closed}
      standing? and fiber["status"] != "active" -> {:error, :paused}
      fiber["horizon"] == "stashed" -> {:error, :at_rest}
      standing? and Shuttle.Poller.StandingRoles.standing_role_due?(fiber) -> {:error, :run_due}
      true -> :ok
    end
  end

  @launch_note "Shuttle started this session because messages are waiting in this fiber's inbox. " <>
                 "They reach you as Shuttle context beside this prompt or at your first tool call, " <>
                 "or as a message within a few minutes; read them before you decide what to do."

  @doc """
  Start a session for a fiber with no worker whose inbox holds a due entry
  that asks for a turn, when `inbox_gate/2` and the Poller admit it. The inbox
  reserves the entries for a two-minute lease (`shuttle inbox consume <key> -
  0`), so repeated calls launch once; the launched session takes them through
  its fiber hook, and that claim delivers them. A refused or held launch, or a
  session that dies first, leaves them pending for the next call once the
  lease lapses. The launch prompt says messages are arriving and carries none
  of their text.

  Answers `:starting`, `:queued` (a worker appeared and takes them) or
  `{:waiting, detail}`.
  """
  def start_for_inbox(entry) do
    server = Shuttle.Env.server(Poller)
    # The uid resolves in the Poller's index without a store read.
    id = entry.fiber["uid"] || Shuttle.Threads.address(entry.fiber)
    fiber_id = Shuttle.Threads.address(entry.fiber)

    with :ok <- inbox_gate(entry.fiber, Poller.own_host_id()),
         :ok <- Poller.admit_inbox_launch(server, id),
         :launch <- reserve(entry) do
      server
      |> Poller.dispatch_fiber(id,
        force: true,
        ad_hoc: true,
        inbox: true,
        resume_mode: "continue",
        user_message: @launch_note
      )
      |> launched(fiber_id)
    else
      :in_flight -> :starting
      error -> launched(error, fiber_id)
    end
  end

  # The dormant consume reserves the asking entries and answers launch, or
  # wait while an earlier reservation's launch is in its lease.
  defp reserve(entry) do
    case consume(entry, "-", 0, []) do
      {:ok, %{"action" => "launch"}} -> :launch
      {:ok, %{"action" => _}} -> :in_flight
      other -> {:error, {:consume, other}}
    end
  end

  defp launched({:ok, _session}, _fiber_id), do: :starting
  # A busy Poller keeps the request and may yet launch.
  defp launched({:error, :poller_busy}, _fiber_id), do: :starting

  defp launched({:error, reason}, _fiber_id) when reason in [:running, :already_running],
    do: :queued

  defp launched({:error, reason}, fiber_id) do
    {:waiting,
     case reason do
       :closed ->
         "#{fiber_id} is closed; the message waits in its inbox for whoever next works on it"

       :paused ->
         "#{fiber_id}'s schedule is paused; the message waits in its inbox for whoever next works on it"

       :at_rest ->
         "#{fiber_id} is at rest; the message waits in its inbox for whoever next works on it"

       :run_due ->
         "#{fiber_id}'s scheduled run is due; the message waits in its inbox for that run"

       :held ->
         "#{Poller.own_host_id()} holds new sessions until its boot quarantine is released " <>
           "(`shuttle daemon release`); one starts for the message then"

       :full ->
         "#{Poller.own_host_id()} runs as many workers as it allows; a session starts for the message when one ends"

       :busy ->
         "#{Poller.own_host_id()}'s daemon was busy; the next poll starts a session for the message"

       {:consume, result} ->
         "the inbox could not be read for a launch (#{inspect(result)}); the next poll tries again"

       reason ->
         "the launch was refused (#{inspect(reason)}); it is tried again in two minutes"
     end}
  end

  @doc """
  Consume the inbox of each fiber in `entries` (this host's) on a poll. Each
  fiber with a live worker is consumed as `flush_context/1` does. Fibers with
  none cost one `shuttle inbox pending --waking` call between them, and each
  it finds holding a due entry that asks for a turn is started
  (`start_for_inbox/1`), including one that became due by `not_before` or
  outlived a daemon restart.
  """
  def flush_owned(entries) do
    server = Shuttle.Env.server(Poller)

    if is_pid(GenServer.whereis(server)) do
      own_host = Poller.own_host_id()

      {dormant, live} =
        Enum.split_with(entries, fn entry ->
          Poller.context_receiver(server, Shuttle.Threads.address(entry.fiber)) ==
            {:error, :no_worker}
        end)

      Enum.each(live, &flush_context/1)

      dormant
      |> Enum.filter(&(inbox_gate(&1.fiber, own_host) == :ok))
      |> waking()
      |> Enum.each(&start_for_inbox/1)
    end

    :ok
  end

  defp waking([]), do: []

  defp waking(entries) do
    by_key = Map.new(entries, &{context_key(&1), &1})

    with {:ok, output} <-
           Shuttle.CLI.run(["inbox", "pending", "--waking" | Map.keys(by_key)],
             stderr_to_stdout: false
           ),
         {:ok, counts} when is_map(counts) <- Jason.decode(output) do
      for {key, n} <- counts, is_integer(n), n > 0, entry = by_key[key], do: entry
    else
      _ -> []
    end
  end

  # True when the fresh session launched, or may yet: a busy Poller keeps the
  # request, and the reservation's lease asks again if it never arrives. Any
  # refusal leaves the live worker to be woken as usual.
  defp start_fresh(entry, worker, cost) do
    result =
      Poller.dispatch_fiber(Shuttle.Threads.address(entry.fiber),
        force: true,
        ad_hoc: true,
        resume_mode: "fresh",
        user_message:
          "Shuttle started this session to take a result that arrives as context. " <>
            "The previous session #{worker[:session_uuid]} was at rest with " <>
            "#{Shuttle.WakeCost.describe(cost)}; waking it would have re-read all of that uncached. " <>
            "Read Status first, then `shuttle show #{worker[:session_uuid]}` for what it holds that Status does not."
      )

    match?({:ok, _}, result) or result == {:error, :poller_busy}
  end

  @doc """
  Consume a fiber's inbox for its current live conversation, answering the
  decoded consume result. The worker's turn state and wake cost are read only
  when the inbox answers that a due entry asks for a turn.
  """
  def flush_context(entry) do
    server = Shuttle.Env.server(Poller)

    if is_pid(GenServer.whereis(server)) do
      fiber_id = Shuttle.Threads.address(entry.fiber)

      # Delivery carries the worker-owned epoch and the address it committed;
      # selecting or flushing a destination never changes authority.
      with {:ok, address, generation} <- Poller.context_receiver(server, fiber_id) do
        consume = &consume(entry, address, generation, &1)

        case consume.([]) do
          {:ok, %{"turn" => true}} -> consume_turn(entry, server, fiber_id, consume)
          answer -> answer
        end
      end
    else
      :ok
    end
  end

  # An idle worker is woken, or replaced by a fresh session when waking it is
  # costly. A worker whose turn no hook has reported is woken for ask entries
  # without a cost check; its idle entries wait for an observed idle. A busy
  # one takes the entries through its hook.
  defp consume_turn(entry, server, fiber_id, consume) do
    case Poller.worker_turn(server, fiber_id) do
      :idle ->
        worker = Poller.live_worker(server, fiber_id)
        cost = worker && Shuttle.WakeCost.costly(worker[:session_uuid])

        case consume.(if cost, do: ["--idle", "--costly"], else: ["--idle"]) do
          {:ok, %{"action" => "fresh"}} = answer ->
            if start_fresh(entry, worker, cost), do: answer, else: consume.(["--idle"])

          answer ->
            answer
        end

      :unknown ->
        consume.(["--unknown"])

      _ ->
        {:ok, %{"action" => "wait", "turn" => true}}
    end
  end

  # The answer is the output's one JSON line, which a failed send of an open
  # batch prints before exiting nonzero. A consume that could not decide
  # prints none and stays an error.
  defp consume(entry, address, generation, flags) do
    args = ["inbox", "consume", context_key(entry), address, to_string(generation)] ++ flags
    result = Shuttle.CLI.run(args, timeout_ms: 32_000)

    output =
      case result do
        {:ok, output} -> output
        {:command_error, _status, output} -> output
        _ -> ""
      end

    output
    |> String.split("\n")
    |> Enum.find_value(result, fn line ->
      case Jason.decode(line) do
        {:ok, %{"action" => _} = answer} -> {:ok, answer}
        _ -> nil
      end
    end)
  end

  defp live_context_worker(entry) do
    if is_pid(GenServer.whereis(Shuttle.Env.server(Poller))),
      do: Poller.live_worker(Shuttle.Threads.address(entry.fiber))
  end

  @doc "The key of a fiber's context mailbox: its store and durable identity."
  def context_key(entry),
    do: entry.felt_store <> ":" <> (entry.fiber["uid"] || entry.fiber["id"])
end
