from fastapi import APIRouter

from app.api.v1 import admin, auth, billing, catalog, misc, reading, social, storis, studio, telegram

router = APIRouter()
for m in (auth, catalog, reading, social, storis, billing, studio, admin, misc, telegram):
    router.include_router(m.router)
