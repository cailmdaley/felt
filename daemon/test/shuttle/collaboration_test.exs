defmodule Shuttle.CollaborationTest do
  use ExUnit.Case, async: true

  alias Shuttle.Collaboration

  @collaborator "01KTS261GJMMRDRHS2QDMEFV3K"
  @role "01KTS261GJMMRDRHS2QDMEFV3M"

  test "accepts UID-only references and keeps optional origins as metadata" do
    assert {:ok,
            %{
              "collaborator" => %{"uid" => @collaborator},
              "role" => %{"uid" => @role, "origin" => "old-host"}
            }} =
             Collaboration.parse(%{
               "collaborator" => %{"uid" => @collaborator},
               "role" => %{"uid" => @role, "origin" => "old-host"}
             })

    assert {:ok, %{"role" => %{"uid" => @role, "origin" => ""}}} =
             Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => ""}})
  end

  test "rejects empty, unknown, and malformed collaboration references" do
    assert {:ok, nil} = Collaboration.parse(nil)
    assert {:error, _} = Collaboration.parse(%{})
    assert {:error, _} = Collaboration.parse(%{"extra" => %{}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "extra" => "x"}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => 7}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "local"}})
    assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => @role, "origin" => "Host-A"}})

    for uid <- ["not-a-ulid", String.duplicate("0", 25), "81KTS261GJMMRDRHS2QDMEFV3M"] do
      assert {:error, _} = Collaboration.parse(%{"role" => %{"uid" => uid}})
    end
  end

  test "normalizes many valid UIDs independently of legacy origins" do
    state = :rand.seed_s(:exsss, {14, 29, 2026})

    {cases, _state} =
      Enum.reduce(1..128, {[], state}, fn index, {cases, state} ->
        {first, state} = :rand.uniform_s(8, state)
        {tail, state} = random_ulid_tail(state)
        uid = Integer.to_string(first - 1) <> tail
        origin = if rem(index, 2) == 0, do: "host-#{index}", else: ""
        {[{uid, origin} | cases], state}
      end)

    assert 128 = length(cases)

    Enum.each(cases, fn {uid, origin} ->
      assert {:ok, %{"role" => %{"uid" => ^uid}}} =
               Collaboration.parse(%{"role" => %{"uid" => uid, "origin" => origin}})
    end)
  end

  test "prompt resolves references from the local shared store and ignores origins" do
    prompt =
      Collaboration.prompt_section(
        {:ok,
         %{
           "collaborator" => %{"uid" => @collaborator},
           "role" => %{"uid" => @role, "origin" => "stale-host"}
         }},
        "/tmp/shared loom"
      )

    assert prompt =~ "collaborator: felt -C '/tmp/shared loom' show #{@collaborator}"
    assert prompt =~ "role: felt -C '/tmp/shared loom' show #{@role}"
    assert prompt =~ "Optional origin metadata does not change this local-store lookup"
    refute prompt =~ "stale-host"
    refute prompt =~ "response.host"
    refute prompt =~ "/api/v1/fibers"
  end

  test "malformed document metadata remains visible in the worker prompt" do
    assert Collaboration.prompt_section({:error, "collaboration must be an object"}) =~
             "invalid"
  end

  defp random_ulid_tail(state) do
    alphabet = String.to_charlist("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    Enum.map_reduce(1..25, state, fn _, state ->
      {index, state} = :rand.uniform_s(length(alphabet), state)
      {Enum.at(alphabet, index - 1), state}
    end)
    |> then(fn {chars, state} -> {List.to_string(chars), state} end)
  end
end
