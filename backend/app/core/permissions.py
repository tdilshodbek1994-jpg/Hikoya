"""Fine-grained permissions (spec section 4).

Roles are bundles of permissions. Every API call and bot command checks a permission
and, for object-scoped actions, ownership/assignment. Hiding a button is never a check.
"""

from __future__ import annotations

ALL_PERMISSIONS = {
    "work.create",
    "work.edit_own",
    "work.edit_assigned",
    "work.edit_any",
    "work.publish",
    "work.review",
    "work.change_access",
    "work.delist",
    "work.suspend",
    "author.manage",
    "author.post_as",
    "story.create_own",
    "story.publish",
    "story.moderate",
    "comment.moderate",
    "catalog.manage",  # genres, tags, home sections, curated collections
    "billing.view",
    "billing.refund",
    "billing.manage_products",
    "support.handle",
    "stats.view_all",
    "roles.manage",
    "audit.view",
    "settings.manage",
}

ROLES: dict[str, set[str]] = {
    "owner": set(ALL_PERMISSIONS),
    "content_admin": {
        "work.create",
        "work.edit_own",
        "work.edit_assigned",
        "work.edit_any",
        "work.publish",
        "work.review",
        "work.delist",
        "author.manage",
        "author.post_as",
        "story.create_own",
        "story.publish",
        "story.moderate",
        "catalog.manage",
        "stats.view_all",
    },
    "editor": {"work.edit_assigned", "work.review"},
    "moderator": {"comment.moderate", "story.moderate"},
    "author": {"work.create", "work.edit_own", "story.create_own"},
    "support": {"support.handle", "billing.view"},
}

# Roles an ordinary staff member with roles.manage may never hand out.
PROTECTED_ROLES = {"owner"}

ROLE_TITLES = {
    "owner": "Egasi",
    "content_admin": "Kontent administratori",
    "editor": "Muharrir",
    "moderator": "Moderator",
    "author": "Muallif",
    "support": "Yordam / moliya operatori",
}


def expand(role: str | None, permission: str | None) -> set[str]:
    out: set[str] = set()
    if role:
        out |= ROLES.get(role, set())
    if permission and permission in ALL_PERMISSIONS:
        out.add(permission)
    return out
