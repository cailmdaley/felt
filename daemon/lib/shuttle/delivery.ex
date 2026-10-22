defmodule Shuttle.Delivery do
  @moduledoc """
  Puts a message in front of a fiber's worker on this host.

  A live worker receives it through session messaging (`Shuttle.Messaging`),
  woken as for any task request. A fiber with no live worker launches with the
  message as its From User, under the dispatcher's `"continue"` rule: it
  resumes a previous conversation that ended without a handoff while its
  transcript is still warm, and otherwise starts fresh — after a clean
  handoff, a cold or missing transcript, or no previous run at all. Only the
  board's explicit Resume forces a resume.
  """

  alias Shuttle.{Harnesses, Messaging, Poller, SessionLedger}

  @type result ::
          {:message, pos_integer(), map()}
          | {:launch, String.t(), term()}
          | {:error, pos_integer(), String.t()}

  @spec deliver(String.t(), String.t(), keyword()) :: result()
  def deliver(fiber_id, text, opts \\ []) do
    from = Keyword.get(opts, :from, "shuttle")

    case Poller.live_worker(fiber_id) do
      nil -> launch(fiber_id, text, from)
      worker -> message(worker, text, from)
    end
  end

  defp launch(fiber_id, text, from) do
    since = System.system_time(:millisecond)

    # The dispatcher reads the fiber itself, so it alone decides whether there
    # is a conversation worth resuming.
    result =
      Poller.dispatch_fiber(fiber_id,
        force: true,
        ad_hoc: true,
        user_message: text,
        resume_mode: "continue"
      )

    # A worker that appeared between the look and the launch takes the message.
    with {:error, :already_running} <- result,
         worker when is_map(worker) <- Poller.live_worker(fiber_id) do
      message(worker, text, from)
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

  defp message(%{session_uuid: native, cli: cli}, text, from) do
    case harness(cli) do
      harness when is_binary(harness) and is_binary(native) ->
        address = Messaging.address("local", harness, native)

        case Messaging.send_message(%{
               "address" => address,
               "text" => text,
               "from" => from,
               "wake" => true,
               "message_id" => message_id()
             }) do
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

  @doc "Queue context in the owning fiber's hook mailbox without arming or launching it."
  def context(entry, text, message_id, opts \\ []) do
    if get_in(entry.fiber, ["shuttle", "host"]) == Poller.own_host_id() do
      wake = Keyword.get(opts, :wake, false) and live_context_worker(entry) != nil
      args = ["context-mailbox", "put", context_key(entry), message_id, text]
      args = if wake, do: args ++ ["--wake"], else: args

      with {:ok, _} <- Shuttle.CLI.run(args) do
        flush_context(entry)
        {:ok, :queued}
      end
    else
      {:error, :not_owner}
    end
  end

  @doc "Offer a fiber's pending context to its current live conversation."
  def flush_context(entry) do
    server = Shuttle.Env.server(Poller)

    if is_pid(GenServer.whereis(server)) do
      # The Poller reserves the durable epoch while serializing worker selection.
      # Delivery tasks may arrive in any order, including after a daemon restart.
      with {:ok, worker, generation} <-
             GenServer.call(
               server,
               {:context_receiver, Shuttle.Threads.address(entry.fiber), context_key(entry)},
               32_000
             ) do
        address =
          case worker do
            %{session_uuid: native, cli: cli} when is_binary(native) and is_binary(cli) ->
              Messaging.address(Poller.own_host_id(), Harnesses.normalize(cli), native)

            _ ->
              "-"
          end

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

  defp context_key(entry),
    do: entry.felt_store <> ":" <> (entry.fiber["uid"] || entry.fiber["id"])
end
