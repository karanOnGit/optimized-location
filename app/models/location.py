"""MongoDB document models for location data."""

from datetime import datetime, timezone


def make_geojson_point(lat: float, lng: float) -> dict:
    """Create a GeoJSON Point object (MongoDB requires [lng, lat] order)."""
    return {
        "type": "Point",
        "coordinates": [lng, lat],
    }


def new_location_doc(
    label: str,
    pickup: dict,
    drops: list[dict],
) -> dict:
    """
    Build a location group document ready for MongoDB insertion.

    Parameters
    ----------
    label : str
        Human-readable name for this location group.
    pickup : dict
        Must contain keys: address, lat, lng.
    drops : list[dict]
        Each item must contain keys: address, lat, lng.
    """
    now = datetime.now(timezone.utc)
    return {
        "label": label,
        "pickup": {
            "address": pickup["address"],
            "lat": pickup["lat"],
            "lng": pickup["lng"],
            "coordinates": make_geojson_point(pickup["lat"], pickup["lng"]),
        },
        "drops": [
            {
                "address": d["address"],
                "lat": d["lat"],
                "lng": d["lng"],
                "coordinates": make_geojson_point(d["lat"], d["lng"]),
            }
            for d in drops
        ],
        "created_at": now,
        "updated_at": now,
    }
