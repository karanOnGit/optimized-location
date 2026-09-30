import certifi
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from app.core.config import get_settings

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None


async def connect_db() -> None:
    """Open MongoDB connection and create geospatial indexes."""
    global _client, _db
    settings = get_settings()
    _client = AsyncIOMotorClient(settings.mongodb_url, tlsCAFile=certifi.where())
    _db = _client[settings.database_name]

    # Create 2dsphere indexes for geospatial queries
    await _db.locations.create_index([("pickup.coordinates", "2dsphere")])
    await _db.locations.create_index([("drops.coordinates", "2dsphere")])


async def close_db() -> None:
    """Close MongoDB connection."""
    global _client, _db
    if _client:
        _client.close()
    _client = None
    _db = None


def get_db() -> AsyncIOMotorDatabase:
    """Return the active database instance."""
    if _db is None:
        raise RuntimeError("Database not initialised — call connect_db() first")
    return _db
