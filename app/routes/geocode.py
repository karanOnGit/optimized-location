"""Geocoding route: place name / Google Maps link → latitude & longitude."""

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.schemas.geocode import GeocodeResult
from app.services import geocode_service as svc

router = APIRouter(prefix="/api/geocode", tags=["Geocoding"])


@router.get(
    "",
    response_model=list[GeocodeResult],
    summary="Find latitude / longitude for a place",
    description=(
        "Accepts a place name, a 'lat, lng' pair, or a Google Maps link "
        "(full or maps.app.goo.gl short link). Uses Google Places when "
        "GOOGLE_MAPS_API_KEY is configured, otherwise OpenStreetMap Nominatim."
    ),
)
async def geocode(
    q: str = Query(..., min_length=2, max_length=2000),
    limit: int = Query(5, ge=1, le=10),
):
    try:
        return await svc.geocode(q, limit)
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail=f"Geocoding service error: {err}")
