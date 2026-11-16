defmodule ShuttleWeb.DeliverController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/deliver

  Body `{fiber_id, text, from?, origin?, context_only?, message_id?, wake?,
  resume_mode?}`. Puts `text`, from `from` or else Shuttle, in front
  of the fiber's worker on its owning host (`Shuttle.Delivery`). Agent text
  goes through its inbox, defaulting to `turn: ask`. An agent's
  `resume_mode: fresh` is recorded there under its `message_id` and starts a
  fresh session with the text in its launch prompt, under the agent gate
  (`Shuttle.Delivery.fresh/3`): 200 `{delivery: "fresh", delivered: true}`,
  202 with `delivered` null when the start is unconfirmed, or 409 with the
  refusal's `reason` and `error`. Human text is recorded there before typed
  input or a From User launch prompt transports it. `live_input` records voice
  as human input. A request carrying `origin` is forwarded to that owner's
  identical route.

  `notify_when_idle` with no `text` subscribes `from` (or `notify_address`)
  to one idle notice from the fiber's live worker and answers that
  subscription's message receipt (status `subscribed`); a fiber with no live
  worker answers 409.

  With `context_only` (and a `message_id`), `text` is queued in the fiber's
  inbox (`Shuttle.Delivery.context/4`): 202 `{delivery: "context",
  queued: true, status, detail?}`. `turn` (`"ask"` or `"force"`; `wake` means
  `"ask"`) makes the entry ask for a turn, and a fiber with no live worker is
  then started for it when it may be: `status` is `"starting"`, or `"queued"`
  with a `detail` saying what the entry waits for. `shuttle message <fiber>`
  sends this shape.

  A live inbox answer adds `consumed` (the consumer's action, members,
  followup, held and this message's state). Its status says what became of
  this message: woken, followed_up, delivered (sent as context, or delivered
  before a retry), held, starting (a replacement is launching for it) or
  queued (waiting, or sent with its arrival unconfirmed: `delivered` null).

  A human line answers `delivery: "input"`. `delivered` is `true` when the
  worker's terminal took it as typed input or its launch prompt carries it,
  `false` when it did not get it, and `null` (status 202) when its arrival is
  unconfirmed: input that may have been submitted, or an owner that did not
  answer in time. `detail` then says what is known.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Delivery, OriginRouter}

  def create(conn, params) do
    {status, body} =
      route(
        Map.get(params, "fiber_id"),
        Map.get(params, "text"),
        Map.get(params, "origin"),
        Map.get(params, "from"),
        Map.take(params, [
          "address",
          "attachments",
          "context_only",
          "message_id",
          "live_input",
          "notify_address",
          "notify_when_idle",
          "notify_wake",
          "reply_to",
          "resume_mode",
          "wake",
          "turn",
          "thread_signal",
          "retained_at",
          "not_before"
        ])
      )

    conn |> put_status(status) |> json(body)
  end

  @doc "Deliver on the owning daemon, forwarding when `origin` names a remote."
  @spec route(term(), term(), String.t() | nil, term()) :: {pos_integer(), map()}
  def route(fiber_id, text, origin, from \\ "shuttle", context \\ %{}) do
    from = if from in [nil, ""], do: "shuttle", else: from
    text = if is_binary(text) and String.trim(text) != "", do: text

    cond do
      not (is_binary(fiber_id) and String.trim(fiber_id) != "") ->
        {400, %{delivered: false, error: "fiber_id is required"}}

      text == nil and context["notify_when_idle"] != true ->
        {400, %{delivered: false, error: "text is required"}}

      true ->
        case OriginRouter.route(origin) do
          {:error, {:unknown_origin, name}} ->
            {400, %{delivered: false, error: OriginRouter.unknown_origin_message(name)}}

          {:remote, remote} ->
            payload =
              %{"fiber_id" => fiber_id, "text" => text, "from" => from}
              |> Map.merge(context)

            remote |> OriginRouter.forward("/api/v1/deliver", payload) |> relay()

          :local ->
            local(fiber_id, text, from, context)
        end
    end
  end

  defp local(fiber_id, nil, from, context), do: subscribe_idle(fiber_id, from, context)

  defp local(fiber_id, text, _from, %{"live_input" => true} = context) do
    {:human, Delivery.human(fiber_id, text, message_id: context["message_id"], source: "voice")}
    |> reply(fiber_id)
  end

  defp local(fiber_id, text, from, context) do
    if from != "human" and context["resume_mode"] == "fresh" do
      Delivery.fresh(fiber_id, text, from: from, message_id: context["message_id"])
      |> reply(fiber_id)
    else
      agent_inbox = from != "human"

      if context["context_only"] == true or agent_inbox do
        turn =
          cond do
            context["turn"] in ["ask", "force"] ->
              context["turn"]

            context["wake"] == true or (agent_inbox and context["context_only"] != true) ->
              "ask"

            true ->
              nil
          end

        id =
          context["message_id"] ||
            if(context["context_only"] != true,
              do:
                "deliver-" <>
                  Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
            )

        context_reply(fiber_id, text, id,
          attachments: context["attachments"],
          wake: context["wake"] == true,
          turn: turn,
          retained_at: context["retained_at"],
          not_before: context["not_before"],
          thread_signal: context["thread_signal"],
          from: from,
          reply_to: context["reply_to"],
          notify_address: context["notify_address"],
          notify_when_idle: context["notify_when_idle"] == true,
          notify_wake: context["notify_wake"] == true
        )
      else
        {:human,
         Delivery.human(fiber_id, text,
           message_id: context["message_id"],
           resume_mode: resume_mode(context["resume_mode"])
         )}
        |> reply(fiber_id)
      end
    end
  end

  # A notify-only request subscribes `from` to one idle notice from the
  # fiber's live worker, as a session-addressed message with no text would.
  defp subscribe_idle(fiber_id, from, context) do
    with {:ok, %{fibers: [entry | _]}} <- Shuttle.FiberDocuments.get_shuttle(fiber_id),
         {:ok, address, _epoch} <-
           Shuttle.Poller.context_receiver(Shuttle.Threads.address(entry.fiber)),
         {:ok, status, receipt} <-
           context
           |> Map.take(["message_id", "notify_address", "notify_wake"])
           |> Map.merge(%{
             "address" => address,
             "from" => from,
             "notify_when_idle" => true,
             "wake" => false
           })
           |> Shuttle.Messaging.send_message() do
      {status, receipt}
    else
      {:ok, %{fibers: []}} -> {404, %{error: "no constitution #{fiber_id} here"}}
      {:error, status, error} when is_integer(status) -> {status, %{error: error}}
      _ -> {409, %{error: "#{fiber_id} has no live worker to watch"}}
    end
  end

  defp resume_mode(mode) when mode in ["fresh", "previous"], do: mode
  defp resume_mode(_mode), do: "continue"

  defp context_reply(fiber_id, text, message_id, opts)
       when is_binary(message_id) and message_id != "" do
    with {:ok, %{fibers: [entry | _]}} <- Shuttle.FiberDocuments.get_shuttle(fiber_id),
         {:ok, outcome} <- Delivery.context(entry, text, message_id, opts) do
      body = %{delivery: "context", delivered: false, queued: true, fiber_id: fiber_id}

      body =
        case outcome do
          {:scheduled, instant} ->
            Map.merge(body, %{status: "scheduled", not_before: instant})

          :starting ->
            Map.merge(body, %{
              status: "starting",
              detail: "#{fiber_id} has no live worker; a session is starting and takes it"
            })

          {:waiting, detail} ->
            Map.merge(body, %{status: "queued", detail: detail})

          {:consumed, answer} ->
            body
            |> Map.merge(consumed(answer, message_id in (answer["members"] || [])))
            |> Map.put(:consumed, answer)

          {:unconsumed, detail} ->
            Map.merge(body, %{
              status: "queued",
              delivered: nil,
              detail:
                "#{fiber_id}'s inbox holds it, but could not be consumed for the live worker now " <>
                  "(#{detail}); the worker's hook or the next poll takes it, unless it was delivered before"
            })

          :queued ->
            Map.put(body, :status, "queued")
        end

      {202, body}
    else
      {:ok, %{fibers: []}} ->
        {404, %{delivered: false, queued: false, error: "no constitution #{fiber_id} here"}}

      {:error, :not_owner} ->
        {409, %{error: "this daemon does not own the fiber"}}

      error ->
        {422, %{error: inspect(error)}}
    end
  end

  defp context_reply(_fiber_id, _text, _id, _opts),
    do: {400, %{error: "message_id is required for context"}}

  # What the consume did with this message, from its own state after the pass
  # (`"message"`), not from whatever else the pass sent.
  defp consumed(%{"refused" => detail}, _sent?),
    do: %{status: "queued", delivered: false, detail: detail}

  defp consumed(%{"message" => "delivered"} = answer, sent?) do
    status =
      cond do
        not sent? -> "delivered"
        answer["followup"] -> "followed_up"
        answer["action"] == "wake" -> "woken"
        true -> "delivered"
      end

    %{status: status, delivered: true}
  end

  defp consumed(%{"message" => "sent"}, _sent?),
    do: %{
      status: "queued",
      delivered: nil,
      detail: "sent to the worker; its arrival is not yet confirmed, and the inbox resends it"
    }

  defp consumed(%{"message" => "unknown"}, _sent?),
    do: %{
      status: "queued",
      delivered: nil,
      detail:
        "the inbox no longer holds this message (it expired, or was never stored); whether it arrived is unknown"
    }

  defp consumed(%{"message" => "reserved"}, _sent?), do: %{status: "starting", delivered: false}
  defp consumed(%{"held" => "cost"}, _sent?), do: %{status: "held", delivered: false}
  defp consumed(_answer, _sent?), do: %{status: "queued", delivered: false}

  # An agent's fresh session: started (delivered), possibly started
  # (delivered null: a busy Poller, or a repeat of one whose outcome is
  # unknown), or refused with its reason, which the sender may send again
  # under the same id once that changes. A contract-41 CLI reads these the
  # same way.
  defp reply({:fresh, {:ok, session}}, fiber_id),
    do:
      {200,
       Map.merge(
         %{delivery: "fresh", fiber_id: fiber_id, delivered: true},
         Shuttle.WorkerBackend.wire(session)
       )}

  defp reply({:fresh, {:duplicate, id, "delivered"}}, fiber_id),
    do:
      {200,
       %{delivery: "fresh", fiber_id: fiber_id, delivered: true, duplicate: true, message_id: id}}

  defp reply({:fresh, {:duplicate, id, _unknown}}, fiber_id),
    do:
      {202,
       %{
         delivery: "fresh",
         fiber_id: fiber_id,
         delivered: nil,
         duplicate: true,
         message_id: id,
         detail: "a fresh session was requested under this id; whether it started is unknown"
       }}

  defp reply({:fresh, {:error, :poller_busy}}, fiber_id),
    do:
      {202,
       %{
         delivery: "fresh",
         fiber_id: fiber_id,
         delivered: nil,
         detail: "the owning daemon's poller is busy; the fresh session starts when it gets to it"
       }}

  defp reply({:fresh, {:error, {:inbox_record, error}}}, fiber_id),
    do: {422, %{delivery: "fresh", fiber_id: fiber_id, delivered: false, error: inspect(error)}}

  defp reply({:fresh, {:error, reason}}, fiber_id),
    do:
      {409,
       %{
         delivery: "fresh",
         fiber_id: fiber_id,
         delivered: false,
         reason: inspect(reason),
         error: Delivery.fresh_refusal(reason, fiber_id)
       }}

  defp reply({:human, {:ok, _} = result}, fiber_id), do: reply({:input, result}, fiber_id)

  defp reply({:human, {:duplicate, _, _} = result}, fiber_id),
    do: reply({:input, result}, fiber_id)

  defp reply({:human, {:error, :poller_busy} = result}, fiber_id),
    do: reply({:input, result}, fiber_id)

  defp reply({:human, {:error, {:paste_failed, {:unknown, _}}} = result}, fiber_id),
    do: reply({:input, result}, fiber_id)

  defp reply({:human, result}, fiber_id) do
    {status, body} = ShuttleWeb.DispatchReply.render(fiber_id, result)
    {status, Map.merge(body, %{delivered: false, delivery: "input"})}
  end

  # A repeated id types nothing and answers what became of the first try: a
  # line that was delivered, or one whose daemon died between recording and
  # typing it (unknown), which may never have arrived.
  defp reply({:input, {:duplicate, id, disposition}}, fiber_id),
    do:
      {200,
       %{
         delivery: "input",
         fiber_id: fiber_id,
         delivered: if(disposition == "delivered", do: true),
         duplicate: true,
         disposition: disposition,
         message_id: id
       }}

  defp reply({:input, {:ok, _}}, fiber_id),
    do: {200, %{delivery: "input", fiber_id: fiber_id, delivered: true}}

  defp reply({:input, result}, fiber_id),
    do:
      {202,
       %{
         delivery: "input",
         fiber_id: fiber_id,
         delivered: nil,
         detail: "Terminal input may have been submitted: #{inspect(result)}"
       }}

  defp relay({:forwarded, status, body}) do
    case Jason.decode(body) do
      {:ok, payload} when is_map(payload) ->
        {status, payload}

      _ ->
        {502, %{delivered: false, error: "the owning daemon answered: #{body}"}}
    end
  end

  defp relay({:error, {:forward_failed, name, :timeout}}) do
    {202,
     %{
       delivered: nil,
       reason: "forward_timeout",
       origin: name,
       detail: "#{name} did not answer in time; the message may have reached its worker"
     }}
  end

  defp relay({:error, {:forward_failed, name, reason}}) do
    {502, %{delivered: false, reason: "forward_failed", origin: name, error: inspect(reason)}}
  end
end
