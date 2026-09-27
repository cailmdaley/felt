defmodule Shuttle.Delivery do
  @moduledoc """
  Puts a message in front of a fiber's worker on this host.

  A live worker receives it through session messaging (`Shuttle.Messaging`),
  woken as for any task request. A fiber with no live worker launches with the
  message as its From User: it resumes its previous conversation when it has
  one and dispatches fresh when it has never run.
  """

  alias Shuttle.{Messaging, Poller}

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
    result =
      case dispatch(fiber_id, text, "previous") do
        {:error, :missing_session_id} -> {"fresh", dispatch(fiber_id, text, "fresh")}
        result -> {"previous", result}
      end

    # A worker that appeared between the look and the launch takes the message.
    with {_mode, {:error, :already_running}} <- result,
         worker when is_map(worker) <- Poller.live_worker(fiber_id) do
      message(worker, text, from)
    else
      _ ->
        {mode, result} = result
        {:launch, mode, result}
    end
  end

  # The dispatcher reads the fiber itself, so it alone decides whether there is
  # a conversation to resume.
  defp dispatch(fiber_id, text, mode) do
    Poller.dispatch_fiber(fiber_id,
      force: true,
      ad_hoc: true,
      user_message: text,
      resume_mode: mode
    )
  end

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

  defp harness(cli) when cli in ["claude", "codex", "pi"], do: cli
  defp harness(_), do: nil

  defp message_id,
    do: "deliver-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
end
