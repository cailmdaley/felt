defmodule Shuttle.InboxRecord do
  @moduledoc """
  Records and deduplicates the lines the daemon transports itself: the human's
  typed lines (terminal input or a From User launch prompt) and an agent's
  fresh session request (a launch prompt). The record lives in the fiber
  inbox's `offered/`, so no worker is ever offered it; its id makes a
  retried submission a no-op that answers what became of the first.
  """

  @doc """
  Records `text` from `from` under `message_id` (minted when nil), then runs
  `deliver` with the fiber's entry and settles the record by its result:
  delivered on `{:ok, _}`, unknown when the transport may have happened,
  undeliverable on any other error, which lets the same id be sent again. A
  repeated id answers `{:duplicate, id, disposition}` and delivers nothing.
  """
  def submit(fiber_id, text, message_id, from, deliver) do
    id =
      message_id || "human-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

    with {:ok, %{fibers: [entry | _]}} <- Shuttle.FiberDocuments.get_shuttle(fiber_id),
         key = Shuttle.Delivery.context_key(entry),
         {:ok, output} <-
           Shuttle.CLI.run(
             ["inbox", "record-begin", "--from", from] ++ board(from, entry) ++ ["--", key, id],
             input: text,
             input_eof: true
           ),
         {:ok, answer} <- Jason.decode(output) do
      case answer do
        %{"created" => false} ->
          {:duplicate, id, answer["disposition"] || "unknown"}

        %{"created" => true} ->
          result = deliver.(entry)

          case Shuttle.CLI.run(["inbox", "record-settle", "--", key, id, outcome(result)]) do
            {:ok, _} ->
              :ok

            error ->
              require Logger
              Logger.warning("Settling inbox record #{id}: #{inspect(error)}")
          end

          result
      end
    else
      error -> {:error, {:inbox_record, error}}
    end
  end

  # A human line has one family-board row, written with its record under its
  # id: "answered" when it answers the fiber's question, else "human". The
  # worker's prompt hook, when the line is typed into its session, writes its
  # row under the same id.
  defp board("human", entry) do
    ask = get_in(entry.fiber, ["shuttle", "ask", "text"])
    uid = entry.fiber["uid"] || entry.fiber["id"]
    ["--fiber", uid] ++ if(is_binary(ask) and ask != "", do: ["--ask", ask], else: [])
  end

  defp board(_from, _entry), do: []

  defp outcome({:ok, _}), do: "delivered"
  defp outcome({:error, {:paste_failed, {:unknown, _}}}), do: "unknown"
  defp outcome({:error, :poller_busy}), do: "unknown"
  defp outcome({:error, _}), do: "undeliverable"
end
