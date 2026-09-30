"""
Grouping Algorithm — FastAPI application.

Provides APIs for managing pickup / drop location groups with a 50 km range
constraint, backed by MongoDB with geospatial indexing.
"""

from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.core.database import connect_db, close_db
from app.routes.locations import router as locations_router

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup / shutdown events."""
    await connect_db()
    yield
    await close_db()


app = FastAPI(
    title="Pickup & Drop Location Manager",
    description=(
        "Create and manage multiple pickup and drop locations on a map. "
        "All drops must be within a configurable range (default 50 km) of their pickup."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow everything in development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(locations_router)

# Serve the static frontend
static_dir = BASE_DIR / "app" / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", include_in_schema=False)
async def serve_frontend():
    """Serve the Leaflet map frontend."""
    return FileResponse(str(static_dir / "index.html"))
