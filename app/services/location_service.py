"""Business logic for location operations."""

from bson import ObjectId
from datetime import datetime, timezone
from geopy.distance import geodesic

from app.core.config import get_settings
from app.core.database import get_db
from app.models.location import new_location_doc, make_geojson_point
from app.schemas.location import (
    Coordinate,
    LocationCreateRequest,
    LocationUpdateRequest,
    ValidationErrorDetail,
)


def _calc_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance between two points in kilometres."""
    return round(geodesic((lat1, lng1), (lat2, lng2)).km, 3)


def _serialize(doc: dict) -> dict:
    """Convert a MongoDB document to a JSON-safe dict."""
    doc["id"] = str(doc.pop("_id"))
    pickup = doc["pickup"]
    pickup.pop("coordinates", None)
    for d in doc.get("drops", []):
        d.pop("coordinates", None)
        # Compute distance from pickup
        d["distance_km"] = _calc_distance_km(
            pickup["lat"], pickup["lng"], d["lat"], d["lng"]
        )
    return doc


def validate_drops_within_range(
    pickup: Coordinate,
    drops: list[Coordinate],
) -> list[ValidationErrorDetail]:
    """Return a list of drops that exceed the configured max range."""
    max_km = get_settings().max_range_km
    errors: list[ValidationErrorDetail] = []
    for idx, drop in enumerate(drops):
        dist = _calc_distance_km(pickup.lat, pickup.lng, drop.lat, drop.lng)
        if dist > max_km:
            errors.append(
                ValidationErrorDetail(
                    drop_index=idx,
                    address=drop.address,
                    distance_km=dist,
                    max_allowed_km=max_km,
                    message=(
                        f"Drop '{drop.address}' is {dist} km from pickup — "
                        f"exceeds the {max_km} km limit."
                    ),
                )
            )
    return errors


async def create_location(payload: LocationCreateRequest) -> tuple[dict | None, list[ValidationErrorDetail]]:
    """Validate range, then insert a new location group."""
    errors = validate_drops_within_range(payload.pickup, payload.drops)
    if errors:
        return None, errors

    doc = new_location_doc(
        label=payload.label,
        pickup=payload.pickup.model_dump(),
        drops=[d.model_dump() for d in payload.drops],
    )
    result = await get_db().locations.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _serialize(doc), []


async def get_all_locations() -> list[dict]:
    """Return every location group."""
    cursor = get_db().locations.find().sort("created_at", -1)
    return [_serialize(doc) async for doc in cursor]


async def get_location(location_id: str) -> dict | None:
    """Return a single location group by id."""
    if not ObjectId.is_valid(location_id):
        return None
    doc = await get_db().locations.find_one({"_id": ObjectId(location_id)})
    return _serialize(doc) if doc else None


async def update_location(
    location_id: str, payload: LocationUpdateRequest
) -> tuple[dict | None, list[ValidationErrorDetail], bool]:
    """
    Update a location group. Returns (doc, errors, found).
    """
    if not ObjectId.is_valid(location_id):
        return None, [], False

    existing = await get_db().locations.find_one({"_id": ObjectId(location_id)})
    if not existing:
        return None, [], False

    update_fields: dict = {"updated_at": datetime.now(timezone.utc)}

    # Resolve effective pickup & drops for range validation
    effective_pickup = payload.pickup or Coordinate(
        address=existing["pickup"]["address"],
        lat=existing["pickup"]["lat"],
        lng=existing["pickup"]["lng"],
    )
    effective_drops = payload.drops
    if effective_drops is None:
        effective_drops = [
            Coordinate(address=d["address"], lat=d["lat"], lng=d["lng"])
            for d in existing["drops"]
        ]

    errors = validate_drops_within_range(effective_pickup, effective_drops)
    if errors:
        return None, errors, True

    if payload.label is not None:
        update_fields["label"] = payload.label

    if payload.pickup is not None:
        p = payload.pickup
        update_fields["pickup"] = {
            "address": p.address,
            "lat": p.lat,
            "lng": p.lng,
            "coordinates": make_geojson_point(p.lat, p.lng),
        }

    if payload.drops is not None:
        update_fields["drops"] = [
            {
                "address": d.address,
                "lat": d.lat,
                "lng": d.lng,
                "coordinates": make_geojson_point(d.lat, d.lng),
            }
            for d in payload.drops
        ]

    await get_db().locations.update_one(
        {"_id": ObjectId(location_id)}, {"$set": update_fields}
    )
    updated = await get_db().locations.find_one({"_id": ObjectId(location_id)})
    return _serialize(updated), [], True


async def delete_location(location_id: str) -> bool:
    """Delete a location group. Returns True if it existed."""
    if not ObjectId.is_valid(location_id):
        return False
    result = await get_db().locations.delete_one({"_id": ObjectId(location_id)})
    return result.deleted_count > 0


async def find_nearby_drops(lat: float, lng: float, radius_km: float) -> list[dict]:
    """
    Find all location groups that have at least one drop within `radius_km`
    of the given point, using MongoDB $geoNear.
    """
    radius_meters = radius_km * 1000
    pipeline = [
        {
            "$geoNear": {
                "near": {"type": "Point", "coordinates": [lng, lat]},
                "distanceField": "distance_meters",
                "maxDistance": radius_meters,
                "spherical": True,
                "key": "drops.coordinates",
            }
        },
        {"$limit": 100},
    ]
    cursor = get_db().locations.aggregate(pipeline)
    results = []
    async for doc in cursor:
        doc["distance_km"] = round(doc.pop("distance_meters", 0) / 1000, 3)
        results.append(_serialize(doc))
    return results
