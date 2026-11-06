from fastapi import APIRouter

from app.api.v1 import admin, auth, billing, catalog, extras, misc, reading, social, storis, studio, telegram

router = APIRouter()
for m in (auth, catalog, reading, social, storis, billing, studio, extras, admin, misc, telegram):
    router.include_router(m.router)
