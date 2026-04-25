import os

from fastapi import FastAPI

from bwbk.db import router as db_router
from bwbk.dialog import router as dialog_router
from bwbk.samplers import router as samplers_router

if os.getenv("BWBK_BACKEND", "mock").lower() == "tabby":
    from bwbk.proxy import router as completions_router
else:
    from bwbk.mock import router as completions_router

app = FastAPI(title="Branching Workbook")
app.include_router(completions_router)
app.include_router(db_router)
app.include_router(dialog_router)
app.include_router(samplers_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
