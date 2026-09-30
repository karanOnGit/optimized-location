"""Pydantic schemas for request / response validation."""

from pydantic import BaseModel, Field
from datetime import datetime


# ── Request schemas ──────────────────────────────────────────────────────────


class Coordinate(BaseModel):
    """A single geographical point."""

    address: str = Field(..., min_length=1, examples=["123 Main St, New Delhi"])
    lat: float = Field(..., ge=-90, le=90, examples=[28.6139])
    lng: float = Field(..., ge=-180, le=180, examples=[77.2090])


class LocationCreateRequest(BaseModel):
    """Create a location group with one pickup and multiple drops."""

    label: str = Field(
        ...,
        min_length=1,
        max_length=200,
        examples=["Morning delivery batch"],
    )
    pickup: Coordinate
    drops: list[Coordinate] = Field(..., min_length=1)


class LocationUpdateRequest(BaseModel):
    """Partial update — all fields optional."""

    label: str | None = Field(None, min_length=1, max_length=200)
    pickup: Coordinate | None = None
    drops: list[Coordinate] | None = Field(None, min_length=1)


# ── Response schemas ─────────────────────────────────────────────────────────


class DropResponse(BaseModel):
    address: str
    lat: float
    lng: float
    distance_km: float | None = Field(
        None,
        description="Distance from pickup in kilometres",
    )


class PickupResponse(BaseModel):
    address: str
    lat: float
    lng: float


class LocationResponse(BaseModel):
    id: str
    label: str
    pickup: PickupResponse
    drops: list[DropResponse]
    created_at: datetime
    updated_at: datetime


class ValidationErrorDetail(BaseModel):
    drop_index: int
    address: str
    distance_km: float
    max_allowed_km: float
    message: str


class LocationCreateResponse(BaseModel):
    """Response after creating a location group."""

    location: LocationResponse | None = None
    validation_errors: list[ValidationErrorDetail] | None = None
    message: str
