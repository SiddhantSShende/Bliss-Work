"""Server-side, authoritative task-title derivation (Smart Task Allocation).

One function decides a task's title from its Projects/Channels/People
selection, per Rules A-H of the allocation spec. It is pure — given names
already resolved by the caller (channel names from messaging-svc, person
display names from user_projection, an existing project's name) — so it has
no I/O and is trivial to unit test exhaustively. The caller (tasks_write.py)
is responsible for resolving those names and for actually creating a new
project when this returns one to create; this module only decides WHAT the
title and project should be, never performs the side effects.
"""

from __future__ import annotations

from dataclasses import dataclass


class AllocationError(ValueError):
    """The selection does not fit any title rule — the route turns this into
    a 400 with this message, per spec: "stop task creation with a clear
    validation message instead of guessing."""


@dataclass(frozen=True)
class AllocationSelection:
    # Channels selected directly OR pulled in by a selected project — see
    # Rule F: when an explicit project is selected it alone drives the title,
    # so its channel/person counts are irrelevant here.
    channel_names: list[str]
    # People named directly, excluding anyone reached only via a channel.
    person_names: list[str]
    # An existing project the user explicitly picked (Rule F/G, "selects an
    # existing project that already represents the combined scope").
    existing_project_name: str | None = None
    existing_project_id: str | None = None
    # A name the user typed for a NEW project, required by Rules B/E/G/H
    # whenever no existing project covers the selection.
    new_project_name: str | None = None


@dataclass(frozen=True)
class DerivedAllocation:
    title: str
    # Non-None exactly when an existing project should be attached as-is.
    existing_project_id: str | None = None
    # Non-None exactly when a NEW project must be created under this name.
    new_project_name: str | None = None


def derive_title_and_project(sel: AllocationSelection) -> DerivedAllocation:
    channel_count = len(sel.channel_names)
    person_count = len(sel.person_names)

    # Rule F/G — an explicit existing project always wins and drives the
    # title, regardless of how many channels/people it brought along.
    if sel.existing_project_id:
        if not sel.existing_project_name:
            raise AllocationError("selected project has no name")
        return DerivedAllocation(
            title=sel.existing_project_name, existing_project_id=sel.existing_project_id
        )

    # Rules B, E, H — more than one channel, more than one person, or any mix
    # of channel(s) with named people, all require a project: either the one
    # above (already handled) or a new one the user names here.
    needs_project = channel_count > 1 or person_count > 1 or (channel_count >= 1 and person_count >= 1)
    if needs_project:
        name = (sel.new_project_name or "").strip()
        if not name:
            raise AllocationError("a project name is required for this selection")
        return DerivedAllocation(title=name, new_project_name=name)

    # Rule A — exactly one channel, nothing else.
    if channel_count == 1:
        return DerivedAllocation(title=sel.channel_names[0])

    # Rules C/D — exactly one person (self or someone else; the caller
    # resolves "self" via the verified principal, never a client-supplied id,
    # before this function ever sees the name).
    if person_count == 1:
        return DerivedAllocation(title=sel.person_names[0])

    raise AllocationError("select at least one project, channel, or person")
