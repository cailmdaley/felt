defmodule ShuttleWeb.FileSecurityPlug do
  @moduledoc """
  Sandbox every API response, independent of route, extension, content type,
  status, or owner. The API serves no top-level page, so the policy is
  default-deny: any request whose percent-decoded first path segment is `api`,
  or whose path does not decode, gets the CSP sandbox and `nosniff`. Matching
  decoded segments is what the router itself does, so no spelling of a file
  route reaches its controller unsandboxed. Wraps the endpoint before Phoenix's
  error boundary so parser exceptions and halted gates carry the same policy as
  file bytes. The SPA routes outside `/api` are unchanged.

  The serving hub owns this policy; relayed owner headers cannot weaken it.
  """

  @behaviour Plug

  import Plug.Conn

  @sandbox_policy "sandbox allow-scripts allow-popups " <>
                    "allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms"

  # Phoenix renders unwrapped parser failures from the conn passed into its
  # call/2, not the conn returned by earlier pipeline plugs. Register outside
  # that boundary so error rendering retains the before-send callback.
  defmacro __before_compile__(_env) do
    quote do
      defoverridable call: 2

      def call(conn, opts) do
        conn = ShuttleWeb.FileSecurityPlug.call(conn, [])
        super(conn, opts)
      end
    end
  end

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    if api_path?(conn.path_info) do
      register_before_send(conn, fn conn ->
        conn
        |> put_resp_header("content-security-policy", @sandbox_policy)
        |> put_resp_header("x-content-type-options", "nosniff")
      end)
    else
      conn
    end
  end

  defp api_path?([]), do: false

  defp api_path?([first | _]) do
    URI.decode(first) == "api"
  rescue
    ArgumentError -> true
  end
end
