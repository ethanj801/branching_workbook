from fastapi import FastAPI

from bwbk.db import router as db_router
from bwbk.mock import router as mock_router

app = FastAPI(title="Branching Workbook")
app.include_router(mock_router)
app.include_router(db_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
