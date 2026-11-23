defmodule Shuttle.Delivery do
  @moduledoc """
  Puts a message in front of a fiber's worker on this host.

  Agent messages reach the fiber's inbox (`context/4`): consumption offers
  context, wakes or follows up with a worker, or reserves a gated fresh or
  dormant launch. A launched worker takes the entries through its fiber hook.

  The human's lines (`human/3`, for `/dispatch` and `/deliver`) and an
  agent's fresh session request (`fresh/3`) are recorded and deduplicated in
  that inbox (`Shuttle.InboxRecord`), then transported as typed input or a
  launch prompt. Human launches keep the board's forced-start authority; a
  fresh request passes the agent gate. Voice uses `human/3` with source
  `voice`.

  A conversation a human resumed from the card is its worker
  (`Shuttle.SessionResume`), so it is addressed like any other.
  """

  alias Shuttle.Poller

  # How long a delivery's put, consumes and launch may take together; see
  # `context/4`.
  @budget_ms 35_000

  @doc """
  The human's start of `fiber_id`, from `/dispatch` and `/deliver`, with
  `text`, the human's line, or nil. `:from` names an agent that sent the line
  through `/dispatch` instead (`:reply_to` is the fiber a reply reaches): its
  line is recorded as that agent's message, headed with the sender, and
  answers the fiber's question only when it is addressed to that agent
  (`shuttle ask --clear --answered-by`). A line is recorded first under
  `:message_id` (`Shuttle.InboxRecord`, `:source` voice for a spoken one),
  so a repeated id transports nothing; then it is typed into the live worker
  or carried in a From User launch prompt. `:resume_mode` `"continue"` (the
  default) lets the worker's state choose; any other mode, or nil for the
  dispatcher's own choice, is used as given. `:force` and `:ad_hoc` default to
  true; `:existing_only`, `:release_launch_reservation` and `:project_dir`
  pass to `Poller.dispatch_fiber/2`.
  """
  def human(fiber_id, text, opts \\ []) do
    from = opts[:from] || "human"

    sender =
      if from == "human",
        do: [],
        else: [
          user_message_from: opts[:reply_to] || from,
          answered_by: from,
          answered_reply_to: opts[:reply_to]
        ]

    dispatch = fn mode ->
      Poller.dispatch_fiber(
        fiber_id,
        sender ++
          [
            force: Keyword.get(opts, :force, true),
            ad_hoc: Keyword.get(opts, :ad_hoc, true),
            existing_only: Keyword.get(opts, :existing_only, false),
            release_launch_reservation: Keyword.get(opts, :release_launch_reservation, false),
            project_dir: opts[:project_dir],
            resume_mode: mode,
            user_message: text,
            line_recorded: text != nil
          ]
      )
    end

    launch = fn _entry ->
      case Keyword.get(opts, :resume_mode, "continue") do
        "continue" -> human_launch(fiber_id, dispatch, opts[:source])
        mode -> dispatch.(mode)
      end
    end

    if text,
      do:
        Shuttle.InboxRecord.submit(fiber_id, text, opts[:message_id], from, launch,
          source: opts[:source]
        ),
      else: launch.(nil)
  end

  # A human's line in the mode the worker's state chooses, through `dispatch`
  # (a function of the resume mode): typed into a live worker (`previous`),
  # else `continue` (`resume_or_start` for voice), which starts fresh after a
  # clean handoff and otherwise resumes the session or starts cold. A worker
  # that appeared between the look and the launch takes the line as typed
  # input.
  defp human_launch(fiber_id, dispatch, source) do
    mode =
      cond do
        Poller.live_worker(fiber_id) -> "previous"
        source == "voice" -> "resume_or_start"
        true -> "continue"
      end

    case dispatch.(mode) do
      {:error, :already_running} when mode in ["continue", "resume_or_start"] ->
        dispatch.("previous")

      result ->
        result
    end
  end

  @doc """
  An agent's request for a fresh session: recorded under its `message_id`
  (`Shuttle.InboxRecord`), then started with the text in its launch prompt,
  replacing a live worker. The launch is an inbox launch, so the agent gate
  holds it: a closed, resting or unarmed fiber, a due scheduled run, the boot
  quarantine or a full host refuses it, and the record is settled
  undeliverable so the same id may be sent again. A repeated id starts
  nothing and answers the stored outcome.

  Answers `{:fresh, {:ok, session}}`, `{:fresh, {:error, reason}}` or
  `{:fresh, {:duplicate, id, disposition}}`.
  """
  def fresh(fiber_id, text, opts \\ []) do
    from = opts[:from] || "shuttle"

    result =
      Shuttle.InboxRecord.submit(fiber_id, text, opts[:message_id], from, fn entry ->
        Poller.dispatch_fiber(entry.fiber["uid"] || Shuttle.Threads.address(entry.fiber),
          inbox: true,
          inbox_replace: true,
          ad_hoc: true,
          resume_mode: "fresh",
          user_message: text,
          user_message_from: from
        )
      end)

    {:fresh, result}
  end

  @doc "Why a fresh session request was refused, for its sender."
  def fresh_refusal(reason, fiber_id) do
    why =
      case reason do
        :not_owner ->
          "#{Poller.own_host_id()} does not own #{fiber_id}"

        :closed ->
          "#{fiber_id} is closed"

        :not_armed ->
          "#{fiber_id} is not armed"

        :paused ->
          "#{fiber_id}'s schedule is paused"

        :at_rest ->
          "#{fiber_id} is at rest"

        :run_due ->
          "#{fiber_id}'s scheduled run is due"

        :held ->
          "#{Poller.own_host_id()} holds new sessions until its boot quarantine is released"

        :full ->
          "#{Poller.own_host_id()} runs as many workers as it allows"

        :running ->
          "a worker started on #{fiber_id} meanwhile"

        :resume_loop ->
          "#{fiber_id}'s workers keep dying on start"

        :preflight_cooldown ->
          "#{fiber_id}'s last launch was refused before it started"

        :dispatch_cooldown ->
          "#{fiber_id}'s launches keep failing"

        reason ->
          "the launch was refused (#{inspect(reason)})"
      end

    "no fresh session started: #{why}. Send it again under the same message id once that changes."
  end

  @doc """
  Store context and its delivery wishes in the owning fiber's inbox, then
  trigger consumption. The inbox keeps it, deduplicated by `message_id`, until
  a worker takes it.

  Options: `:turn` (`"ask"` or `"force"`; `:wake` means `"ask"`) makes the
  entry ask for a turn. Consumption decides whether a live worker is offered
  it as context, woken or replaced by a fresh session; a fiber with no worker
  is started for it when it may be (`start_for_inbox/1`). Without a turn the
  entry is context for whichever worker comes next. `:from` labels the sender
  (default `"shuttle"`). A `thread-` id names the event it reports, so its first capture
  stands whatever a retry states. `:not_before` (UTC RFC 3339) is the
  earliest instant the entry may be delivered; an entry that asks for a turn
  then asks with `if_costly: fresh`, so a cold cache does not hold it.

  Answers `{:ok, {:consumed, answer}}` for a live worker, `{:ok, :queued}`,
  `{:ok, {:unconsumed, detail}}` when consuming the inbox for the live worker
  failed (the entry stays pending for that worker's hook or the next worker),
  `{:ok, :starting}` when a session is starting,
  `{:ok, {:waiting, detail}}` saying what a waking entry waits for, or
  `{:ok, {:scheduled, not_before}}` for an entry not yet due, which is stored
  and nothing more: no consumption, launch or ask clearing. A delayed retry of
  an id the inbox has already delivered or cancelled is refused, naming which.
  The put, consumes and any launch share a 35-second budget, so an
  owner answers inside a routing hub's forward
  (`Shuttle.OriginRouter.default_forward_timeout_ms/0`); clearing the ask runs
  beside them.
  """
  def context(entry, text, message_id, opts \\ []) do
    deadline = System.monotonic_time(:millisecond) + @budget_ms
    turn = opts[:turn] || if(opts[:wake], do: "ask")

    cond do
      get_in(entry.fiber, ["shuttle", "host"]) != Poller.own_host_id() ->
        {:error, :not_owner}

      true ->
        from = Keyword.get(opts, :from) || "shuttle"
        args = ["context-mailbox", "put", "--from", from]

        args = if opts[:reply_to], do: args ++ ["--reply-to", opts[:reply_to]], else: args

        args =
          if opts[:notify_address],
            do: args ++ ["--notify-address", opts[:notify_address]],
            else: args

        args = if opts[:notify_when_idle], do: args ++ ["--notify-when-idle"], else: args
        args = if opts[:notify_wake], do: args ++ ["--notify-wake"], else: args
        args = if turn, do: args ++ ["--turn", turn], else: args

        args =
          if opts[:not_before],
            do: args ++ ["--not-before", opts[:not_before], "--if-costly", "fresh"],
            else: args

        args =
          if String.starts_with?(message_id, "thread-"), do: args ++ ["--derived"], else: args

        args =
          if opts[:thread_signal],
            do: args ++ ["--thread-signal", Jason.encode!(opts[:thread_signal])],
            else: args

        args =
          if opts[:retained_at], do: args ++ ["--retained-at", opts[:retained_at]], else: args

        {args, command_opts} =
          if opts[:attachments] not in [nil, []] do
            {args ++ ["--attachments-stdin"],
             [input: Jason.encode!(opts[:attachments]), input_eof: true]}
          else
            {args, []}
          end

        command_opts = [timeout_ms: remaining(deadline)] ++ command_opts

        # Text beginning with "-" is a positional after "--", never a flag.
        args = args ++ ["--", context_key(entry), message_id, text]

        with {:ok, _} <- Shuttle.CLI.run(args, command_opts) do
          # Beside the delivery, outside its budget: the answer does not wait
          # on a lifecycle write.
          if from != "shuttle" and not future?(opts[:not_before]) do
            caller = self()

            Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
              Process.put(:"$callers", [caller])

              clear_args =
                ["--answered-by", from] ++
                  if(is_binary(opts[:reply_to]) and opts[:reply_to] != "",
                    do: ["--reply-to", opts[:reply_to]],
                    else: []
                  )

              Shuttle.LifecycleService.transition(
                :clear_ask,
                entry.fiber["uid"] || entry.fiber["id"],
                clear_args
              )
            end)
          end

          if future?(opts[:not_before]) do
            {:ok, {:scheduled, opts[:not_before]}}
          else
            case flush_context(entry, message: message_id, deadline: deadline) do
              {:error, :no_worker} when turn != nil ->
                {:ok, start_for_inbox(entry, deadline)}

              {:ok, answer} ->
                if answer["action"] == "wait" and answer["turn"] do
                  server = Shuttle.Env.server(Poller)
                  caller = self()

                  Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
                    Process.put(:"$callers", [caller])
                    Process.sleep(30_000)
                    flush_context(entry, server: server)
                  end)
                end

                {:ok, {:consumed, answer}}

              waiting when waiting in [:ok, {:error, :no_worker}, {:error, :authority_unknown}] ->
                {:ok, :queued}

              failure ->
                {:ok, {:unconsumed, consume_failure(failure)}}
            end
          end
        end
    end
  end

  defp consume_failure({:command_error, status, output}) do
    case String.trim(output) do
      "" -> "shuttle inbox consume ended #{inspect(status)}"
      text -> text
    end
  end

  defp consume_failure(failure), do: inspect(failure)

  defp future?(nil), do: false

  defp future?(instant) do
    case DateTime.from_iso8601(instant) do
      {:ok, time, _} -> DateTime.compare(time, DateTime.utc_now()) == :gt
      _ -> false
    end
  end

  @doc """
  Whether a non-human inbox entry may start a session on `fiber`: a
  constitution `own_host` owns that its author has armed (`status: active`),
  not at rest, and not a standing constitution whose scheduled run is due
  (that run takes the entries). Arming is the author's to give, so a draft or
  a constitution at rest keeps its entries for whoever arms it next; an
  outstanding `ask` does not matter. Answers `:ok` or `{:error, reason}`.
  """
  def inbox_gate(fiber, own_host) do
    standing? = Poller.fiber_kind(fiber) == "standing"
    status = fiber["status"]

    cond do
      get_in(fiber, ["shuttle", "host"]) != own_host -> {:error, :not_owner}
      status == "closed" -> {:error, :closed}
      standing? and status != "active" -> {:error, :paused}
      fiber["horizon"] == "stashed" -> {:error, :at_rest}
      status != "active" -> {:error, :not_armed}
      standing? and Shuttle.Poller.StandingRoles.standing_role_due?(fiber) -> {:error, :run_due}
      true -> :ok
    end
  end

  @doc "Whether `reason` is an `inbox_gate/2` refusal: the document's policy, not a failed launch."
  def gate_refusal?(reason),
    do: reason in [:not_owner, :closed, :paused, :at_rest, :not_armed, :run_due]

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

  Answers `:starting`, `:queued` (a worker appeared and takes them, or
  nothing asks for a turn any more) or `{:waiting, detail}`.
  """
  def start_for_inbox(entry, deadline \\ System.monotonic_time(:millisecond) + @budget_ms) do
    server = Shuttle.Env.server(Poller)
    # The uid resolves in the Poller's index without a store read.
    id = entry.fiber["uid"] || Shuttle.Threads.address(entry.fiber)
    fiber_id = Shuttle.Threads.address(entry.fiber)

    with :ok <- inbox_gate(entry.fiber, Poller.own_host_id()),
         :ok <- Poller.admit_inbox_launch(server, id, remaining(deadline)),
         :launch <- reserve(entry, deadline) do
      server
      |> Poller.dispatch_fiber(id,
        ad_hoc: true,
        inbox: true,
        resume_mode: "continue",
        user_message: @launch_note,
        call_timeout_ms: remaining(deadline)
      )
      |> launched(fiber_id)
    else
      :in_flight -> :starting
      :nothing -> :queued
      error -> launched(error, fiber_id)
    end
  end

  # The dormant consume reserves the asking entries and answers launch, or
  # wait: launching while an earlier reservation's launch is in its lease,
  # else because nothing asks for a turn any more.
  defp reserve(entry, deadline) do
    case consume(entry, "-", 0, [], min(32_000, remaining(deadline))) do
      {:ok, %{"action" => "launch"}} -> :launch
      {:ok, %{"launching" => true}} -> :in_flight
      {:ok, %{"action" => _}} -> :nothing
      other -> {:error, {:consume, other}}
    end
  end

  @doc """
  What a due entry asking for a turn waits for in the inbox of `entry`, a
  fiber with no worker: the refusal `start_for_inbox/2` would meet, worded as
  its waiting detail, or nil when the next poll starts a session for it.
  """
  def inbox_wait(entry) do
    id = entry.fiber["uid"] || Shuttle.Threads.address(entry.fiber)

    with :ok <- inbox_gate(entry.fiber, Poller.own_host_id()),
         :ok <- Poller.admit_inbox_launch(Shuttle.Env.server(Poller), id) do
      nil
    else
      error ->
        case launched(error, Shuttle.Threads.address(entry.fiber)) do
          {:waiting, detail} -> detail
          _ -> nil
        end
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

       :not_armed ->
         "#{fiber_id} is not armed; the message waits in its inbox for whoever arms it"

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

       :resume_loop ->
         "#{fiber_id}'s workers keep dying on start, so its resume-loop breaker is open; " <>
           "the message waits in its inbox until the breaker's cooldown ends"

       :preflight_cooldown ->
         "#{fiber_id}'s last launch was refused before it started (see its blocked card); " <>
           "the message waits in its inbox until that cooldown ends"

       :dispatch_cooldown ->
         "#{fiber_id}'s launches keep failing, so they are paused for a cooldown; " <>
           "the message waits in its inbox until it ends"

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

  # A fresh answer (waking the worker is costly) starts the reserved
  # replacement. A busy Poller keeps the request, and the reservation's lease
  # asks again if it never arrives. When the Poller refuses it, `fallback`
  # (consume again without the cost, waking the worker) answers instead; a
  # wait then carries the refusal's reason as `"refused"`.
  defp replace(answer, entry, server, worker, cost, deadline, fallback) do
    fiber_id = Shuttle.Threads.address(entry.fiber)
    previous = worker[:session_uuid]

    result =
      Poller.dispatch_fiber(server, fiber_id,
        inbox: true,
        inbox_replace: true,
        ad_hoc: true,
        resume_mode: "fresh",
        user_message:
          @launch_note <>
            " The previous session #{previous} was at rest with #{Shuttle.WakeCost.describe(cost)}; " <>
            "waking it would have re-read all of that uncached. " <>
            "Read Status first, then `shuttle show #{previous}` for what it holds that Status does not.",
        call_timeout_ms: remaining(deadline)
      )

    case launched(result, fiber_id) do
      :starting ->
        answer

      refusal ->
        answer = fallback.()

        with {:waiting, detail} <- refusal,
             {:ok, %{"action" => "wait"} = wait} <- answer do
          {:ok, Map.put(wait, "refused", detail)}
        else
          _ -> answer
        end
    end
  end

  @doc """
  Consume a fiber's inbox for its current live conversation, answering the
  decoded consume result. The worker's turn state and wake cost are read only
  when the inbox answers that a due entry asks for a turn. Options: `:server`
  (the Poller), and `:message`, an entry id whose state the answer reports
  (`"message"`: delivered, sent, reserved, pending or unknown).
  """
  def flush_context(entry, opts \\ []) do
    server = opts[:server] || Shuttle.Env.server(Poller)
    message = if opts[:message], do: ["--message", opts[:message]], else: []
    deadline = opts[:deadline] || System.monotonic_time(:millisecond) + @budget_ms

    if is_pid(GenServer.whereis(server)) do
      fiber_id = Shuttle.Threads.address(entry.fiber)

      # Delivery carries the worker-owned epoch and the address it committed;
      # selecting or flushing a destination never changes authority.
      with {:ok, address, generation} <- Poller.context_receiver(server, fiber_id) do
        consume = fn flags ->
          consume(
            entry,
            address,
            generation,
            flags ++ message,
            min(32_000, remaining(deadline))
          )
        end

        case consume.([]) do
          {:ok, %{"turn" => true}} -> consume_turn(entry, server, fiber_id, consume, deadline)
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
  # one gets the consumer's follow-up. A worker that ended since the first
  # consume leaves the entries for the next pass.
  defp consume_turn(entry, server, fiber_id, consume, deadline) do
    case Poller.worker_turn(server, fiber_id) do
      :idle ->
        worker = Poller.live_worker(server, fiber_id)
        cost = worker && Shuttle.WakeCost.costly(worker[:session_uuid])

        case consume.(if cost, do: ["--idle", "--costly"], else: ["--idle"]) do
          {:ok, %{"action" => "fresh"}} = answer ->
            replace(answer, entry, server, worker, cost, deadline, fn -> consume.(["--idle"]) end)

          answer ->
            answer
        end

      :unknown ->
        consume.(["--unknown"])

      :busy ->
        consume.(["--busy"])

      nil ->
        {:ok, %{"action" => "wait", "turn" => true}}
    end
  end

  defp remaining(deadline), do: max(1, deadline - System.monotonic_time(:millisecond))

  # The answer is the output's one JSON line, which a failed send of an open
  # batch prints before exiting nonzero. A consume that could not decide
  # prints none and stays an error.
  defp consume(entry, address, generation, flags, timeout_ms) do
    args = ["inbox", "consume", context_key(entry), address, to_string(generation)] ++ flags
    result = Shuttle.CLI.run(args, timeout_ms: timeout_ms)

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

  @doc "The key of a fiber's context mailbox (see `fiber_key/3`)."
  def context_key(entry),
    do: fiber_key(entry.felt_store, entry.fiber["uid"], entry.fiber["id"])

  @doc """
  A fiber's inbox key: `fiber:<uid>`, naming no store, so the inbox stays put
  when the fiber's tree moves to another store. A fiber without a uid is keyed
  by its store and id.
  """
  def fiber_key(_store, uid, _id) when is_binary(uid) and uid != "", do: "fiber:" <> uid
  def fiber_key(store, _uid, id), do: store <> ":" <> id
end
