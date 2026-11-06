from fastapi import APIRouter

from app.api.v1 import auth, catalog, reading

router = APIRouter()
for m in (auth, catalog, reading):
    router.include_router(m.router)
