defmodule Shuttle.InboxRecord do
  @moduledoc """
  Records and deduplicates the lines the daemon transports itself: the human's
  typed or spoken lines (terminal input or a From User launch prompt), pulse
  ticks and an agent's fresh session request. The record lives in the fiber
  inbox's `offered/`, so no worker is ever offered it; its id makes a
  retried submission a no-op that answers what became of the first.
  """

  @doc """
  Records `text` from `from` under `message_id` (minted when nil), then runs
  `deliver` with the fiber's entry and settles the record by its result:
  delivered on `{:ok, _}`, unknown when the transport may have happened,
  undeliverable on a definite refusal, which lets a non-voice id be sent again.
  Voice ids are never re-pasted. `record_only` imports an unknown record without
  delivering it. A repeated id answers `{:duplicate, id, disposition}`.
  """
  def submit(fiber_id, text, message_id, from, deliver, opts \\ []) do
    id =
      message_id || "human-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

    with {:ok, %{fibers: [entry | _]}} <- document(fiber_id, opts) do
      record(
        Shuttle.Delivery.context_key(entry),
        text,
        id,
        from,
        fn -> deliver.(entry) end,
        opts,
        board(from, entry)
      )
    else
      error -> {:error, {:inbox_record, error}}
    end
  end

  # A remote voice handoff must also be at-most-once when its owner predates
  # voice records. These offered records hold no board row or pending queue.
  def forward_voice(text, id, deliver) do
    record("voice-forwards", text, id, "human", deliver, [source: "voice"], [])
  end

  defp record(key, text, id, from, deliver, opts, board) do
    with {:ok, output} <-
           Shuttle.CLI.run(
             ["inbox", "record-begin", "--from", from] ++
               source(opts) ++ board ++ ["--", key, id],
             input: text,
             input_eof: true
           ),
         {:ok, answer} <- Jason.decode(output) do
      record_only = opts[:record_only] == true

      case answer do
        %{"created" => false} ->
          {:duplicate, id, answer["disposition"] || "unknown"}

        %{"created" => true} when record_only ->
          {:duplicate, id, "unknown"}

        %{"created" => true} ->
          result = deliver.()

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
      error ->
        require Logger
        Logger.warning("Inbox record #{id}: #{inspect(error)}")
        {:error, {:inbox_record, error}}
    end
  end

  defp document(fiber_id, opts) do
    case opts[:entry] do
      nil -> Shuttle.FiberDocuments.get_shuttle(fiber_id)
      entry -> {:ok, %{fibers: [entry]}}
    end
  end

  defp source(opts) do
    if opts[:source], do: ["--source", opts[:source]], else: []
  end

  # A human line's record and prompt hook share one family-board row: answered
  # when the fiber has a question, otherwise human.
  defp board("human", entry) do
    ask = get_in(entry.fiber, ["shuttle", "ask", "text"])
    uid = entry.fiber["uid"] || entry.fiber["id"]
    ["--fiber", uid] ++ if(is_binary(ask) and ask != "", do: ["--ask", ask], else: [])
  end

  defp board(_from, _entry), do: []

  defp outcome({status, body}) when is_integer(status) do
    case Map.get(body, :delivered, body["delivered"]) do
      true -> "delivered"
      false -> "undeliverable"
      nil -> "unknown"
    end
  end

  defp outcome({:ok, status, receipt}) do
    cond do
      status < 300 and receipt["status"] in ["accepted", "submitted", "queued"] -> "delivered"
      receipt["status"] == "rejected" -> "undeliverable"
      true -> "unknown"
    end
  end

  defp outcome({:error, _status, _reason}), do: "undeliverable"
  defp outcome({:ok, _}), do: "delivered"
  defp outcome({:error, {:paste_failed, {:unknown, _}}}), do: "unknown"
  defp outcome({:error, :poller_busy}), do: "unknown"
  defp outcome({:error, _}), do: "undeliverable"
end
