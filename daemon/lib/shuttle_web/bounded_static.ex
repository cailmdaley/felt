defmodule ShuttleWeb.BoundedStatic do
  @moduledoc """
  Plug.Static's negotiation and cache semantics with leased metadata work and
  bounded file delivery. Its raw stat calls run off the socket owner; a capture
  adapter defers actual sends to that owner without opening files there.
  """
  @behaviour Plug
  alias Shuttle.FileAccess
  alias ShuttleWeb.BoundedFileSender
  alias ShuttleWeb.BoundedStatic.Capture

  def init(options), do: Plug.Static.init(options)

  def call(%Plug.Conn{method: method} = conn, options) when method in ["GET", "HEAD"] do
    if candidate?(conn.path_info, options.only_rules), do: serve(conn, options), else: conn
  rescue
    error in FileAccess.Error -> conn |> BoundedFileSender.unavailable(error) |> Plug.Conn.halt()
  end

  def call(conn, _options), do: conn

  defp serve(conn, options) do
    root = root(options.from)

    captured =
      FileAccess.task(root, fn ->
        probe(root, conn, options)

        Plug.Static.call(
          %{
            conn
            | adapter: {Capture, nil},
              owner: nil,
              private: Map.delete(conn.private, :before_send)
          },
          options
        )
      end)

    captured = %{
      captured
      | owner: conn.owner,
        private: Map.put(captured.private, :before_send, conn.private[:before_send] || [])
    }

    case captured.adapter do
      {Capture, nil} ->
        %{captured | adapter: conn.adapter}

      {Capture, {:response, status, headers, body}} ->
        %{captured | adapter: conn.adapter, state: :set, resp_headers: headers}
        |> Plug.Conn.send_resp(status, body)

      {Capture, {:file, status, headers, path, offset, length}} ->
        length = if length == :all, do: file_size!(path) - offset, else: length
        captured = %{captured | adapter: conn.adapter, state: :set, resp_headers: headers}
        BoundedFileSender.send_file(captured, status, path, offset, length)
    end
  end

  defp candidate?([first | _], {only, matching, _}) do
    (only == [] and matching == []) or first in only or
      Enum.any?(matching, &String.starts_with?(first, &1))
  end

  defp candidate?([], _rules), do: false

  # A typed preflight also resolves protected symlink targets. Plug.Static
  # deliberately treats stat failures as a miss; permission failures here are
  # unavailable dependencies rather than nonexistent assets.
  defp probe(root, conn, options) do
    decoded = Enum.map(conn.path_info, &URI.decode/1)

    if Enum.all?(
         decoded,
         &(&1 not in ["", ".", ".."] and not String.contains?(&1, ["/", "\\", ":", <<0>>]))
       ) do
      path = Path.join([root | decoded])

      encodings =
        if Plug.Conn.get_req_header(conn, "range") == [], do: options.encodings, else: []

      extensions =
        for {encoding, ext} <- encodings,
            Enum.any?(
              Plug.Conn.get_req_header(conn, "accept-encoding"),
              &String.contains?(&1, [encoding, "*"])
            ),
            do: ext

      Enum.find_value(extensions ++ [""], fn ext ->
        match?({:ok, %{type: :regular}}, FileAccess.stat(path <> ext))
      end)
    end

    :ok
  end

  defp file_size!(path) do
    case FileAccess.stat(path) do
      {:ok, stat} -> stat.size
      {:error, reason} -> raise File.Error, reason: reason, action: "stat", path: path
    end
  end

  defp root({module, function, args}) when is_list(args), do: apply(module, function, args)
  defp root({app, path}), do: Path.join(Application.app_dir(app), path)
  defp root(path), do: path

  defmodule Capture do
    @moduledoc false
    def send_file(_payload, status, headers, path, offset, length),
      do: {:ok, nil, {:file, status, headers, path, offset, length}}

    def send_resp(_payload, status, headers, body),
      do: {:ok, body, {:response, status, headers, body}}
  end
end
