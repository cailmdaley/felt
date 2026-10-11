defmodule ShuttleWeb.MeetingAudioRelaySocket do
  @moduledoc """
  One-hop recorder WebSocket relay. Both legs belong to this process. Sends
  are synchronous and time-bounded; remote reads use active-once and frames
  are size-bounded. Overload closes the stream rather than replaying audio.
  Recorder status frames and close details pass through unchanged.
  """
  @behaviour WebSock
  alias Shuttle.MeetingAudioRelay.Client
  @max_queue 32

  @impl true
  def init(opts) do
    case Client.connect(Keyword.fetch!(opts, :url), Keyword.get(opts, :connect_timeout, 5_000)) do
      {:ok, client} -> deliver(client, <<>>)
      {:error, _} -> {:stop, :normal, {4500, "recorder connection failed"}, %{client: nil}}
    end
  end

  @impl true
  def handle_in({payload, opcode: opcode}, %{client: client} = state)
      when opcode in [:binary, :text] do
    with {:message_queue_len, n} when n <= @max_queue <- Process.info(self(), :message_queue_len),
         :ok <- Client.send_frame(client, opcode, payload) do
      {:ok, state}
    else
      _ -> failed(state)
    end
  end

  @impl true
  def handle_info({kind, socket, data}, %{client: %{socket: socket} = client})
      when kind in [:tcp, :ssl],
      do: deliver(client, data)

  def handle_info({kind, socket}, %{client: %{socket: socket}} = state)
      when kind in [:tcp_closed, :ssl_closed],
      do: failed(state)

  def handle_info({kind, socket, _}, %{client: %{socket: socket}} = state)
      when kind in [:tcp_error, :ssl_error],
      do: failed(state)

  def handle_info(_, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{client: nil}), do: :ok

  def terminate(_reason, %{client: client}) do
    # WebSock reports browser close as :remote, without wire code/reason.
    # Always release the recorder, including abnormal browser disconnects.
    Client.send_frame(client, :close, <<1000::16>>)
    Client.close(client)
    :ok
  end

  defp deliver(client, data) do
    case Client.consume(client, data) do
      {:ok, frames, client} -> forward(frames, client, [])
      {:error, _} -> failed(%{client: client})
    end
  end

  defp forward([], client, acc) do
    case Client.active_once(client) do
      :ok ->
        if acc == [],
          do: {:ok, %{client: client}},
          else: {:push, Enum.reverse(acc), %{client: client}}

      _ ->
        failed(%{client: client})
    end
  end

  defp forward([{:close, code, reason} | _], client, acc) do
    Client.send_frame(client, :close, <<code::16, reason::binary>>)
    Client.close(client)
    {:stop, :normal, {code, reason}, Enum.reverse(acc), %{client: nil}}
  end

  defp forward([{:ping, body} | rest], client, acc) do
    case Client.send_frame(client, :pong, body) do
      :ok -> forward(rest, client, acc)
      _ -> failed(%{client: client})
    end
  end

  defp forward([{:pong, _} | rest], client, acc), do: forward(rest, client, acc)
  defp forward([frame | rest], client, acc), do: forward(rest, client, [frame | acc])
  defp failed(state), do: {:stop, :normal, {4500, "recorder connection lost"}, state}
end
