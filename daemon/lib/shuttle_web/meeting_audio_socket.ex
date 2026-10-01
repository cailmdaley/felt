defmodule ShuttleWeb.MeetingAudioSocket do
  @moduledoc """
  Relays a phone's microphone into the live `phone` meeting.

  The browser sends binary frames of s16le 16 kHz mono PCM; this process
  writes them unchanged into hark's Unix socket (`Shuttle.Meeting.phone_socket/1`).
  hark binds that socket only once its models load, so until a connect
  succeeds the audio is buffered (the most recent `buffer_bytes`, about a
  minute) and a connect is retried every `retry_ms`; the buffer is flushed
  first once connected, so what was said while hark loaded still reaches it.

  The page learns what is happening from small JSON text frames:

    * `{"state":"waiting","reason":…}` — no socket to write to yet;
    * `{"state":"connected"}` — audio reaches hark;
    * `{"state":"refused","reason":…}` — there is no phone meeting to feed;
    * `{"state":"ended","reason":…}` — the meeting stopped or failed;
    * `{"state":"replaced","reason":…}` — hark took another sender.

  Each terminal state is followed by a close whose code names it (see
  `close_code/1`). hark keeps one sender: when it closes our socket while the
  phone meeting is still live, another sender replaced this one, and the relay
  closes rather than reconnecting, which would steal the socket back.
  """

  @behaviour WebSock

  require Logger

  @retry_ms 500
  # One minute of s16le at 16 kHz mono.
  @buffer_bytes 60 * 16_000 * 2
  @connect_timeout_ms 1_000
  @send_timeout_ms 5_000

  @close_codes %{refused: 4404, ended: 4410, replaced: 4409, failed: 4500}

  @doc "The WebSocket close code for a terminal relay state."
  @spec close_code(:refused | :ended | :replaced | :failed) :: pos_integer()
  def close_code(state), do: Map.fetch!(@close_codes, state)

  @impl WebSock
  def init(opts) do
    state = %{
      resolve: Keyword.get(opts, :resolve, &Shuttle.Meeting.phone_socket/0),
      retry_ms: Keyword.get(opts, :retry_ms, @retry_ms),
      buffer_bytes: Keyword.get(opts, :buffer_bytes, @buffer_bytes),
      socket: nil,
      buffer: :queue.new(),
      buffered: 0,
      dropped: 0,
      announced: nil
    }

    attempt(state)
  end

  @impl WebSock
  def handle_in({audio, opcode: :binary}, %{socket: nil} = state),
    do: {:ok, enqueue(state, audio)}

  def handle_in({audio, opcode: :binary}, %{socket: socket} = state) do
    case :gen_tcp.send(socket, audio) do
      :ok -> {:ok, state}
      {:error, _reason} -> hark_closed(state)
    end
  end

  def handle_in({_text, opcode: :text}, state), do: {:ok, state}

  @impl WebSock
  def handle_info(:retry, %{socket: nil} = state), do: attempt(state)
  def handle_info(:retry, state), do: {:ok, state}

  def handle_info({:tcp_closed, socket}, %{socket: socket} = state), do: hark_closed(state)

  def handle_info({:tcp_error, socket, _reason}, %{socket: socket} = state),
    do: hark_closed(state)

  # hark writes nothing back; drain anything it does and keep watching for close.
  def handle_info({:tcp, socket, _data}, %{socket: socket} = state) do
    :inet.setopts(socket, active: :once)
    {:ok, state}
  end

  def handle_info(_message, state), do: {:ok, state}

  @impl WebSock
  def terminate(_reason, %{socket: socket}) when not is_nil(socket) do
    :gen_tcp.close(socket)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp attempt(state) do
    case state.resolve.() do
      {:ok, path} ->
        case connect(path) do
          {:ok, socket} -> connected(%{state | socket: socket})
          {:error, _reason} -> wait(state, "hark is loading; holding the audio until it listens")
        end

      :pending ->
        wait(state, "hark is starting; holding the audio until it listens")

      {:error, :none} ->
        finish(state, :refused, "no meeting is recording")

      {:error, :not_phone} ->
        finish(state, :refused, "the live meeting records this machine's microphone, not a phone")

      {:error, :ended} ->
        finish(state, :ended, "the meeting has ended")

      {:error, {:failed, error}} ->
        finish(state, :ended, failure(error))

      {:error, reason} ->
        wait(state, "can't read the meeting yet: #{inspect(reason)}")
    end
  end

  defp connect(path) do
    :gen_tcp.connect(
      {:local, path},
      0,
      [
        :binary,
        active: :once,
        send_timeout: @send_timeout_ms,
        send_timeout_close: true
      ],
      @connect_timeout_ms
    )
  end

  defp connected(state) do
    case flush(state) do
      {:ok, state} ->
        dropped = state.dropped
        state = %{state | dropped: 0, announced: :connected}

        status =
          if dropped > 0,
            do: %{state: "connected", dropped_bytes: dropped},
            else: %{state: "connected"}

        {:push, [frame(status)], state}

      {:error, state} ->
        hark_closed(state)
    end
  end

  defp flush(state) do
    result =
      Enum.reduce_while(:queue.to_list(state.buffer), :ok, fn audio, :ok ->
        case :gen_tcp.send(state.socket, audio) do
          :ok -> {:cont, :ok}
          {:error, _reason} -> {:halt, :error}
        end
      end)

    state = %{state | buffer: :queue.new(), buffered: 0}
    if result == :ok, do: {:ok, state}, else: {:error, state}
  end

  defp wait(state, reason) do
    Process.send_after(self(), :retry, state.retry_ms)

    if state.announced == :waiting do
      {:ok, state}
    else
      {:push, [frame(%{state: "waiting", reason: reason})], %{state | announced: :waiting}}
    end
  end

  # hark closed our socket. A meeting that is still a live phone meeting took
  # another sender; anything else means it ended.
  defp hark_closed(state) do
    :gen_tcp.close(state.socket)
    state = %{state | socket: nil}

    case state.resolve.() do
      {:ok, _path} ->
        finish(state, :replaced, "another device is now the meeting's microphone")

      {:error, {:failed, error}} ->
        finish(state, :ended, failure(error))

      _ended_or_unknown ->
        finish(state, :ended, "the meeting has ended")
    end
  end

  defp finish(state, kind, reason) do
    {:stop, :normal, {close_code(kind), reason},
     [frame(%{state: Atom.to_string(kind), reason: reason})], state}
  end

  defp failure(error) when is_binary(error) and error != "", do: "the meeting failed: #{error}"
  defp failure(_error), do: "the meeting failed"

  # Keep the newest audio: once the buffer is full, drop the oldest frames.
  defp enqueue(state, audio) do
    state = %{
      state
      | buffer: :queue.in(audio, state.buffer),
        buffered: state.buffered + byte_size(audio)
    }

    trim(state)
  end

  defp trim(%{buffered: buffered, buffer_bytes: limit} = state) when buffered <= limit, do: state

  defp trim(state) do
    {{:value, oldest}, buffer} = :queue.out(state.buffer)
    size = byte_size(oldest)

    trim(%{
      state
      | buffer: buffer,
        buffered: state.buffered - size,
        dropped: state.dropped + size
    })
  end

  defp frame(map), do: {:text, Jason.encode!(map)}
end
