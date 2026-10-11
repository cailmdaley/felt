defmodule Shuttle.MeetingAudioRelay do
  @moduledoc """
  Selects the recorder for an audio upgrade without silently falling back to
  another host. Forwarded upgrades carry a launch identity and admit one hop.
  """
  alias Shuttle.Remote

  def route(params, opts \\ []) do
    recorder = params["recorder"]

    cond do
      params["relay"] == "1" and (not is_binary(params["launch"]) or params["launch"] == "") ->
        {:error, :launch_required}

      params["relay"] == "1" and (not is_binary(recorder) or recorder == "") ->
        {:error, :wrong_recorder}

      true ->
        case Shuttle.OriginRouter.route_host(recorder, opts) do
          :local ->
            # route_host also accepts aliases/missing selectors; a forwarded
            # request must name this daemon, not one of those aliases.
            own = Keyword.get_lazy(opts, :own_host_id, &Shuttle.Poller.own_host_id/0)

            if params["relay"] == "1" and recorder != own,
              do: {:error, :wrong_recorder},
              else: {:local, params["launch"]}

          {:remote, remote} ->
            cond do
              params["relay"] == "1" ->
                {:error, :wrong_recorder}

              not is_binary(params["launch"]) or params["launch"] == "" ->
                {:error, :launch_required}

              true ->
                query =
                  URI.encode_query(%{
                    "recorder" => remote.name,
                    "launch" => params["launch"],
                    "relay" => "1"
                  })

                {:remote, Remote.url_for(remote, "/api/v1/meeting/audio") <> "?" <> query}
            end

          {:error, reason} ->
            {:error, reason}
        end
    end
  end
end
