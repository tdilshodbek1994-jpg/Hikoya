"""Owner analytics: aggregates only, demo/test excluded, permission enforced."""

from datetime import timedelta

from app.core.timeutil import utcnow

from app.models import ChapterCompletion, QualifiedRead
from tests.conftest import H, login
from tests.helpers import make_work, user_by_tg


async def test_analytics_series_funnel_dropoff(client, db):
    w, chs, _ = await make_work(db, chapters=3)
    hdr = H(await login(client, 8700))
    for i, ch in enumerate(chs[:2]):
        r = await client.get(f"/api/v1/chapters/{ch.id}/content", headers=hdr, params={"device_id": "d"})
        assert r.status_code == 200
    u = await user_by_tg(db, 8700)
    db.add(QualifiedRead(user_id=u.id, work_id=w.id, local_date=(utcnow() + timedelta(hours=5)).date()))
    db.add(ChapterCompletion(user_id=u.id, chapter_id=chs[0].id, work_id=w.id))
    await db.commit()
    await login(client, 9999)  # test account (HIKOYA_TEST_TELEGRAM_IDS) is not counted
    ohdr = H(await login(client, 1000))
    d = (await client.get("/api/v1/admin/analytics", params={"days": 7}, headers=ohdr)).json()
    assert len(d["daily"]) == 7
    assert d["daily"][-1]["active_readers"] >= 1 and d["daily"][-1]["qualified_readers"] == 1
    steps = {f["step"]: f["users"] for f in d["funnel"]}
    assert steps["started_reading"] >= 1 and steps["qualified_read"] == 1 and "paid" in steps
    drop = next(x for x in d["dropoff"] if x["work_id"] == w.id)
    assert [c["opened"] for c in drop["chapters"]] == [1, 1, 0] and drop["chapters"][0]["completed"] == 1
    assert "8700" not in str(d)  # no user identifiers
    reader = H(await login(client, 8701))
    assert (await client.get("/api/v1/admin/analytics", headers=reader)).status_code == 403
