from fastapi import FastAPI

app = FastAPI(title="Branching Workbook")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
