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
    delivered = status < 300 and receipt["status"] not in ["rejected", "unknown"]

    body = %{delivered: delivered, delivery: "message", fiber_id: fiber_id, receipt: receipt}

    if delivered,
      do: {status, body},
      else:
        {if(status < 300, do: 502, else: status),
         Map.put(body, :error, receipt["detail"] || "the worker did not accept the message")}
  end

  defp reply({:launch, mode, result}, fiber_id) do
    {status, body} = ShuttleWeb.DispatchReply.render(fiber_id, result)
    delivery = if mode == "previous", do: "resume", else: "dispatch"
    {status, Map.merge(body, %{delivered: status < 300, delivery: delivery})}
  end

  defp reply({:error, status, error}, fiber_id),
    do: {status, %{delivered: false, delivery: "message", fiber_id: fiber_id, error: error}}

  defp relay({:forwarded, status, body}) do
    case Jason.decode(body) do
      {:ok, payload} when is_map(payload) -> {status, payload}
      _ -> {502, %{delivered: false, error: "the owning daemon answered: #{body}"}}
    end
  end

  defp relay({:error, {:forward_failed, name, reason}}) do
    {502, %{delivered: false, reason: "forward_failed", origin: name, error: inspect(reason)}}
  end
end
