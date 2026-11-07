defmodule Shuttle.Voice.Config do
  @moduledoc "Persistent Listen settings, shared with hark through --settings."

  @defaults %{
    "enabled" => false,
    "follow" => true,
    "system_audio" => false,
    "words" => 200,
    "quiet_seconds" => 15,
    "pinned_quiet_seconds" => 120
  }

  def path do
    case Shuttle.Env.get("SHUTTLE_VOICE_FILE") do
      value when is_binary(value) and value != "" -> Shuttle.Env.expand(value)
      _ -> Shuttle.Env.expand("~/.config/shuttle/voice.json")
    end
  end

  def read do
    case Shuttle.FS.read(path()) do
      {:error, :enoent} ->
        {:ok, @defaults}

      {:ok, bytes} ->
        with {:ok, config} <- Jason.decode(bytes),
             :ok <- validate(config),
             do: {:ok, Map.merge(@defaults, Map.take(config, Map.keys(@defaults)))}

      {:error, reason} ->
        {:error, Shuttle.FS.format_error(reason)}
    end
  end

  def thresholds do
    config =
      case read() do
        {:ok, config} -> config
        {:error, _} -> @defaults
      end

    %{
      "words" => config["words"],
      "quiet_seconds" =>
        config[if(config["follow"], do: "quiet_seconds", else: "pinned_quiet_seconds")]
    }
  end

  def validate(config) when is_map(config) do
    cond do
      Enum.any?(
        ~w(enabled follow system_audio),
        &(Map.has_key?(config, &1) and not is_boolean(config[&1]))
      ) ->
        {:error, "enabled, follow and system_audio must be booleans"}

      not (is_integer(Map.get(config, "words", 200)) and Map.get(config, "words", 200) > 0) ->
        {:error, "words must be a positive integer"}

      Enum.any?(
        ~w(quiet_seconds pinned_quiet_seconds),
        &(Map.has_key?(config, &1) and not (is_number(config[&1]) and config[&1] > 0))
      ) ->
        {:error, "quiet_seconds and pinned_quiet_seconds must be positive"}

      true ->
        :ok
    end
  end

  def validate(_), do: {:error, "voice settings must be a JSON object"}

  def enable(enabled), do: update(%{"enabled" => enabled})

  def update(params) when map_size(params) == 0, do: :ok

  def update(params) do
    # Off remains available when the settings file cannot be decoded.
    config =
      case read() do
        {:ok, config} -> {:ok, config}
        {:error, _} = error -> if(params["enabled"] == false, do: {:ok, @defaults}, else: error)
      end

    with {:ok, config} <- config,
         config <- Map.merge(config, Map.take(params, Map.keys(@defaults))),
         :ok <- validate(config),
         {:ok, _} <- Shuttle.ConfigFiles.write(:voice, Jason.encode!(config)),
         do: :ok
  end
end
