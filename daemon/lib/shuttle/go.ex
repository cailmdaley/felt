defmodule Shuttle.Go do
  @moduledoc """
  The one verb that moves Rex: `go` shows a fiber's live worker in the Mac's
  Rex app (`POST /api/v1/go`). It never starts a worker, and it touches neither
  the voice target nor a board.

  The request is owner-routed like `/transition`. The owner resolves the fiber
  (a tempered or discarded one is refused) and its live worker. A worker in
  the owner's Rex server has its window selected in the macOS app client
  attached to that server; the daemon the human asked then brings the Rex app
  forward. A tmux worker opens as today's viewer (`Shuttle.Opener.open/2`) on
  the daemon the human asked: an owner reached by a forward answers its
  session name instead, since only the asking daemon holds the display.

  The answer is `%{went: bool, place: "live" | "none"}`; `went: false` with
  place `none` means no live worker could be shown.
  """

  alias Shuttle.{Env, FiberDocuments, Lifecycle, OriginRouter, Poller, Remote, Terminal}
  alias Shuttle.Terminal.Rex

  @none %{went: false, place: "none"}
  @live %{went: true, place: "live"}

  @type answer :: %{
          required(:went) => boolean(),
          required(:place) => String.t(),
          optional(atom()) => term()
        }

  @doc """
  Go to `fiber_id`, owned by `origin`. With `forwarded: true` (an owner's leg
  of a hub's request) it selects without bringing the app forward and leaves a
  tmux worker's display to the hub.

  `{:ok, answer}`, `{:forwarded, status, body}` for an owner's refusal relayed
  verbatim, or `{:error, reason}` (`http_error/1`).
  """
  @spec go(String.t(), String.t() | nil, keyword()) ::
          {:ok, answer()} | {:forwarded, non_neg_integer(), String.t()} | {:error, term()}
  def go(fiber_id, origin, opts \\ []) do
    case OriginRouter.route(origin) do
      {:error, _} = error -> error
      :local -> here(fiber_id, not Keyword.get(opts, :forwarded, false))
      {:remote, %Remote{} = remote} -> there(remote, fiber_id)
    end
  end

  @doc "The HTTP status and words for a refused go."
  def http_error({:unknown_origin, origin}),
    do: {400, OriginRouter.unknown_origin_message(origin)}

  def http_error(:not_found), do: {404, "not_found"}

  def http_error({:closed, column}),
    do: {422, "the fiber is #{column}; there is nothing to go to"}

  def http_error({:forward_failed, name, reason}),
    do: {502, "forward to #{name} failed: #{inspect(reason)}"}

  def http_error({:absent, name}), do: {502, Shuttle.Opener.absent_message(name)}
  def http_error(reason) when is_binary(reason), do: {502, reason}
  def http_error(reason), do: {502, inspect(reason)}

  defp here(fiber_id, display?) do
    with {:ok, fiber} <- fiber(fiber_id) do
      worker = live_worker().(fiber["uid"] || fiber_id)

      case Lifecycle.column(fiber, worker != nil) do
        column when column in ["tempered", "discarded"] -> {:error, {:closed, column}}
        _ when worker == nil -> {:ok, @none}
        _ -> show(worker.session, display?)
      end
    end
  end

  defp fiber(fiber_id) do
    case FiberDocuments.get(fiber_id) do
      {:ok, %{fibers: [%{fiber: fiber} | _]}} -> {:ok, fiber}
      {:ok, %{fibers: []}} -> {:error, :not_found}
      {:error, reason} -> {:error, "could not read #{fiber_id}: #{inspect(reason)}"}
    end
  end

  defp show(name, display?) do
    runner = runner()

    case Terminal.locate_target(runner, name) do
      {Rex, binding} ->
        with {:ok, moved} <- Rex.select_binding(runner, binding),
             :ok <- if(moved and display?, do: Rex.activate_app(runner), else: :ok) do
          {:ok, if(moved, do: @live, else: @none)}
        end

      {Terminal.Tmux, _} when display? ->
        opened(opener().open(name, nil))

      {Terminal.Tmux, _} ->
        {:ok, Map.put(@none, :tmux_session, name)}

      nil ->
        {:ok, @none}
    end
  end

  defp there(remote, fiber_id) do
    case OriginRouter.forward(remote, "/api/v1/go", %{"fiber_id" => fiber_id, "forwarded" => true}) do
      {:forwarded, 200, body} ->
        case Jason.decode(body) do
          {:ok, %{"went" => true}} ->
            with :ok <- Rex.activate_app(runner()), do: {:ok, @live}

          {:ok, %{"tmux_session" => name}} when is_binary(name) ->
            opened(opener().open(name, remote.name))

          {:ok, %{"went" => false}} ->
            {:ok, @none}

          _ ->
            {:error, "#{remote.name} answered go without saying where it went"}
        end

      {:forwarded, _status, _body} = refused ->
        refused

      {:error, _} = error ->
        error
    end
  end

  defp opened(:ok), do: {:ok, @live}
  defp opened({:error, {:absent, _}}), do: {:ok, @none}
  defp opened({:error, _} = error), do: error

  defp live_worker, do: Env.app(:go_live_worker, &Poller.live_worker/1)
  defp opener, do: Env.app(:opener_impl, Shuttle.Opener)
  defp runner, do: Env.app(:rex_runner, Shuttle.Runner.Default)
end
