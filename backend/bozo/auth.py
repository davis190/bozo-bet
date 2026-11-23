"""Who is calling and what they may do.

Roles: none (logged in, not approved) < viewer (approved, read-only, sees names) < player (a bozo) < admin.
"""
import os

from . import db
from .util import ApiError, now_iso

RANK = {"public": 0, "none": 1, "viewer": 2, "player": 3, "admin": 4}


def _admin_emails():
    return {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}


def resolve(event):
    """Returns a user dict (role 'public' when unauthenticated). Creates the user record on first login."""
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims")
    if not claims:
        return {"role": "public"}
    sub = claims["sub"]
    email = (claims.get("email") or "").lower()
    user = db.get_user(sub)
    if not user:
        user = {"sub": sub, "email": email, "name": claims.get("name") or email.split("@")[0],
                "role": "none", "createdAt": now_iso()}
        if email in _admin_emails():
            user.update(role="admin", playerId=os.environ.get("ADMIN_PLAYER_ID"))
        db.put_user(user)
    elif email in _admin_emails() and user.get("role") != "admin":
        user["role"] = "admin"
        db.put_user(user)
    return user


def require(user, role):
    if RANK.get(user.get("role"), 0) < RANK[role]:
        msg = "Log in first" if user.get("role") == "public" else "Ask the admin to let you in"
        raise ApiError(401 if user.get("role") == "public" else 403, msg)


def can_see_names(user):
    return RANK.get(user.get("role"), 0) >= RANK["viewer"]


def player_id(user):
    pid = user.get("playerId")
    if not pid or RANK.get(user.get("role"), 0) < RANK["player"]:
        raise ApiError(403, "You're not a bozo (yet). Only linked players can do that.")
    return pid
