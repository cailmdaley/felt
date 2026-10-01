defmodule ShuttleWeb.MeetingAudioSocket do
  @moduledoc """
  Relays a phone's microphone into the live `phone` meeting.

  The browser sends binary frames of s16le 16 kHz mono PCM; this process
  writes them unchanged into hark's Unix socket (`Shuttle.Meeting.phone_socket/1`).
  Nothing is buffered. hark places phone audio on its own wall clock and pads
  any gap with silence, so audio replayed late would be counted twice and
  shift every later timestamp. Until hark's socket accepts a connection (it
  binds once its models load), frames are discarded and a connect is retried
  every `retry_ms`.

  The socket is bound to one meeting: the page passes that meeting's launch id
  (`launch`), and a different meeting is refused or, mid-stream, ends this
  socket, so a reconnect never lands in another meeting. Without a `launch`,
  any live phone meeting is fed.

  The page learns what is happening from small JSON text frames:

    * `{"state":"waiting","reason":…}` — no hark socket yet; audio is dropped;
    * `{"state":"connected"}` — audio reaches hark;
    * `{"state":"refused","reason":…}` — there is no phone meeting to feed;
    * `{"state":"ended","reason":…}` — the meeting stopped or failed;
    * `{"state":"replaced","reason":…}` — hark took another sender.

  Each terminal state is followed by a close whose code names it (see
  `close_code/1`) and whose reason is the frame's, cut to the 123 bytes a close
  frame holds. hark keeps one sender: when it closes our socket while the same
  meeting is still live, another sender replaced this one, and the relay
  closes rather than reconnecting, which would steal the socket back.
  """

  @behaviour WebSock

  @retry_ms 500
  @connect_timeout_ms 1_000
  @send_timeout_ms 5_000
  # RFC 6455: a close frame's payload is at most 125 bytes, two of them the code.
  @close_reason_bytes 123

  @close_codes %{refused: 4404, ended: 4410, replaced: 4409, failed: 4500}

  @doc "The WebSocket close code for a terminal relay state."
  @spec close_code(:refused | :ended | :replaced | :failed) :: pos_integer()
  def close_code(state), do: Map.fetch!(@close_codes, state)

  @doc "`reason` cut to at most `bytes` bytes without splitting a character."
  @spec truncate_utf8(String.t(), non_neg_integer()) :: String.t()
  def truncate_utf8(reason, bytes \\ @close_reason_bytes) do
    if byte_size(reason) <= bytes do
      reason
    else
      reason
      |> String.codepoints()
      |> Enum.reduce_while({"", 0}, fn codepoint, {acc, size} ->
        size = size + byte_size(codepoint)
        if size <= bytes, do: {:cont, {acc <> codepoint, size}}, else: {:halt, {acc, size}}
      end)
      |> elem(0)
    end
  end

  @impl WebSock
  def init(opts) do
    state = %{
      resolve: Keyword.get(opts, :resolve, &Shuttle.Meeting.phone_socket/0),
      retry_ms: Keyword.get(opts, :retry_ms, @retry_ms),
      launch: blank_to_nil(Keyword.get(opts, :launch)),
      socket: nil,
      announced: nil
    }

    attempt(state)
  end

  @impl WebSock
  def handle_in({_audio, opcode: :binary}, %{socket: nil} = state), do: {:ok, state}

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
      {:ok, %{launch: launch}} when not is_nil(state.launch) and launch != state.launch ->
        finish(state, :refused, "a different meeting is recording now")

      {:ok, %{path: path}} ->
        case connect(path) do
          {:ok, socket} ->
            {:push, [frame(%{state: "connected"})],
             %{state | socket: socket, announced: :connected}}

          {:error, _reason} ->
            wait(state, "hark is loading its models")
        end

      :pending ->
        wait(state, "hark is starting")

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

  defp wait(state, reason) do
    Process.send_after(self(), :retry, state.retry_ms)

    if state.announced == :waiting do
      {:ok, state}
    else
      {:push, [frame(%{state: "waiting", reason: reason})], %{state | announced: :waiting}}
    end
  end

  # hark closed our socket. The same meeting, still a live phone meeting, took
  # another sender; anything else means this meeting ended.
  defp hark_closed(state) do
    :gen_tcp.close(state.socket)
    state = %{state | socket: nil}

    case state.resolve.() do
      {:ok, %{launch: launch}} when is_nil(state.launch) or launch == state.launch ->
        finish(state, :replaced, "another device is now the meeting's microphone")

      {:error, {:failed, error}} ->
        finish(state, :ended, failure(error))

      _ended_other_or_unknown ->
        finish(state, :ended, "the meeting has ended")
    end
  end

  defp finish(state, kind, reason) do
    {:stop, :normal, {close_code(kind), truncate_utf8(reason)},
     [frame(%{state: Atom.to_string(kind), reason: reason})], state}
  end

  defp failure(error) when is_binary(error) and error != "", do: "the meeting failed: #{error}"
  defp failure(_error), do: "the meeting failed"

  defp blank_to_nil(value) when is_binary(value) and value != "", do: value
  defp blank_to_nil(_value), do: nil

  defp frame(map), do: {:text, Jason.encode!(map)}
end
