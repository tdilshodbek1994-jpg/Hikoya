import time

import pytest

from app.core import content_schema as cs
from app.core.errors import Unauthorized
from app.core.security import build_init_data, validate_init_data
from app.core.text import cyr_to_lat, lat_to_cyr, normalize_for_search
from app.core.timeutil import in_quiet_hours, period_start

TOKEN = "123:ABC"


def test_init_data_valid():
    s = build_init_data(TOKEN, {"id": 42, "first_name": "Ali", "is_premium": True}, start_param="w_abc")
    ident = validate_init_data(s, TOKEN, 300)
    assert ident.telegram_user_id == 42 and ident.start_param == "w_abc" and ident.is_premium_telegram


def test_init_data_tampered_user_id_rejected():
    """T-38: changing user id breaks the signature."""
    s = build_init_data(TOKEN, {"id": 42, "first_name": "Ali"})
    tampered = s.replace("%22id%22%3A42", "%22id%22%3A43")
    assert tampered != s
    with pytest.raises(Unauthorized):
        validate_init_data(tampered, TOKEN, 300)


def test_init_data_wrong_token_and_expired():
    s = build_init_data(TOKEN, {"id": 1})
    with pytest.raises(Unauthorized):
        validate_init_data(s, "other:token", 300)
    old = build_init_data(TOKEN, {"id": 1}, auth_date=int(time.time()) - 301)
    with pytest.raises(Unauthorized) as e:
        validate_init_data(old, TOKEN, 300)
    assert e.value.code == "auth_expired"


def test_search_normalisation_script_and_apostrophes():
    """T-05: Latin/Cyrillic and different apostrophes normalise to the same key."""
    variants = ["O'zbekiston", "Oʻzbekiston", "O‘zbekiston", "O`zbekiston", "Ўзбекистон"]
    keys = {normalize_for_search(v) for v in variants}
    assert keys == {"ozbekiston"}
    assert normalize_for_search("Ғалаба") == normalize_for_search("G'alaba")


def test_transliteration_roundtrip():
    assert lat_to_cyr("Sevgi va oila") == "Севги ва оила"
    assert cyr_to_lat("Шаҳар") == "Shahar"
    assert lat_to_cyr("ertak") == "эртак"


def test_sanitize_removes_html_and_unknown_nodes():
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "<script>alert(1)</script> salom", "marks": [{"type": "link", "attrs": {"href": "x"}}, {"type": "bold"}]}]},
            {"type": "iframe", "attrs": {"src": "evil"}},
            {"type": "heading", "attrs": {"level": 1, "bid": "bdup000001"}, "content": [{"type": "text", "text": "Bosh"}]},
            {"type": "paragraph", "attrs": {"bid": "bdup000001"}, "content": [{"type": "text", "text": "ikki"}]},
        ],
    }
    out = cs.sanitize_doc(doc)
    assert [b["type"] for b in out["content"]] == ["paragraph", "heading", "paragraph"]
    assert out["content"][0]["content"][0]["marks"] == [{"type": "bold"}]
    # text is kept literally (rendered escaped), never as HTML
    assert out["content"][0]["content"][0]["text"].startswith("<script>")
    ids = cs.block_ids(out)
    assert len(set(ids)) == 3 and out["content"][1]["attrs"]["bid"] == "bdup000001"
    assert out["content"][1]["attrs"]["level"] == 2


def test_nearest_preserved_block():
    """T-17: removed block maps to the closest surviving one, not to the start."""
    old = ["b0000001", "b0000002", "b0000003", "b0000004"]
    new = ["b0000001", "b0000002", "b0000004"]
    assert cs.nearest_preserved_block(old, new, "b0000003") == ("b0000002", True)
    assert cs.nearest_preserved_block(old, new, "b0000004") == ("b0000004", False)
    assert cs.nearest_preserved_block(old, ["b0000004"], "b0000001") == ("b0000004", True)


def test_text_to_doc_markdown():
    d = cs.text_to_doc("# Bob\n\nBirinchi **qalin** va *kursiv*.\n\n---\n\n> iqtibos")
    types = [b["type"] for b in d["content"]]
    assert types == ["heading", "paragraph", "horizontalRule", "blockquote"]


def test_periods_tashkent():
    from datetime import datetime, timezone

    now = datetime(2026, 11, 4, 20, 30, tzinfo=timezone.utc)  # Thu 01:30 Tashkent
    assert period_start("today", now).isoformat() == "2026-11-04T19:00:00+00:00"
    assert period_start("week", now).isoformat() == "2026-11-01T19:00:00+00:00"  # Monday 00:00 local
    assert period_start("month", now).isoformat() == "2026-10-31T19:00:00+00:00"


def test_quiet_hours():
    from datetime import datetime, timezone

    assert in_quiet_hours("22:00", "09:00", "Asia/Tashkent", datetime(2026, 11, 4, 18, 0, tzinfo=timezone.utc))  # 23:00
    assert not in_quiet_hours("22:00", "09:00", "Asia/Tashkent", datetime(2026, 11, 4, 6, 0, tzinfo=timezone.utc))  # 11:00
