import Config

hostname =
  case :inet.gethostname() do
    {:ok, name} -> to_string(name)
    _ -> ""
  end

remotes =
  if hostname in ["dapmcw68"] do
    [
      %{
        name: "candide",
        url: "http://127.0.0.1:4001",
        poll_interval_ms: 5000,
        request_timeout_ms: 8000
      },
      %{
        name: "cineca",
        url: "http://127.0.0.1:4002",
        poll_interval_ms: 5000,
        request_timeout_ms: 8000
      },
      %{
        name: "amundsen",
        url: "http://127.0.0.1:4003",
        poll_interval_ms: 5000,
        request_timeout_ms: 8000
      }
    ]
  else
    []
  end

config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  check_origin: false,
  code_reloader: false,
  # Required for the escript daemon to actually bind the TCP port.
  # Phoenix won't start the HTTP server without this explicit flag.
  server: true,
  secret_key_base: "shuttlelocaldevkeybaseshuttlelocaldevkeybaseshuttlelocaldevkeybase"

# Remote Shuttle daemons reachable over local SSH LocalForwards.
# See ~/.ssh/config — candide -> :4001, cineca -> :4002, amundsen -> :4003.
# Tunnel ports are owned by `felt shuttle tunnels` (defaultTunnelSpecs). Only the
# laptop daemon aggregates remotes; remote daemons should not try to
# recover themselves through their own LocalForward map.
config :shuttle, remotes: remotes
