# 📍 Pickup & Drop Location Manager

A **FastAPI** backend with an interactive **Leaflet.js** map frontend for creating and managing multiple pickup and drop locations — all validated to stay within a **50 km** radius.

## 🏗 Project Structure

```
grouping-algo/
├── main.py                    # FastAPI app entry point
├── requirements.txt           # Python dependencies
├── .env                       # Environment configuration
├── app/
│   ├── __init__.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py          # Settings (pydantic-settings)
│   │   └── database.py        # MongoDB connection (Motor async)
│   ├── models/
│   │   ├── __init__.py
│   │   └── location.py        # Document builders & GeoJSON helpers
│   ├── schemas/
│   │   ├── __init__.py
│   │   └── location.py        # Pydantic request/response models
│   ├── services/
│   │   ├── __init__.py
│   │   └── location_service.py # Business logic & validation
│   ├── routes/
│   │   ├── __init__.py
│   │   └── locations.py       # REST API endpoints
│   └── static/
│       ├── index.html         # Leaflet map frontend
│       ├── style.css          # Dark theme styles
│       └── app.js             # Client-side map logic
```

## ⚙️ Prerequisites

- **Python 3.11+**
- **MongoDB** running on `localhost:27017` (or update `.env`)

## 🚀 Quick Start

```bash
# 1. Create & activate virtual environment
python -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start the server
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000** for the interactive map, or **http://localhost:8000/docs** for Swagger API docs.

## 📡 API Endpoints

| Method   | Endpoint                  | Description                              |
| -------- | ------------------------- | ---------------------------------------- |
| `POST`   | `/api/locations`          | Create a location group (pickup + drops) |
| `GET`    | `/api/locations`          | List all location groups                 |
| `GET`    | `/api/locations/{id}`     | Get a single location group              |
| `PUT`    | `/api/locations/{id}`     | Update a location group                  |
| `DELETE` | `/api/locations/{id}`     | Delete a location group                  |
| `GET`    | `/api/locations/nearby`   | Find drops near a point (geospatial)     |
| `GET`    | `/api/geocode?q=...`      | Place name / Google Maps link → lat, lng |

## 🗺 Map Features

- **Click-to-place** pickup & drop markers (draggable)
- **50 km radius circle** drawn around pickup
- **Real-time distance** validation with colour coding
- **Dashed route lines** connecting pickup to each drop
- **Full CRUD** — create, edit, delete location groups
- **Dark theme** with smooth animations

## 📐 Configuration

Edit `.env` to change defaults:

```env
MONGODB_URL=mongodb://localhost:27017
DATABASE_NAME=grouping_algo
MAX_RANGE_KM=50.0
GOOGLE_MAPS_API_KEY=   # optional — enables Google Places name search
```

### 🔍 Place search

The **Find place** box on pickup and drops accepts:

- a **Google Maps link** (full URL or `maps.app.goo.gl` short link) — the exact pin
  coordinates are read from the link, no API key needed;
- a **place name** — searched with Google Places (API (New), Text Search) when
  `GOOGLE_MAPS_API_KEY` is set, otherwise OpenStreetMap Nominatim (free, but weak on
  individual business names);
- raw **`lat, lng`** text.
# optimized-location
