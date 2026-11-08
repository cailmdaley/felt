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

  With no worker running, the fiber's own conversation reopened by a human
  (`Shuttle.SessionResume.reopened/1`) takes the message in its place: live
  input is typed into its terminal, anything else is a native message.
  """

  alias Shuttle.{Harnesses, Messaging, Poller, SessionLedger, SessionResume}

  @type result ::
          {:message, pos_integer(), map()}
          | {:launch, String.t(), term()}
          | {:error, pos_integer(), String.t()}

  @spec deliver(String.t(), String.t(), keyword()) :: result()
  def deliver(fiber_id, text, opts \\ []) do
    worker = if opts[:resume_mode] != "fresh", do: Poller.live_worker(fiber_id)

    reopened =
      if is_nil(worker) and opts[:resume_mode] != "fresh", do: SessionResume.reopened(fiber_id)

    cond do
      reopened && opts[:live_input] -> {:input, type_into(reopened, text)}
      reopened -> message(reopened, text, opts)
      worker && opts[:live_input] -> input(fiber_id, text)
      worker && opts[:message_after_launch] -> await_message_address(fiber_id, text, opts)
      worker -> message(worker, text, opts)
      opts[:message_after_launch] -> launch_then_message(fiber_id, text, opts)
      true -> launch(fiber_id, text, opts)
    end
  end

  # The human's next turn, typed as they would type it.
  defp type_into(%{session: tmux}, text) do
    case Shuttle.Terminal.paste(SessionResume.runner(), tmux, text) do
      :ok -> {:ok, tmux}
      {:error, reason} -> {:error, {:paste_failed, reason}}
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
  Queue context in the owning fiber's hook mailbox without arming or launching
  it. The mailbox keeps it, deduplicated by `message_id`, until a worker of the
  fiber takes it: the live one, or the next one to launch.

  Options: `:wake` starts a turn when a worker is live; `:from` labels the
  sender (default `"shuttle"`); `:unless_live` refuses with
  `{:error, :live_worker}` while a worker is live, queueing nothing, so the
  sender messages that worker directly.
  """
  def context(entry, text, message_id, opts \\ []) do
    cond do
      get_in(entry.fiber, ["shuttle", "host"]) != Poller.own_host_id() ->
        {:error, :not_owner}

      Keyword.get(opts, :unless_live, false) and live_context_worker(entry) != nil ->
        {:error, :live_worker}

      true ->
        wake = Keyword.get(opts, :wake, false) and live_context_worker(entry) != nil
        from = Keyword.get(opts, :from) || "shuttle"
        args = ["context-mailbox", "put", context_key(entry), message_id, text, "--from", from]

        args = if opts[:reply_to], do: args ++ ["--reply-to", opts[:reply_to]], else: args

        args =
          if opts[:notify_address],
            do: args ++ ["--notify-address", opts[:notify_address]],
            else: args

        args = if opts[:notify_when_idle], do: args ++ ["--notify-when-idle"], else: args
        args = if opts[:notify_wake], do: args ++ ["--notify-wake"], else: args
        args = if wake, do: args ++ ["--wake"], else: args

        args =
          if opts[:thread_signal],
            do: args ++ ["--thread-signal", Jason.encode!(opts[:thread_signal])],
            else: args

        args =
          if opts[:retained_at], do: args ++ ["--retained-at", opts[:retained_at]], else: args

        with {:ok, _} <- Shuttle.CLI.run(args) do
          flush_context(entry)
          {:ok, :queued}
        end
    end
  end

  @doc "Offer a fiber's pending context to its current live conversation."
  def flush_context(entry) do
    server = Shuttle.Env.server(Poller)

    if is_pid(GenServer.whereis(server)) do
      # Delivery carries the worker-owned epoch and the address it committed;
      # selecting or flushing a destination never changes authority.
      with {:ok, address, generation} <-
             Poller.context_receiver(server, Shuttle.Threads.address(entry.fiber)) do
        Shuttle.CLI.run(
          ["context-mailbox", "deliver", context_key(entry), address, to_string(generation)],
          timeout_ms: 32_000
        )
      end
    else
      :ok
    end
  end

  defp live_context_worker(entry) do
    if is_pid(GenServer.whereis(Shuttle.Env.server(Poller))),
      do: Poller.live_worker(Shuttle.Threads.address(entry.fiber))
  end

  @doc "The key of a fiber's context mailbox: its store and durable identity."
  def context_key(entry),
    do: entry.felt_store <> ":" <> (entry.fiber["uid"] || entry.fiber["id"])
end
