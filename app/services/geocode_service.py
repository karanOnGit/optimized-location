"""
Resolve a place name, raw coordinates or a Google Maps link to lat/lng.

Resolution order:
1. Raw "lat, lng" text.
2. Google Maps links (full or maps.app.goo.gl short links) — coordinates are
   read straight from the URL, no API key needed.
3. Google Places Text Search — when GOOGLE_MAPS_API_KEY is configured.
4. Nominatim (OpenStreetMap) — free fallback, good for areas / streets /
   landmarks but weak on individual business names.
"""

import asyncio
import re
import time
from urllib.parse import parse_qs, unquote_plus, urlparse

import httpx

from app.core.config import get_settings
from app.schemas.geocode import GeocodeResult

USER_AGENT = "grouping-algo/1.0 (pickup-drop location manager)"
TIMEOUT = httpx.Timeout(10.0)

_COORD_RE = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
# "!3d<lat>!4d<lng>" is the actual place pin; "@lat,lng" is only the map viewport centre
_PIN_RE = re.compile(r"!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)")
_VIEWPORT_RE = re.compile(r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")
_PLACE_NAME_RE = re.compile(r"/maps/place/([^/@]+)")
_GOOGLE_HOSTS = ("google.", "goo.gl", "maps.app.goo.gl")

# Small in-memory cache + throttle (Nominatim policy: max 1 request / second)
_cache: dict[str, list[GeocodeResult]] = {}
_nominatim_lock = asyncio.Lock()
_nominatim_last_call = 0.0


def _valid(lat: float, lng: float) -> bool:
    return -90 <= lat <= 90 and -180 <= lng <= 180


def _parse_coordinates(text: str) -> GeocodeResult | None:
    m = _COORD_RE.match(text)
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    if not _valid(lat, lng):
        return None
    label = f"{lat:.6f}, {lng:.6f}"
    return GeocodeResult(name=label, address=label, lat=lat, lng=lng, source="coordinates")


def _is_google_maps_url(text: str) -> bool:
    if not text.startswith(("http://", "https://")):
        return False
    host = urlparse(text).netloc.lower()
    return any(h in host for h in _GOOGLE_HOSTS)


def _parse_google_maps_url(url: str) -> GeocodeResult | None:
    """Extract the pin (or viewport) coordinates and place name from a Google Maps URL."""
    url = unquote_plus(url) if "%21" in url or "%40" in url else url
    name_match = _PLACE_NAME_RE.search(url)
    name = unquote_plus(name_match.group(1)) if name_match else None

    coords = _PIN_RE.search(url) or _VIEWPORT_RE.search(url)
    if coords:
        lat, lng = float(coords.group(1)), float(coords.group(2))
    else:
        # e.g. https://www.google.com/maps?q=12.92,77.69 or /maps/search/12.92,+77.69
        q = parse_qs(urlparse(url).query).get("q", [""])[0]
        parsed = _parse_coordinates(q) or _parse_coordinates(url.rsplit("/", 1)[-1].replace("+", " "))
        if not parsed:
            return None
        lat, lng = parsed.lat, parsed.lng

    if not _valid(lat, lng):
        return None
    label = name or f"{lat:.6f}, {lng:.6f}"
    return GeocodeResult(name=label, address=label, lat=lat, lng=lng, source="google_maps_link")


async def _resolve_google_maps_url(url: str) -> GeocodeResult | None:
    """Parse a Google Maps URL, following short-link redirects if needed."""
    result = _parse_google_maps_url(url)
    if result:
        return result

    # Short links (maps.app.goo.gl/...) — follow redirects to the full URL
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True,
                                 headers={"User-Agent": USER_AGENT}) as client:
        resp = await client.get(url)
    final_url = str(resp.url)
    # EU consent interstitial wraps the real URL in ?continue=
    cont = parse_qs(urlparse(final_url).query).get("continue")
    if cont:
        final_url = cont[0]
    return _parse_google_maps_url(final_url)


async def _google_places_search(query: str, limit: int, api_key: str) -> list[GeocodeResult]:
    """Google Places API (New) Text Search — best for exact business / place names."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
            },
            json={"textQuery": query, "pageSize": limit},
        )
    resp.raise_for_status()
    return [
        GeocodeResult(
            name=p.get("displayName", {}).get("text") or p.get("formattedAddress", query),
            address=p.get("formattedAddress", ""),
            lat=p["location"]["latitude"],
            lng=p["location"]["longitude"],
            source="google_places",
        )
        for p in resp.json().get("places", [])
        if "location" in p
    ]


async def _nominatim_search(query: str, limit: int) -> list[GeocodeResult]:
    """OpenStreetMap Nominatim search, throttled to 1 request per second."""
    global _nominatim_last_call
    async with _nominatim_lock:
        wait = 1.0 - (time.monotonic() - _nominatim_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(
                get_settings().nominatim_url,
                params={"q": query, "format": "jsonv2", "limit": limit},
            )
        _nominatim_last_call = time.monotonic()
    resp.raise_for_status()
    return [
        GeocodeResult(
            name=r.get("name") or r["display_name"].split(",")[0],
            address=r["display_name"],
            lat=float(r["lat"]),
            lng=float(r["lon"]),
            source="nominatim",
        )
        for r in resp.json()
    ]


async def geocode(query: str, limit: int = 5) -> list[GeocodeResult]:
    """Resolve free text (place name, "lat, lng" or Google Maps link) to candidate locations."""
    query = query.strip()

    coords = _parse_coordinates(query)
    if coords:
        return [coords]

    if _is_google_maps_url(query):
        result = await _resolve_google_maps_url(query)
        return [result] if result else []

    cache_key = f"{limit}:{query.lower()}"
    if cache_key in _cache:
        return _cache[cache_key]

    results: list[GeocodeResult] = []
    api_key = get_settings().google_maps_api_key
    if api_key:
        try:
            results = await _google_places_search(query, limit, api_key)
        except httpx.HTTPError as err:
            # Bad key / API not enabled / quota — fall back to OpenStreetMap
            print(f"Google Places search failed, using Nominatim: {err}")
    if not results:
        results = await _nominatim_search(query, limit)

    _cache[cache_key] = results
    return results
