defmodule ShuttleWeb.DeliverController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/deliver

  Body `{fiber_id, text, from?, origin?}`. Puts `text` in front of the fiber's
  worker on its owning host (`Shuttle.Delivery`): a live worker is messaged, a
  dormant one resumes (or dispatches, if it never ran) with `text` as its From
  User. A request carrying `origin` is forwarded to that owner's identical
  route.

  The answer names what happened in `delivery`: `"message"` with the messaging
  `receipt`, or `"resume"` / `"dispatch"` with the `/dispatch` envelope.
  `delivered` is `true` when the worker has the text, `false` when it did not
  get it, and `null` (status 202) when the text was sent but its arrival is
  unconfirmed: a receipt of status `"unknown"`, or an owner that did not answer
  in time. `detail` then says what is known.
  """

  use Phoenix.Controller, formats: [:json]

  alias Shuttle.{Delivery, OriginRouter}

  def create(conn, params) do
    {status, body} =
      route(
        Map.get(params, "fiber_id"),
        Map.get(params, "text"),
        Map.get(params, "origin"),
        Map.get(params, "from")
      )

    conn |> put_status(status) |> json(body)
  end

  @doc "Deliver on the owning daemon, forwarding when `origin` names a remote."
  @spec route(term(), term(), String.t() | nil, term()) :: {pos_integer(), map()}
  def route(fiber_id, text, origin, from \\ nil) do
    cond do
      not (is_binary(fiber_id) and String.trim(fiber_id) != "") ->
        {400, %{delivered: false, error: "fiber_id is required"}}

      not (is_binary(text) and String.trim(text) != "") ->
        {400, %{delivered: false, error: "text is required"}}

      true ->
        case OriginRouter.route(origin) do
          {:remote, remote} ->
            payload =
              %{"fiber_id" => fiber_id, "text" => text}
              |> then(&if(is_binary(from), do: Map.put(&1, "from", from), else: &1))

            remote |> OriginRouter.forward("/api/v1/deliver", payload) |> relay()

          :local ->
            opts = if is_binary(from) and from != "", do: [from: from], else: []
            fiber_id |> Delivery.deliver(text, opts) |> reply(fiber_id)
        end
    end
  end

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
    {status, Map.merge(body, %{delivered: status < 300, delivery: delivery})}
  end

  defp reply({:error, status, error}, fiber_id),
    do: {status, %{delivered: false, delivery: "message", fiber_id: fiber_id, error: error}}

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
