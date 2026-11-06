from sqlalchemy import func, select

from app.models import Work
from app.services.demo import remove_demo, seed_demo
from tests.helpers import actor_for


async def test_demo_seed_marked_and_no_fake_counters(client, db):
    owner = await actor_for(db, 1000)
    res = await seed_demo(db, owner)
    await db.commit()
    assert res["created_works"] == 6
    works = (await db.scalars(select(Work))).all()
    assert all(w.is_demo for w in works)
    assert all(w.likes_count == 0 and w.thanks_count == 0 for w in works)
    home = (await client.get("/api/v1/home")).json()
    editorial = next(s for s in home["sections"] if s["kind"] == "editorial")
    assert editorial["items"] and all(i["is_demo"] for i in editorial["items"])
    assert (await client.get("/api/v1/storis/feed")).json()
    # T-04: «Barchasini ko'rish» keeps the rail's filter and order
    sec = (await client.get("/api/v1/home/sections/completed")).json()
    assert sec["see_all"] == {"status": "completed", "sort": "new"}
    full = (await client.get("/api/v1/works", params=sec["see_all"])).json()["items"]
    assert {i["id"] for i in sec["items"]} <= {i["id"] for i in full}
    assert all(i["completion_state"] == "completed" for i in full)
    again = await seed_demo(db, owner)
    assert again["created_works"] == 0
    await remove_demo(db)
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(Work)) == 0
