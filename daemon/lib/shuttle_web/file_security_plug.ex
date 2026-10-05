defmodule ShuttleWeb.FileSecurityPlug do
  @moduledoc """
  Sandbox every file and report-asset response, independent of extension,
  content type, status, or owner. Wraps the endpoint before Phoenix's error
  boundary so parser exceptions and halted gates carry the same policy as file
  bytes. Other API routes are unchanged.

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
  def call(%{path_info: ["api", "v1", route | _]} = conn, _opts)
      when route in ["file", "file-assets"] do
    register_before_send(conn, fn conn ->
      conn
      |> put_resp_header("content-security-policy", @sandbox_policy)
      |> put_resp_header("x-content-type-options", "nosniff")
    end)
  end

  def call(conn, _opts), do: conn
end
