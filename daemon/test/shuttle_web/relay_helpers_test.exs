defmodule ShuttleWeb.RelayHelpersTest do
  use ExUnit.Case, async: true
  import Plug.Test
  alias ShuttleWeb.RelayHelpers

  test "pre-send failures say nothing applied and lost replies preserve uncertainty" do
    for reason <- [{:not_sent, :econnrefused}, :closed] do
      result = {:error, {:forward_failed, "worker", reason}}
      text = RelayHelpers.relay_text(conn(:post, "/"), result)
      json = RelayHelpers.relay_json(conn(:post, "/"), result)
      transition = Shuttle.Transition.http_error({:forward_failed, "worker", reason})
      assert text.status == 502
      assert json.status == 502
      assert {502, message} = transition

      for body <- [text.resp_body, json.resp_body, message] do
        if match?({:not_sent, _}, reason) do
          assert body =~ "no action request was sent"
          assert body =~ "nothing was applied"
          refute body =~ "may have been applied"
        else
          assert body =~ "may have been applied"
          assert body =~ "before retrying"
          refute body =~ "nothing was applied"
        end
      end
    end
  end
end
