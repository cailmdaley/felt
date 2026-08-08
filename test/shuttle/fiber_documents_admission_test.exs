defmodule Shuttle.FiberDocumentsAdmissionTest do
  @moduledoc """
  The kanban admission vocabulary: which felt walks together admit a board
  fiber, and which rows the non-`shuttle:` walks claim.

  Pure functions only — no felt, no poller. The walks themselves are exercised
  end-to-end against real fixture stores in
  `ShuttleWeb.FiberDocumentsControllerTest`.
  """
  use ExUnit.Case, async: true

  alias Shuttle.FiberDocuments

  describe "kanban_fields/0" do
    test "projects `start`, without which a cycle band has no left edge" do
      assert "start" in FiberDocuments.kanban_fields()
    end

    test "still projects the fields the board has always needed" do
      fields = FiberDocuments.kanban_fields()
      for f <- ~w(id uid name status tags due shuttle path report_path), do: assert(f in fields)
    end
  end

  describe "kanban_walks/0" do
    test "leads with the shuttle walk and adds the two gap-closing walks" do
      assert [primary | aux] = FiberDocuments.kanban_walks()
      assert primary == ["--has-field", "shuttle"]
      assert ["--has-field", "due"] in aux
      assert ["-t", "cycle"] in aux
    end
  end

  describe "kanban_aux_admissible?/1" do
    test "claims a fiber carrying a due date" do
      assert FiberDocuments.kanban_aux_admissible?(%{"due" => "2026-11-30T00:00:00Z"})
    end

    test "claims a cycle-tagged fiber, case- and whitespace-insensitively" do
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["cycle"]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["Cycle"]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => [" cycle "]})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => ["planning", "CYCLE"]})
    end

    test "does not claim a fiber that is neither" do
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => ["cycles", "recycle"]})
      refute FiberDocuments.kanban_aux_admissible?(%{"name" => "plain"})
      refute FiberDocuments.kanban_aux_admissible?(%{})
    end

    test "treats an absent, nil, or empty due as no due" do
      refute FiberDocuments.kanban_aux_admissible?(%{"due" => nil})
      refute FiberDocuments.kanban_aux_admissible?(%{"due" => ""})
    end

    test "tolerates malformed tags rather than raising" do
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => nil})
      refute FiberDocuments.kanban_aux_admissible?(%{"tags" => "cycle"})
      assert FiberDocuments.kanban_aux_admissible?(%{"tags" => [nil, 7, "cycle"]})
    end

    test "is false for a non-map row" do
      refute FiberDocuments.kanban_aux_admissible?("nope")
      refute FiberDocuments.kanban_aux_admissible?(nil)
    end
  end

  describe "union_by_id/2" do
    test "keeps the primary row when both walks matched the same fiber" do
      primary = [%{"id" => "a", "from" => "shuttle"}]
      extra = [%{"id" => "a", "from" => "due"}, %{"id" => "b", "from" => "due"}]

      assert FiberDocuments.union_by_id(primary, extra) == [
               %{"id" => "a", "from" => "shuttle"},
               %{"id" => "b", "from" => "due"}
             ]
    end

    test "dedupes within the additional rows too, so two aux walks cannot double a fiber" do
      # A cycle-tagged fiber that also carries a due matches both aux walks.
      extra = [%{"id" => "c", "from" => "due"}, %{"id" => "c", "from" => "cycle"}]

      assert FiberDocuments.union_by_id([], extra) == [%{"id" => "c", "from" => "due"}]
    end

    test "drops additional rows with no usable id" do
      extra = [%{"id" => ""}, %{"no" => "id"}, %{"id" => "keep"}]
      assert FiberDocuments.union_by_id([], extra) == [%{"id" => "keep"}]
    end

    test "an empty additional list leaves the primary untouched" do
      primary = [%{"id" => "a"}, %{"id" => "b"}]
      assert FiberDocuments.union_by_id(primary, []) == primary
    end
  end
end
