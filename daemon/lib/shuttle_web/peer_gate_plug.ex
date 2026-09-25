defmodule ShuttleWeb.PeerGatePlug do
  @moduledoc """
  Refuses TCP peers on shared and exposed hosts unless `/proc` assigns them the
  daemon's expected uid or root.

  `PeerPlug` gathers transport and uid facts; this plug applies the admission
  policy separately, before static assets or request-body parsing. Unix
  connections rely on the socket directory's filesystem permissions. The
  Tailscale login header is retained on TCP only after the uid gate admits the
  connection.
  """

  @behaviour Plug

  import Plug.Conn
  require Logger

  @shared_classes [:shared_multi_user, :exposed]

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    peer = conn.assigns[:peer] || %{}
    host_class = Keyword.get(opts, :host_class, Shuttle.host_class())
    gate = Keyword.get(opts, :peer_gate, Application.get_env(:shuttle, :peer_gate, "none"))

    if peer.transport == :tcp and host_class in @shared_classes and gate == "uid" do
      admit_or_refuse(conn, peer, Keyword.get(opts, :expected_uid, expected_uid()))
    else
      conn
    end
  end

  defp admit_or_refuse(conn, %{uid: uid}, expected_uid)
       when is_integer(uid) and (uid == expected_uid or uid == 0) do
    login = conn |> get_req_header("tailscale-user-login") |> List.first()
    assign(conn, :peer, Map.put(conn.assigns.peer, :tailscale_login, blank_to_nil(login)))
  end

  defp admit_or_refuse(conn, %{uid: uid}, expected_uid) do
    reason = refusal_reason(uid, expected_uid)
    peer_data = get_peer_data(conn)

    Logger.warning("refused TCP peer #{format_peer(peer_data)}: #{reason}")

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(403, Jason.encode!(%{error: "peer_refused", reason: reason}))
    |> halt()
  end

  defp refusal_reason(uid, expected_uid) when is_integer(uid),
    do: "uid #{uid} is not the daemon's uid #{expected_uid}"

  defp refusal_reason(_uid, _expected_uid),
    do: "peer uid unresolved: no matching /proc TCP row"

  defp expected_uid do
    Application.get_env(:shuttle, :peer_gate_expected_uid)
  end

  defp blank_to_nil(""), do: nil
  defp blank_to_nil(value), do: value

  defp format_peer(%{address: address, port: port}) do
    "#{format_address(address)}:#{port}"
  end

  defp format_peer(_peer_data), do: "unknown"

  defp format_address(address) when is_tuple(address) do
    case :inet.ntoa(address) do
      {:error, _reason} -> inspect(address)
      text -> List.to_string(text)
    end
  end

  defp format_address(address), do: inspect(address)
end
