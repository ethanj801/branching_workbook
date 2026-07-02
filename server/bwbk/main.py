import os

from fastapi import FastAPI

from bwbk.db import router as db_router
from bwbk.dialog import router as dialog_router
from bwbk.samplers import router as samplers_router
from bwbk.settings import router as settings_router

_backend = os.getenv("BWBK_BACKEND", "mock").lower()
_lifespan = None
if _backend == "tabby":
    from bwbk.proxy import router as completions_router
elif _backend == "local":
    from bwbk.local import lifespan as _lifespan
    from bwbk.local import router as completions_router
else:
    from bwbk.mock import router as completions_router

app = FastAPI(title="Branching Workbook", lifespan=_lifespan)
app.include_router(completions_router)
app.include_router(db_router)
app.include_router(dialog_router)
app.include_router(samplers_router)
app.include_router(settings_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
