"""Pydantic schemas for geocoding (place name / Google Maps link → lat/lng)."""

from typing import Literal
from pydantic import BaseModel


class GeocodeResult(BaseModel):
    name: str
    address: str
    lat: float
    lng: float
    source: Literal["coordinates", "google_maps_link", "google_places", "nominatim"]
