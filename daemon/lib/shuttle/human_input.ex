defmodule Shuttle.HumanInput do
  @moduledoc "Records and deduplicates the human's typed lines; the terminal or launch prompt transports them."

  def submit(fiber_id, text, message_id, deliver) do
    id =
      message_id || "human-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

    with {:ok, %{fibers: [entry | _]}} <- Shuttle.FiberDocuments.get_shuttle(fiber_id),
         key = Shuttle.Delivery.context_key(entry),
         {:ok, output} <- Shuttle.CLI.run(["inbox", "human-begin", key, id, text]),
         {:ok, answer} <- Jason.decode(output) do
      case answer do
        %{"created" => false} ->
          {:duplicate, id}

        %{"created" => true} ->
          result = deliver.()
          outcome = outcome(result)

          case Shuttle.CLI.run(["inbox", "human-settle", key, id, outcome]) do
            {:ok, _} ->
              :ok

            error ->
              require Logger
              Logger.warning("Settling human input #{id}: #{inspect(error)}")
          end

          result
      end
    else
      error -> {:error, {:human_inbox, error}}
    end
  end

  defp outcome({:ok, _}), do: "delivered"
  defp outcome({:error, {:paste_failed, _}}), do: "unknown"
  defp outcome({:error, :poller_busy}), do: "unknown"
  defp outcome({:error, _}), do: "undeliverable"
end
