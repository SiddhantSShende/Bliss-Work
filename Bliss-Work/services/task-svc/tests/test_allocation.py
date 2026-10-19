"""Unit tests for app.allocation.derive_title_and_project (Rules A-H).

Pure logic, no DB/Kafka: the caller is responsible for resolving channel/
person/project names before calling this, so every case here is expressed
directly in terms of already-resolved names.
"""

from __future__ import annotations

import pytest

from app.allocation import AllocationError, AllocationSelection, derive_title_and_project


def _sel(**kwargs) -> AllocationSelection:
    defaults = dict(channel_names=[], person_names=[])
    defaults.update(kwargs)
    return AllocationSelection(**defaults)


def test_rule_a_one_channel():
    result = derive_title_and_project(_sel(channel_names=["Blisswork"]))
    assert result.title == "Blisswork"
    assert result.existing_project_id is None
    assert result.new_project_name is None


def test_rule_b_multiple_channels_requires_new_project_name():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel(channel_names=["Engineering", "Design"]))

    result = derive_title_and_project(
        _sel(channel_names=["Engineering", "Design"], new_project_name="Website Redesign")
    )
    assert result.title == "Website Redesign"
    assert result.new_project_name == "Website Redesign"
    assert result.existing_project_id is None


def test_rule_c_one_person():
    result = derive_title_and_project(_sel(person_names=["Alex Morgan"]))
    assert result.title == "Alex Morgan"


def test_rule_d_self_assignment_uses_resolved_display_name():
    # The caller resolves "self" server-side before this ever runs; from this
    # function's view a self-assignment is indistinguishable from naming
    # anyone else — it is just one person_name.
    result = derive_title_and_project(_sel(person_names=["Me Myself"]))
    assert result.title == "Me Myself"


def test_rule_e_multiple_people_requires_new_project_name():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel(person_names=["Alex", "Sam"]))

    result = derive_title_and_project(
        _sel(person_names=["Alex", "Sam"], new_project_name="Launch Plan")
    )
    assert result.title == "Launch Plan"
    assert result.new_project_name == "Launch Plan"


def test_rule_f_an_explicit_project_wins_regardless_of_its_channels_or_people():
    result = derive_title_and_project(
        _sel(
            channel_names=["Engineering", "Design"],
            person_names=["Alex"],
            existing_project_id="proj-1",
            existing_project_name="Website Redesign",
        )
    )
    assert result.title == "Website Redesign"
    assert result.existing_project_id == "proj-1"
    assert result.new_project_name is None


def test_rule_g_multiple_projects_is_modeled_by_the_caller_as_a_new_project_name():
    # The route collapses "multiple projects selected" into: no single
    # existing_project_id, channels/people drawn from the union, and a
    # required new name for the combined scope — exercised the same as
    # Rule B/E/H here.
    result = derive_title_and_project(
        _sel(channel_names=["Eng-Proj-A", "Design-Proj-B"], new_project_name="Combined Initiative")
    )
    assert result.title == "Combined Initiative"


def test_rule_h_mixed_channel_and_person_requires_a_project_name():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel(channel_names=["Engineering"], person_names=["Alex"]))

    result = derive_title_and_project(
        _sel(channel_names=["Engineering"], person_names=["Alex"], new_project_name="Q3 Push")
    )
    assert result.title == "Q3 Push"


def test_empty_selection_is_rejected():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel())


def test_blank_new_project_name_is_rejected_not_silently_accepted():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel(channel_names=["A", "B"], new_project_name="   "))


def test_explicit_project_without_a_name_is_rejected():
    with pytest.raises(AllocationError):
        derive_title_and_project(_sel(existing_project_id="proj-1", existing_project_name=""))
