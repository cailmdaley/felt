defmodule Shuttle.Messaging.Attestations do
  @moduledoc """
  Single-use evidence that this daemon verified a sender before forwarding its
  message to another host.

  A receiving daemon cannot check a sender proof minted on another host, so the
  forward arrives unverified with the sender as a claim. The receiver then asks
  the claimed sender's own host, over the route it already trusts for that host,
  whether it verified exactly this message: same id, sender, target session and
  content digest. A matching record is consumed on the first lookup, so a
  replayed forward cannot redeem it. Records live in memory for a few minutes:
  a forward is answered within one request timeout, and a daemon restart only
  leaves an in-flight message unverified.
  """

  use GenServer

  @ttl_ms 5 * 60_000
  @max_records 4_096

  @type record :: %{
          from: String.t(),
          harness: String.t(),
          native: String.t(),
          digest: String.t()
        }

  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @doc "Record that `record.from` was verified as the sender of `message_id`."
  @spec put(String.t(), record()) :: :ok
  def put(message_id, record) when is_binary(message_id),
    do: GenServer.call(__MODULE__, {:put, message_id, record})

  @doc "Consume a matching record. A mismatch leaves the record for its rightful lookup."
  @spec consume(String.t(), record()) :: boolean()
  def consume(message_id, record) when is_binary(message_id),
    do: GenServer.call(__MODULE__, {:consume, message_id, record})

  @doc "The digest both hosts compute over a message's content."
  @spec digest(String.t(), [map()]) :: String.t()
  def digest(text, attachments) do
    files = Enum.map(attachments, &Map.get(&1, "sha256"))

    :crypto.hash(:sha256, Jason.encode!([text, files]))
    |> Base.encode16(case: :lower)
  end

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_call({:put, id, record}, _from, records) do
    now = now()

    records =
      records
      |> Map.reject(fn {_id, {_record, at}} -> now - at > @ttl_ms end)
      |> Map.put(id, {record, now})
      |> cap()

    {:reply, :ok, records}
  end

  def handle_call({:consume, id, record}, _from, records) do
    case Map.get(records, id) do
      {^record, at} -> {:reply, now() - at <= @ttl_ms, Map.delete(records, id)}
      _ -> {:reply, false, records}
    end
  end

  defp cap(records) when map_size(records) <= @max_records, do: records

  defp cap(records) do
    records
    |> Enum.sort_by(fn {_id, {_record, at}} -> at end, :desc)
    |> Enum.take(@max_records)
    |> Map.new()
  end

  defp now, do: System.monotonic_time(:millisecond)
end
