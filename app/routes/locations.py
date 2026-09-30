"""REST API routes for location CRUD + geospatial search."""

from fastapi import APIRouter, HTTPException, Query, status
from app.schemas.location import (
    LocationCreateRequest,
    LocationCreateResponse,
    LocationResponse,
    LocationUpdateRequest,
)
from app.services import location_service as svc

router = APIRouter(prefix="/api/locations", tags=["Locations"])


@router.post(
    "",
    response_model=LocationCreateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a location group",
    description="Create a pickup + multiple drop locations. Each drop must be within 50 km of the pickup.",
)
async def create_location(body: LocationCreateRequest):
    doc, errors = await svc.create_location(body)
    if errors:
        return LocationCreateResponse(
            location=None,
            validation_errors=errors,
            message="Some drops exceed the maximum allowed range.",
        )
    return LocationCreateResponse(
        location=LocationResponse(**doc),
        validation_errors=None,
        message="Location group created successfully.",
    )


@router.get(
    "",
    response_model=list[LocationResponse],
    summary="List all location groups",
)
async def list_locations():
    return [LocationResponse(**d) for d in await svc.get_all_locations()]


@router.get(
    "/nearby",
    response_model=list[LocationResponse],
    summary="Find locations with drops near a point",
)
async def nearby(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(10, gt=0, le=50),
):
    return [LocationResponse(**d) for d in await svc.find_nearby_drops(lat, lng, radius_km)]


@router.get(
    "/{location_id}",
    response_model=LocationResponse,
    summary="Get a single location group",
)
async def get_location(location_id: str):
    doc = await svc.get_location(location_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Location group not found")
    return LocationResponse(**doc)


@router.put(
    "/{location_id}",
    response_model=LocationCreateResponse,
    summary="Update a location group",
)
async def update_location(location_id: str, body: LocationUpdateRequest):
    doc, errors, found = await svc.update_location(location_id, body)
    if not found:
        raise HTTPException(status_code=404, detail="Location group not found")
    if errors:
        return LocationCreateResponse(
            location=None,
            validation_errors=errors,
            message="Some drops exceed the maximum allowed range.",
        )
    return LocationCreateResponse(
        location=LocationResponse(**doc),
        validation_errors=None,
        message="Location group updated successfully.",
    )


@router.delete(
    "/{location_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a location group",
)
async def delete_location(location_id: str):
    deleted = await svc.delete_location(location_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Location group not found")
