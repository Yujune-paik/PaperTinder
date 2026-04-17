"""Master list of conferences / journals known to PaperTinder.

This module is the single source of truth for the available venues.
The frontend fetches ``/api/venues`` (see ``app.py``) so that the UI
stays in sync with what the backend can actually search.
"""
from __future__ import annotations


# Each venue definition: slug (used everywhere), display name, group,
# earliest supported year, and an optional language hint.
#
# The key is the canonical venue name that the rest of the codebase uses
# (e.g. when calling OpenAlex and when saving a deck).
VENUES: list[dict] = [
    # ---------------- HCI ----------------
    {"name": "CHI",              "group": "HCI",          "since": 1982},
    {"name": "UIST",             "group": "HCI",          "since": 1988},
    {"name": "CSCW",             "group": "HCI",          "since": 1986},
    {"name": "Ubicomp",          "group": "HCI",          "since": 2001},
    {"name": "ISWC",             "group": "HCI",          "since": 1997},
    {"name": "HRI",              "group": "HCI",          "since": 2006},
    {"name": "ISS",              "group": "HCI",          "since": 2013},
    {"name": "DIS",              "group": "HCI",          "since": 1995},
    {"name": "TEI",              "group": "HCI",          "since": 2007},
    {"name": "MobileHCI",        "group": "HCI",          "since": 1998},

    # ---------------- AI / ML ----------------
    {"name": "NeurIPS",          "group": "AI / ML",      "since": 1987},
    {"name": "CVPR",             "group": "AI / ML",      "since": 1983},
    {"name": "ICCV",             "group": "AI / ML",      "since": 1987},
    {"name": "ICML",             "group": "AI / ML",      "since": 1984},
    {"name": "ECCV",             "group": "AI / ML",      "since": 1990},
    {"name": "AAAI",             "group": "AI / ML",      "since": 1980},

    # ---------------- Graphics ----------------
    {"name": "SIGGRAPH",         "group": "Graphics",     "since": 1974},
    {"name": "SIGGRAPH Asia",    "group": "Graphics",     "since": 2008},

    # ---------------- Art / Media ----------------
    {"name": "ISEA",             "group": "Art / Media",  "since": 1988},
    {"name": "NIME",             "group": "Art / Media",  "since": 2001},

    # ---------------- Journals ----------------
    {"name": "Nature",           "group": "Journals",     "since": 1869},
    {"name": "Science",          "group": "Journals",     "since": 1880},
    {"name": "Science Robotics", "group": "Journals",     "since": 2016},

    # ---------------- Japanese societies ----------------
    {"name": "IPSJ",             "group": "Japanese",     "since": 1960, "lang": "ja"},
    {"name": "WISS",             "group": "Japanese",     "since": 1993, "lang": "ja"},
    {"name": "Interaction",      "group": "Japanese",     "since": 1997, "lang": "ja"},
]


GROUP_ORDER = [
    "HCI",
    "AI / ML",
    "Graphics",
    "Art / Media",
    "Journals",
    "Japanese",
]


def all_venue_names() -> list[str]:
    return [v["name"] for v in VENUES]


def list_venues() -> list[dict]:
    """Return VENUES ordered by the canonical group order."""
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    return sorted(VENUES, key=lambda v: (order.get(v["group"], 999), v["name"]))


def default_preferences() -> list[str]:
    """Default set of venues shown in the UI before a user customises it."""
    return [
        "CHI", "UIST", "CSCW", "Ubicomp",
        "NeurIPS", "CVPR", "ICCV", "ICML",
        "SIGGRAPH",
        "Nature", "Science",
    ]
