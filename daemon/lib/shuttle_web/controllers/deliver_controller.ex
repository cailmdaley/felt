defmodule ShuttleWeb.DeliverController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/deliver

  Body `{fiber_id, text, from?, origin?, context_only?, message_id?, wake?,
  unless_live?}`. Puts `text` in front of the fiber's
  worker on its owning host (`Shuttle.Delivery`): a live worker is messaged, a
  dormant one resumes (or dispatches, if it never ran) with `text` as its From
  User. A request carrying `origin` is forwarded to that owner's identical
  route.

  With `context_only` (and a `message_id`), `text` is queued in the fiber's
  context mailbox instead (`Shuttle.Delivery.context/4`): 202 `{delivery:
  "context", queued: true}`, launching nothing. `unless_live` makes that queue
  the next worker's: a fiber with a live worker answers 409 `{live: true}` and
  queues nothing, and a queued answer carries `status:
  "queued_for_next_worker"`. `shuttle message <fiber>` sends this shape.

  The answer names what happened in `delivery`: `"message"` with the messaging
  `receipt`, or `"resume"` / `"dispatch"` with the `/dispatch` envelope.
  `delivered` is `true` when the worker has the text, `false` when it did not
  get it, and `null` (status 202) when the text was sent but its arrival is
  unconfirmed: a receipt of status `"unknown"`, or an owner that did not answer
  in time. `detail` then says what is known.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{CLI, Delivery, OriginRouter}

  def create(conn, params) do
    {status, body} =
      route(
        Map.get(params, "fiber_id"),
        Map.get(params, "text"),
        Map.get(params, "origin"),
        Map.get(params, "from"),
        Map.take(params, [
          "address",
          "context_only",
          "from_claim",
          "message_id",
          "notify_address",
          "notify_when_idle",
          "notify_wake",
          "reply_to",
          "sender_proof",
          "wake",
          "unless_live",
          "thread_signal"
        ])
      )

    conn |> put_status(status) |> json(body)
  end

  @doc "Deliver on the owning daemon, forwarding when `origin` names a remote."
  @spec route(term(), term(), String.t() | nil, term()) :: {pos_integer(), map()}
  def route(fiber_id, text, origin, from \\ nil, context \\ %{}) do
    cond do
      not (is_binary(fiber_id) and String.trim(fiber_id) != "") ->
        {400, %{delivered: false, error: "fiber_id is required"}}

      not (is_binary(text) and String.trim(text) != "") ->
        {400, %{delivered: false, error: "text is required"}}

      true ->
        case OriginRouter.route(origin) do
          {:error, {:unknown_origin, name}} ->
            {400, %{delivered: false, error: OriginRouter.unknown_origin_message(name)}}

          {:remote, remote} ->
            {_sender, claimed} = unverified_sender(from, context["from_claim"])

            payload =
              %{"fiber_id" => fiber_id, "text" => text}
              |> Map.merge(context)
              |> Map.delete("sender_proof")
              |> Map.put("from", "shuttle")
              |> Map.put("from_claim", claimed)

            remote |> OriginRouter.forward("/api/v1/deliver", payload) |> relay()

          :local ->
            if context["context_only"] == true do
              {sender, claim} = verified_sender(context, from, text, false)

              context_reply(fiber_id, text, context["message_id"],
                wake: context["wake"] == true,
                thread_signal: context["thread_signal"],
                unless_live: context["unless_live"] == true,
                from: sender,
                from_claim: claim,
                sender_proof: context["sender_proof"],
                proof_address: context["address"],
                reply_to: context["reply_to"]
              )
            else
              {sender, claim} = unverified_sender(from, context["from_claim"])
              opts = [from: sender, from_claim: claim]
              fiber_id |> Delivery.deliver(text, opts) |> reply(fiber_id)
            end
        end
    end
  end

  defp verified_sender(context, from, text, consume) do
    request = %{
      "address" => context["address"] || "",
      "text" => text,
      "from" => from || "",
      "from_claim" => context["from_claim"] || "",
      "reply_to" => context["reply_to"] || "",
      "message_id" => context["message_id"] || "",
      "notify_address" => context["notify_address"] || "",
      "notify_when_idle" => context["notify_when_idle"] || false,
      "notify_wake" => context["notify_wake"] || false,
      "sender_proof" => context["sender_proof"] || ""
    }

    proof_args = if consume, do: ["message-proof", "--consume"], else: ["message-proof"]

    case CLI.run(proof_args, input: Jason.encode!(request) <> "\n") do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"valid" => true, "sender" => sender}} ->
            {sender, context["from_claim"] || ""}

          _ ->
            unverified_sender(from, context["from_claim"])
        end

      _ ->
        unverified_sender(from, context["from_claim"])
    end
  end

  defp unverified_sender(from, claim) do
    claim = if is_binary(claim) and claim != "", do: claim, else: from

    if is_binary(claim) and claim != "" and claim != "shuttle",
      do: {"shuttle", claim},
      else: {"shuttle", ""}
  end

  defp context_reply(fiber_id, text, message_id, opts)
       when is_binary(message_id) and message_id != "" do
    with {:ok, %{fibers: [entry | _]}} <- Shuttle.FiberDocuments.get_shuttle(fiber_id),
         {:ok, :queued} <- Delivery.context(entry, text, message_id, opts) do
      body = %{delivery: "context", delivered: false, queued: true, fiber_id: fiber_id}

      # Asked to queue only for a dormant fiber, the queue is its next worker's.
      body =
        if opts[:unless_live], do: Map.put(body, :status, "queued_for_next_worker"), else: body

      {202, body}
    else
      {:ok, %{fibers: []}} ->
        {404, %{delivered: false, queued: false, error: "no constitution #{fiber_id} here"}}

      {:error, :live_worker} ->
        {409,
         %{
           delivery: "context",
           delivered: false,
           queued: false,
           live: true,
           fiber_id: fiber_id,
           error: "the fiber has a live worker; message it directly"
         }}

      {:error, :not_owner} ->
        {409, %{error: "this daemon does not own the fiber"}}

      error ->
        {422, %{error: inspect(error)}}
    end
  end

  defp context_reply(_fiber_id, _text, _id, _opts),
    do: {400, %{error: "message_id is required for context"}}

  defp reply({:message, status, receipt}, fiber_id) do
    body = %{delivery: "message", fiber_id: fiber_id, receipt: receipt}

    cond do
      receipt["status"] == "unknown" ->
        {202,
         Map.merge(body, %{
           delivered: nil,
           detail: receipt["detail"] || "the message was sent; its arrival is unconfirmed"
         })}

      status < 300 and receipt["status"] != "rejected" ->
        {status, Map.put(body, :delivered, true)}

      true ->
        {if(status < 300, do: 502, else: status),
         Map.merge(body, %{
           delivered: false,
           error: receipt["detail"] || "the worker did not accept the message"
         })}
    end
  end

  defp reply({:launch, mode, result}, fiber_id) do
    {status, body} = ShuttleWeb.DispatchReply.render(fiber_id, result)
    delivery = if mode == "previous", do: "resume", else: "dispatch"
    {status, Map.merge(body, %{delivered: launch_delivered(status, result), delivery: delivery})}
  end

  defp reply({:error, status, error}, fiber_id),
    do: {status, %{delivered: false, delivery: "message", fiber_id: fiber_id, error: error}}

  # A launch still queued in the Poller may yet deliver the text: unconfirmed,
  # not failed.
  defp launch_delivered(_status, {:error, :poller_busy}), do: nil
  defp launch_delivered(status, _result), do: status < 300

  # The receipt decides a message delivery's outcome, whichever daemon rendered
  # the owner's answer.
  defp relay({:forwarded, status, body}) do
    case Jason.decode(body) do
      {:ok, %{"delivery" => "message", "receipt" => %{"status" => _} = receipt} = payload} ->
        reply({:message, status, receipt}, payload["fiber_id"])

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
