/* ═══════════════════════════════════════════════════════════════════════════
   Pickup & Drop Location Manager — Client Application
   ═══════════════════════════════════════════════════════════════════════════ */

const API = "/api/locations";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const MAX_RANGE_KM = 50;

// ── State ────────────────────────────────────────────────────────────────
let map;
let clickMode = null; // null | 'pickup' | 'drop'
let pickupMarker = null;
let pickupCircle = null;
let dropMarkers = [];
let drops = [];
let editingId = null;
let allMarkerLayers = L.layerGroup();
let savedGroupLayers = {}; // id → layerGroup
let tripLayer = L.layerGroup(); // stoppage route across all saved points
let tripRenderSeq = 0; // ignore stale trip responses
let lastLocations = []; // last loaded saved groups, for re-batching
let shortestLayer = L.featureGroup(); // shortest path for the group being created/edited
let shortestSeq = 0; // ignore stale shortest-path responses
let shortestTimer = null;
const SHORTEST_COLOR = "#111827";

// Custom icons
const pickupIcon = L.divIcon({
  className: "custom-marker",
  html: `<div style="
    width:32px;height:32px;border-radius:50%;
    background:linear-gradient(135deg,#22c55e,#16a34a);
    border:3px solid #fff;box-shadow:0 2px 12px rgba(34,197,94,0.5);
    display:flex;align-items:center;justify-content:center;
    font-size:14px;
  ">📦</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

const dropIcon = L.divIcon({
  className: "custom-marker",
  html: `<div style="
    width:28px;height:28px;border-radius:50%;
    background:linear-gradient(135deg,#ef4444,#dc2626);
    border:3px solid #fff;box-shadow:0 2px 12px rgba(239,68,68,0.5);
    display:flex;align-items:center;justify-content:center;
    font-size:12px;
  ">📍</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const savedPickupIcon = L.divIcon({
  className: "custom-marker",
  html: `<div style="
    width:28px;height:28px;border-radius:50%;
    background:linear-gradient(135deg,#6c63ff,#8b5cf6);
    border:3px solid #fff;box-shadow:0 2px 12px rgba(108,99,255,0.5);
    display:flex;align-items:center;justify-content:center;
    font-size:12px;
  ">📦</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const savedDropIcon = L.divIcon({
  className: "custom-marker",
  html: `<div style="
    width:24px;height:24px;border-radius:50%;
    background:linear-gradient(135deg,#f59e0b,#d97706);
    border:2px solid #fff;box-shadow:0 2px 10px rgba(245,158,11,0.4);
    display:flex;align-items:center;justify-content:center;
    font-size:10px;
  ">📍</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Route color palette — cycles through for multiple drops
const ROUTE_COLORS = ["#6c63ff", "#06b6d4", "#f59e0b", "#ec4899", "#22c55e", "#a855f7"];

// ── Initialise Map ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  map = L.map("map", {
    center: [28.6139, 77.209],
    zoom: 11,
    zoomControl: false,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  // CARTO Voyager basemap
  L.tileLayer(
    "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_44h5_1_3e1bb155736670a1158fce56",
    {
      attribution: '&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 20,
    }
  ).addTo(map);

  allMarkerLayers.addTo(map);

  // Stoppage route sits above the per-group routes but below markers
  map.createPane("tripPane").style.zIndex = 450;
  // Form's shortest path sits above every other route line
  map.createPane("shortestPane").style.zIndex = 460;
  shortestLayer.addTo(map);
  tripLayer.addTo(map);
  document.getElementById("batchMode").addEventListener("change", () => renderBatchRoutes(lastLocations));
  document.getElementById("tripToggle").addEventListener("change", (e) => {
    if (e.target.checked) tripLayer.addTo(map);
    else tripLayer.remove();
  });

  // Map click handler
  map.on("click", onMapClick);

  // Form handlers
  document.getElementById("btnSetPickup").addEventListener("click", () => {
    // If lat/lng are already filled, set pickup directly from inputs
    const lat = parseFloat(document.getElementById("pickupLat").value);
    const lng = parseFloat(document.getElementById("pickupLng").value);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      setPickup(lat, lng);
      map.setView([lat, lng], 14);
    } else {
      // Otherwise, enter click-on-map mode
      setClickMode("pickup");
    }
  });
  document.getElementById("btnAddDrop").addEventListener("click", () => {
    // If lat/lng are filled, add the drop directly from inputs
    const latInput = document.getElementById("dropLat");
    const lngInput = document.getElementById("dropLng");
    const addrInput = document.getElementById("dropAddress");
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      addDrop(lat, lng, addrInput.value.trim() || null);
      latInput.value = "";
      lngInput.value = "";
      addrInput.value = "";
    } else if (latInput.value || lngInput.value) {
      toast("Enter a valid latitude (-90..90) and longitude (-180..180)", "error");
    } else {
      // Otherwise, enter click-on-map mode
      setClickMode("drop");
    }
  });
  ["dropAddress", "dropLat", "dropLng"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("btnAddDrop").click();
      }
    });
  });
  setupPlaceSearch("pickup", (place) => {
    setPickup(place.lat, place.lng, placeAddress(place));
    map.setView([place.lat, place.lng], 14);
  });
  setupPlaceSearch("drop", (place) => {
    addDrop(place.lat, place.lng, placeAddress(place));
    map.panTo([place.lat, place.lng]);
  });
  document.getElementById("locationForm").addEventListener("submit", onFormSubmit);
  document.getElementById("btnCancel").addEventListener("click", resetForm);

  // Auto-set pickup marker when user types valid lat/lng
  const pickupLatInput = document.getElementById("pickupLat");
  const pickupLngInput = document.getElementById("pickupLng");
  function onPickupCoordsInput() {
    const lat = parseFloat(pickupLatInput.value);
    const lng = parseFloat(pickupLngInput.value);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      setPickup(lat, lng);
      map.setView([lat, lng], 14);
    }
  }
  pickupLatInput.addEventListener("change", onPickupCoordsInput);
  pickupLngInput.addEventListener("change", onPickupCoordsInput);

  loadSavedLocations();
});

// ── Place Search (geocoding) ─────────────────────────────────────────────

const SOURCE_LABELS = {
  coordinates: "Coordinates",
  google_maps_link: "Google Maps link",
  google_places: "Google Places",
  nominatim: "OpenStreetMap",
};

/** Address to store for a geocoded place: include the place name if the address lacks it. */
function placeAddress(place) {
  return place.address.startsWith(place.name) ? place.address : `${place.name}, ${place.address}`;
}

/**
 * Wire up a "Find place" box (ids: <prefix>Search, btn<Prefix>Search, <prefix>Results).
 * A single match is applied immediately; several matches are listed to pick from.
 */
function setupPlaceSearch(prefix, onPick) {
  const input = document.getElementById(`${prefix}Search`);
  const button = document.getElementById(`btn${prefix[0].toUpperCase()}${prefix.slice(1)}Search`);
  const results = document.getElementById(`${prefix}Results`);

  const pick = (place) => {
    results.innerHTML = "";
    input.value = "";
    onPick(place);
  };

  async function search() {
    const q = input.value.trim();
    if (q.length < 2) return;
    results.innerHTML = '<div class="search-status">Searching…</div>';
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.statusText);

      if (data.length === 0) {
        results.innerHTML =
          '<div class="search-status">No match. Try a nearby area/street, or paste the place\'s Google Maps link.</div>';
        return;
      }
      if (data.length === 1) {
        pick(data[0]);
        toast(`Found: ${data[0].name}`, "success");
        return;
      }
      results.innerHTML = "";
      data.forEach((place) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "search-result";
        btn.innerHTML =
          `<div class="result-name">${escapeHtml(place.name)}</div>` +
          `<div class="result-meta">${place.lat.toFixed(5)}, ${place.lng.toFixed(5)} · ` +
          `${SOURCE_LABELS[place.source] || place.source} · ${escapeHtml(place.address)}</div>`;
        btn.addEventListener("click", () => pick(place));
        results.appendChild(btn);
      });
    } catch (err) {
      results.innerHTML = "";
      toast("Place search failed: " + err.message, "error");
    }
  }

  button.addEventListener("click", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      search();
    }
  });
}

// ── OSRM Routing ─────────────────────────────────────────────────────────

/**
 * Fetch a driving route from OSRM between two points.
 * Returns { coords: [[lat,lng],...], distance_km, duration_min } or null.
 */
async function fetchRoute(fromLat, fromLng, toLat, toLng) {
  try {
    const url = `${OSRM}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
      return null;
    }

    const route = data.routes[0];
    // OSRM returns [lng, lat] — flip to [lat, lng] for Leaflet
    const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    return {
      coords,
      distance_km: +(route.distance / 1000).toFixed(2),
      duration_min: +(route.duration / 60).toFixed(1),
    };
  } catch (err) {
    console.warn("OSRM routing failed:", err);
    return null;
  }
}

/**
 * Draw a route polyline on the given layer group.
 * Returns the polyline layer so it can be removed later.
 */
function drawRoute(coords, layerGroup, color = "#6c63ff", info = null) {
  // Animated route line (thicker glow behind + solid on top)
  const glow = L.polyline(coords, {
    color,
    weight: 7,
    opacity: 0.2,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(layerGroup);

  const line = L.polyline(coords, {
    color,
    weight: 3,
    opacity: 0.85,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(layerGroup);

  if (info) {
    line.bindPopup(info);
  }

  // Return both layers for cleanup
  return { glow, line };
}

// ── Click Mode ───────────────────────────────────────────────────────────
function setClickMode(mode) {
  clickMode = mode;
  removeBanner();
  const banner = document.createElement("div");
  banner.id = "clickBanner";
  banner.className = `click-mode-banner ${mode}`;
  banner.textContent =
    mode === "pickup"
      ? "🎯 Click the map to set pickup location"
      : "📍 Click the map to add a drop location";
  document.getElementById("mapContainer").appendChild(banner);
}

function removeBanner() {
  const existing = document.getElementById("clickBanner");
  if (existing) existing.remove();
}

// ── Map Click ────────────────────────────────────────────────────────────
function onMapClick(e) {
  if (!clickMode) return;
  const { lat, lng } = e.latlng;

  if (clickMode === "pickup") {
    setPickup(lat, lng);
  } else if (clickMode === "drop") {
    addDrop(lat, lng);
  }

  clickMode = null;
  removeBanner();
}

// ── Pickup ───────────────────────────────────────────────────────────────
function setPickup(lat, lng, address = null) {
  document.getElementById("pickupLat").value = lat.toFixed(6);
  document.getElementById("pickupLng").value = lng.toFixed(6);
  document.getElementById("pickupAddress").value = address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  // Remove old marker/circle
  if (pickupMarker) allMarkerLayers.removeLayer(pickupMarker);
  if (pickupCircle) allMarkerLayers.removeLayer(pickupCircle);

  pickupMarker = L.marker([lat, lng], { icon: pickupIcon, draggable: true })
    .bindPopup("<strong>Pickup</strong>")
    .addTo(allMarkerLayers);

  pickupMarker.on("dragend", (e) => {
    const pos = e.target.getLatLng();
    setPickup(pos.lat, pos.lng);
    // Re-route all existing drops
    rerouteAllDrops();
  });

  // 50 km radius circle
  pickupCircle = L.circle([lat, lng], {
    radius: MAX_RANGE_KM * 1000,
    color: "#6c63ff",
    fillColor: "#6c63ff",
    fillOpacity: 0.06,
    weight: 1.5,
    dashArray: "8 4",
  }).addTo(allMarkerLayers);

  // Re-validate & re-route existing drops
  updateDropDistances();
  rerouteAllDrops();
  toast("Pickup location set", "success");
}

// ── Drops ────────────────────────────────────────────────────────────────
async function addDrop(lat, lng, address = null) {
  const pickupLat = parseFloat(document.getElementById("pickupLat").value);
  const pickupLng = parseFloat(document.getElementById("pickupLng").value);

  const dist = isNaN(pickupLat) ? null : haversine(pickupLat, pickupLng, lat, lng);

  const drop = {
    address: address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    lat,
    lng,
    distance_km: dist,
    route_km: null,
    route_min: null,
  };
  drops.push(drop);

  const marker = L.marker([lat, lng], { icon: dropIcon, draggable: true })
    .bindPopup(`<strong>Drop #${drops.length}</strong><br>${drop.address}`)
    .addTo(allMarkerLayers);

  const idx = drops.length - 1;
  marker.on("dragend", async (e) => {
    const pos = e.target.getLatLng();
    drops[idx].lat = pos.lat;
    drops[idx].lng = pos.lng;
    drops[idx].address = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
    updateDropDistances();
    // Re-route this single drop
    await routeSingleDrop(idx);
    renderDropsList();
  });

  dropMarkers.push(marker);

  // Fetch driving route from pickup to this drop
  if (!isNaN(pickupLat)) {
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const routeData = await fetchRoute(pickupLat, pickupLng, lat, lng);

    if (routeData) {
      drop.route_km = routeData.distance_km;
      drop.route_min = routeData.duration_min;

      const popupInfo = `
        <strong>Route to Drop #${idx + 1}</strong><br>
        🛣️ ${routeData.distance_km} km<br>
        ⏱️ ${routeData.duration_min} min
      `;
      const routeLayers = drawRoute(routeData.coords, allMarkerLayers, color, popupInfo);
      marker._routeLayers = routeLayers;

      marker.setPopupContent(`
        <strong>Drop #${idx + 1}</strong><br>
        ${drop.address}<br>
        🛣️ <strong>${routeData.distance_km} km</strong> · ⏱️ ${routeData.duration_min} min
      `);
    } else {
      // Fallback: draw straight dashed line if OSRM fails
      const line = L.polyline(
        [[pickupLat, pickupLng], [lat, lng]],
        { color, weight: 2, dashArray: "6 4", opacity: 0.6 }
      ).addTo(allMarkerLayers);
      marker._routeLayers = { line, glow: null };
    }
  }

  renderDropsList();
  const routeInfo = drop.route_km ? ` · 🛣️ ${drop.route_km} km` : "";
  toast(
    `Drop #${drops.length} added (${dist ? dist.toFixed(1) + " km straight" + routeInfo : "set pickup first"})`,
    dist && dist > MAX_RANGE_KM ? "error" : "success"
  );
}

/** Re-route a single drop after it's been dragged. */
async function routeSingleDrop(idx) {
  const pickupLat = parseFloat(document.getElementById("pickupLat").value);
  const pickupLng = parseFloat(document.getElementById("pickupLng").value);
  if (isNaN(pickupLat)) return;

  const marker = dropMarkers[idx];
  const drop = drops[idx];

  // Remove old route layers
  if (marker._routeLayers) {
    if (marker._routeLayers.glow) allMarkerLayers.removeLayer(marker._routeLayers.glow);
    if (marker._routeLayers.line) allMarkerLayers.removeLayer(marker._routeLayers.line);
  }

  const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
  const routeData = await fetchRoute(pickupLat, pickupLng, drop.lat, drop.lng);

  if (routeData) {
    drop.route_km = routeData.distance_km;
    drop.route_min = routeData.duration_min;

    const popupInfo = `
      <strong>Route to Drop #${idx + 1}</strong><br>
      🛣️ ${routeData.distance_km} km<br>
      ⏱️ ${routeData.duration_min} min
    `;
    marker._routeLayers = drawRoute(routeData.coords, allMarkerLayers, color, popupInfo);

    marker.setPopupContent(`
      <strong>Drop #${idx + 1}</strong><br>
      ${drop.address}<br>
      🛣️ <strong>${routeData.distance_km} km</strong> · ⏱️ ${routeData.duration_min} min
    `);
  } else {
    const line = L.polyline(
      [[pickupLat, pickupLng], [drop.lat, drop.lng]],
      { color, weight: 2, dashArray: "6 4", opacity: 0.6 }
    ).addTo(allMarkerLayers);
    marker._routeLayers = { line, glow: null };
    drop.route_km = null;
    drop.route_min = null;
  }
}

/** Re-route all drops (called when pickup is moved). */
async function rerouteAllDrops() {
  for (let i = 0; i < drops.length; i++) {
    await routeSingleDrop(i);
  }
  renderDropsList();
}

function removeDrop(idx) {
  drops.splice(idx, 1);
  const marker = dropMarkers.splice(idx, 1)[0];
  if (marker._routeLayers) {
    if (marker._routeLayers.glow) allMarkerLayers.removeLayer(marker._routeLayers.glow);
    if (marker._routeLayers.line) allMarkerLayers.removeLayer(marker._routeLayers.line);
  }
  allMarkerLayers.removeLayer(marker);
  renderDropsList();
}

function updateDropDistances() {
  const pickupLat = parseFloat(document.getElementById("pickupLat").value);
  const pickupLng = parseFloat(document.getElementById("pickupLng").value);
  if (isNaN(pickupLat)) return;

  drops.forEach((d) => {
    d.distance_km = haversine(pickupLat, pickupLng, d.lat, d.lng);
  });
  renderDropsList();
}

function renderDropsList() {
  scheduleShortestPath();
  const container = document.getElementById("dropsList");
  document.getElementById("dropCount").textContent = drops.length;

  if (drops.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = drops
    .map((d, i) => {
      const ok = d.distance_km !== null && d.distance_km <= MAX_RANGE_KM;
      const distText = d.distance_km !== null ? `${d.distance_km.toFixed(1)} km` : "—";
      const routeText = d.route_km !== null
        ? `🛣️ ${d.route_km} km · ⏱️ ${d.route_min} min`
        : "";
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      return `
        <div class="drop-item">
          <div class="drop-color-dot" style="background:${color};"></div>
          <div class="drop-info">
            <div class="drop-address">#${i + 1} — ${d.address}</div>
            <div class="drop-coords">${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}</div>
            ${routeText ? `<div class="drop-route">${routeText}</div>` : ""}
          </div>
          <span class="drop-distance ${d.distance_km !== null ? (ok ? "ok" : "over") : ""}">${distText}</span>
          <button type="button" class="btn btn-icon btn-ghost" onclick="removeDrop(${i})">✕</button>
        </div>`;
    })
    .join("");
}

// ── Shortest Path (form) ─────────────────────────────────────────────────

/** Recompute the form's shortest path shortly after the last change. */
function scheduleShortestPath() {
  clearTimeout(shortestTimer);
  shortestTimer = setTimeout(renderShortestPath, 300);
}

/**
 * For the group being created/edited: find the shortest path that starts at
 * the pickup and visits every drop (all drop orders compared), and draw it in
 * SHORTEST_COLOR above the individual pickup → drop routes.
 */
async function renderShortestPath() {
  const seq = ++shortestSeq;
  shortestLayer.clearLayers();
  const info = document.getElementById("shortestInfo");

  const pickupLat = parseFloat(document.getElementById("pickupLat").value);
  const pickupLng = parseFloat(document.getElementById("pickupLng").value);
  if (isNaN(pickupLat) || isNaN(pickupLng) || drops.length === 0) {
    info.style.display = "none";
    return;
  }

  info.style.display = "";
  info.textContent = "Finding shortest path…";

  const points = [
    { lat: pickupLat, lng: pickupLng, kind: "pickup" },
    ...drops.map((d) => ({ lat: d.lat, lng: d.lng, kind: "drop" })),
  ];
  const { matrix, road } = await fetchDistanceMatrix(points);
  if (seq !== shortestSeq) return; // form changed meanwhile
  const plan = planRoute(points, matrix, points.map((_, i) => i));
  const ordered = plan.order.map((i) => points[i]);

  const route = await fetchMultiStopRoute(ordered);
  if (seq !== shortestSeq) return;

  const coords = route ? route.coords : ordered.map((p) => [p.lat, p.lng]);
  const opts = { pane: "shortestPane", lineCap: "round", lineJoin: "round" };
  L.polyline(coords, { ...opts, color: "#fff", weight: 9, opacity: 0.9 }).addTo(shortestLayer);
  L.polyline(coords, { ...opts, color: SHORTEST_COLOR, weight: 5, opacity: 1, dashArray: route ? null : "10 6" })
    .bindPopup("<strong>Shortest path</strong>")
    .addTo(shortestLayer);

  // plan.order holds point indices; drop #n is point index n
  const visitOrder = ["Pickup", ...plan.order.slice(1).map((i) => `#${i}`)].join(" → ");
  const totals = route
    ? `${route.distance_km} km · ${route.duration_min} min`
    : `≈ ${(plan.cost / 1000).toFixed(2)} km (${road ? "road" : "straight-line"} estimate)`;
  const exact = drops.length <= EXACT_MAX_STOPS;
  info.innerHTML =
    `<span class="shortest-swatch"></span><strong>Shortest path</strong> · ${escapeHtml(totals)}<br>` +
    `<span class="trip-note">${escapeHtml(visitOrder)}` +
    `${exact ? "" : " (approximate — too many drops to compare every order)"}</span>`;
}

// ── Form Submit ──────────────────────────────────────────────────────────
async function onFormSubmit(e) {
  e.preventDefault();

  const label = document.getElementById("labelInput").value.trim();
  const pickupAddr = document.getElementById("pickupAddress").value.trim();
  const pickupLat = parseFloat(document.getElementById("pickupLat").value);
  const pickupLng = parseFloat(document.getElementById("pickupLng").value);

  if (!label || !pickupAddr || isNaN(pickupLat) || isNaN(pickupLng)) {
    toast("Please fill in all pickup fields", "error");
    return;
  }
  if (drops.length === 0) {
    toast("Add at least one drop location", "error");
    return;
  }

  const body = {
    label,
    pickup: { address: pickupAddr, lat: pickupLat, lng: pickupLng },
    drops: drops.map((d) => ({ address: d.address, lat: d.lat, lng: d.lng })),
  };

  try {
    const url = editingId ? `${API}/${editingId}` : API;
    const method = editingId ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.validation_errors && data.validation_errors.length > 0) {
      const msgs = data.validation_errors.map((e) => e.message).join("\n");
      toast(`Range errors:\n${msgs}`, "error");
      return;
    }

    toast(data.message || "Saved!", "success");
    resetForm();
    loadSavedLocations();
  } catch (err) {
    toast("Network error: " + err.message, "error");
  }
}

// ── Load Saved Locations ─────────────────────────────────────────────────
async function loadSavedLocations() {
  try {
    const res = await fetch(API);
    const locations = await res.json();
    renderSavedList(locations);
    renderSavedMarkers(locations);
    lastLocations = locations;
    renderBatchRoutes(locations);
  } catch (err) {
    console.error("Failed to load locations:", err);
  }
}

function renderSavedList(locations) {
  const container = document.getElementById("savedList");
  if (locations.length === 0) {
    container.innerHTML = '<p class="empty-state">No location groups yet. Create one above!</p>';
    return;
  }

  container.innerHTML = locations
    .map((loc) => {
      const date = new Date(loc.created_at).toLocaleDateString();
      return `
        <div class="saved-card" onclick="focusLocation('${loc.id}')">
          <div class="card-header">
            <span class="card-label">${loc.label}</span>
            <div class="card-actions">
              <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); editLocation('${loc.id}')">✏️</button>
              <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); deleteLocation('${loc.id}')">🗑️</button>
            </div>
          </div>
          <div class="card-meta">
            <span>🟢 ${loc.pickup.address}</span>
            <span>🔴 ${loc.drops.length} drop${loc.drops.length > 1 ? "s" : ""}</span>
            <span>📅 ${date}</span>
          </div>
        </div>`;
    })
    .join("");
}

/** Render saved location markers with driving routes fetched from OSRM. */
async function renderSavedMarkers(locations) {
  // Clear old saved markers
  Object.values(savedGroupLayers).forEach((lg) => lg.remove());
  savedGroupLayers = {};

  for (const loc of locations) {
    const group = L.layerGroup();

    const pm = L.marker([loc.pickup.lat, loc.pickup.lng], { icon: savedPickupIcon })
      .bindPopup(`<strong>${loc.label}</strong><br>Pickup: ${loc.pickup.address}`);
    group.addLayer(pm);

    for (let i = 0; i < loc.drops.length; i++) {
      const d = loc.drops[i];
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length];

      const dm = L.marker([d.lat, d.lng], { icon: savedDropIcon });
      group.addLayer(dm);

      // Fetch driving route
      const routeData = await fetchRoute(loc.pickup.lat, loc.pickup.lng, d.lat, d.lng);

      if (routeData) {
        const popupInfo = `
          <strong>${loc.label}</strong><br>
          Drop #${i + 1}: ${d.address}<br>
          🛣️ ${routeData.distance_km} km · ⏱️ ${routeData.duration_min} min
        `;
        dm.bindPopup(popupInfo);
        drawRoute(routeData.coords, group, color, popupInfo);
      } else {
        dm.bindPopup(`<strong>${loc.label}</strong><br>Drop #${i + 1}: ${d.address}<br>${d.distance_km?.toFixed(1) ?? "—"} km`);
        // Fallback straight line
        const line = L.polyline(
          [[loc.pickup.lat, loc.pickup.lng], [d.lat, d.lng]],
          { color, weight: 2, dashArray: "4 4", opacity: 0.4 }
        );
        group.addLayer(line);
      }
    }

    group.addTo(map);
    savedGroupLayers[loc.id] = group;
  }
}

// ── Batch Routes ─────────────────────────────────────────────────────────

const BATCH_MAX_PICKUPS = 3;
const BATCH_MAX_DROPS = 3;
const BATCH_COLORS = ["#0e7490", "#be185d", "#4d7c0f", "#b45309", "#6d28d9", "#0369a1"];

/**
 * Flatten saved groups into points and "units". A unit is one pickup plus the
 * drops that travel with it, and is never split across batches. Groups with
 * more than BATCH_MAX_DROPS drops are chunked, so their pickup is visited once
 * per chunk.
 * Point: { lat, lng, kind: 'pickup'|'drop', name }. Unit: { pickup, drops: [pointIdx] }.
 */
function buildUnits(locations) {
  const points = [];
  const units = [];
  for (const loc of locations) {
    for (let c = 0; c < loc.drops.length; c += BATCH_MAX_DROPS) {
      const pickup = points.push({
        lat: loc.pickup.lat, lng: loc.pickup.lng, kind: "pickup", name: `${loc.label} — Pickup`,
      }) - 1;
      const drops = loc.drops.slice(c, c + BATCH_MAX_DROPS).map((d, i) =>
        points.push({ lat: d.lat, lng: d.lng, kind: "drop", name: `${loc.label} — Drop #${c + i + 1}` }) - 1
      );
      units.push({ pickup, drops });
    }
  }
  return { points, units };
}

const OSRM_BASE = OSRM.replace(/\/route\/v1\/driving$/, "");
const EXACT_MAX_STOPS = 12; // compare every order up to this many stops (work grows as n² · 2ⁿ)

/**
 * Road distance matrix (metres) between all points via OSRM's table service.
 * Falls back to straight-line distances. Returns { matrix, road }.
 */
async function fetchDistanceMatrix(points) {
  const straight = (a, b) => haversine(a.lat, a.lng, b.lat, b.lng) * 1000;
  try {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetch(`${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=distance`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.distances) throw new Error(data.message || data.code);
    // Unroutable pairs come back as null — use straight-line distance for those
    const matrix = data.distances.map((row, i) =>
      row.map((d, j) => d ?? straight(points[i], points[j]))
    );
    return { matrix, road: true };
  } catch (err) {
    console.warn("OSRM table failed, using straight-line distances:", err);
    return { matrix: points.map((a) => points.map((b) => straight(a, b))), road: false };
  }
}

/** Fetch the driving route that visits `points` in the given order. */
async function fetchMultiStopRoute(points) {
  try {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetch(`${OSRM}/${coordStr}?overview=full&geometries=geojson`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;
    const route = data.routes[0];
    return {
      coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distance_km: +(route.distance / 1000).toFixed(2),
      duration_min: +(route.duration / 60).toFixed(1),
    };
  } catch (err) {
    console.warn("OSRM multi-stop route failed:", err);
    return null;
  }
}

/**
 * Shortest open path that starts at `start` and visits every index in `nodes`.
 * Returns the best path for EACH possible end node: [{ end, cost, path }].
 * Compares every possible order exactly (Held-Karp dynamic programming).
 */
function shortestPathsByEnd(dist, start, nodes) {
  const n = nodes.length;
  if (n === 0) return [{ end: start, cost: 0, path: [start] }];
  if (n > EXACT_MAX_STOPS) {
    // Too many orders to compare exactly — greedy nearest-neighbour instead
    const path = [start];
    let cost = 0;
    const left = new Set(nodes);
    while (left.size) {
      const cur = path[path.length - 1];
      let next = null;
      for (const k of left) if (next === null || dist[cur][k] < dist[cur][next]) next = k;
      cost += dist[cur][next];
      path.push(next);
      left.delete(next);
    }
    return [{ end: path[path.length - 1], cost, path }];
  }

  const full = (1 << n) - 1;
  // dp[mask * n + j] = cheapest start → (all nodes in mask) path ending at nodes[j]
  const dp = new Float64Array((full + 1) * n).fill(Infinity);
  const parent = new Int8Array((full + 1) * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = dist[start][nodes[j]];

  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      const cur = dp[mask * n + j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const idx = (mask | (1 << k)) * n + k;
        const cost = cur + dist[nodes[j]][nodes[k]];
        if (cost < dp[idx]) {
          dp[idx] = cost;
          parent[idx] = j;
        }
      }
    }
  }

  return nodes.map((end, j) => {
    const path = [];
    let mask = full;
    let k = j;
    while (k !== -1) {
      path.push(nodes[k]);
      const prev = parent[mask * n + k];
      mask ^= 1 << k;
      k = prev;
    }
    path.push(start);
    return { end, cost: dp[full * n + j], path: path.reverse() };
  });
}

/**
 * Shortest route over the given point indices: pickups first, then drops.
 * Every pickup is tried as the start; from each possible last pickup every
 * drop order is compared, and the drop finishing the shortest path is the end.
 */
function planRoute(points, dist, indices) {
  const pickups = indices.filter((i) => points[i].kind === "pickup");
  const drops = indices.filter((i) => points[i].kind === "drop");
  let best = null;
  for (const start of pickups) {
    const others = pickups.filter((i) => i !== start);
    for (const pk of shortestPathsByEnd(dist, start, others)) {
      for (const dr of shortestPathsByEnd(dist, pk.end, drops)) {
        const cost = pk.cost + dr.cost;
        if (!best || cost < best.cost) {
          best = { cost, order: [...pk.path, ...dr.path.slice(1)], lastPickup: pk.end };
        }
      }
    }
  }
  return best;
}

/**
 * Split all units into batches of at most BATCH_MAX_PICKUPS pickups and
 * BATCH_MAX_DROPS drops. Batches are formed one at a time and never share a unit:
 *   1. Seed with the unit holding the farthest-apart pickup/drop pair still
 *      left, so outlying points are served first instead of being stranded.
 *   2. Try every combination of remaining units (pickup within MAX_RANGE_KM
 *      of the seed's pickup) that fits the capacity and keep the best:
 *      - prefer "fill": most drops, ties broken by the shortest route
 *        (fewer batches, more driving);
 *      - prefer "distance": lowest route distance per drop
 *        (less driving, more batches).
 *   3. Remove the chosen units and repeat with what is left.
 */
function formBatches(points, dist, units, prefer = "fill") {
  const km = (a, b) => haversine(points[a].lat, points[a].lng, points[b].lat, points[b].lng);
  const dropCount = (combo) => combo.reduce((n, u) => n + units[u].drops.length, 0);
  const fits = (combo) => combo.length <= BATCH_MAX_PICKUPS && dropCount(combo) <= BATCH_MAX_DROPS;

  const remaining = new Set(units.keys());
  const batches = [];

  while (remaining.size) {
    // 1. Seed
    let seed = null;
    let seedDist = -1;
    for (const u of remaining) {
      for (const v of remaining) {
        for (const d of units[v].drops) {
          const k = km(units[u].pickup, d);
          if (k > seedDist) { seedDist = k; seed = u; }
        }
      }
    }

    // 2. Every capacity-fitting combination of nearby units with the seed
    const candidates = [...remaining].filter(
      (u) => u !== seed && km(units[u].pickup, units[seed].pickup) <= MAX_RANGE_KM
    );
    const combos = [[seed]];
    const extend = (combo, from) => {
      for (let i = from; i < candidates.length; i++) {
        const next = [...combo, candidates[i]];
        if (fits(next)) {
          combos.push(next);
          extend(next, i + 1);
        }
      }
    };
    extend([seed], 0);

    let best = null;
    for (const combo of combos) {
      const drops = dropCount(combo);
      if (prefer === "fill" && best && drops < best.drops) continue;
      const plan = planRoute(points, dist, combo.flatMap((u) => [units[u].pickup, ...units[u].drops]));
      const better = !best || (prefer === "distance"
        ? plan.cost / drops < best.plan.cost / best.drops
        : drops > best.drops || plan.cost < best.plan.cost);
      if (better) best = { combo, drops, plan };
    }

    // 3. Lock in this batch
    best.combo.forEach((u) => remaining.delete(u));
    batches.push({ units: best.combo, plan: best.plan });
  }
  return batches;
}

/**
 * Group all saved pickups/drops into batches (max 3 pickups + 3 drops each)
 * and draw each batch's shortest route in its own colour.
 */
async function renderBatchRoutes(locations) {
  tripLayer.clearLayers();
  const seq = ++tripRenderSeq;
  const summary = document.getElementById("tripSummary");
  const info = document.getElementById("tripInfo");

  const { points, units } = buildUnits(locations);
  if (units.length === 0) {
    summary.style.display = "none";
    return;
  }

  summary.style.display = "";
  info.textContent = "Forming batches…";

  const { matrix, road } = await fetchDistanceMatrix(points);
  if (seq !== tripRenderSeq) return; // a newer render has started
  const batches = formBatches(points, matrix, units, document.getElementById("batchMode").value);

  const layers = [];
  const rows = [];
  let totalKm = 0;

  for (let b = 0; b < batches.length; b++) {
    info.textContent = `Routing batch ${b + 1} of ${batches.length}…`;
    const { plan } = batches[b];
    const ordered = plan.order.map((i) => points[i]);
    const route = await fetchMultiStopRoute(ordered);
    if (seq !== tripRenderSeq) return;

    const color = BATCH_COLORS[b % BATCH_COLORS.length];
    const layer = L.featureGroup().addTo(tripLayer);
    layers.push(layer);

    // Route line: real roads from OSRM, or straight segments as a fallback
    const lineOpts = { pane: "tripPane", color, lineCap: "round", lineJoin: "round" };
    if (route) {
      L.polyline(route.coords, { ...lineOpts, weight: 9, opacity: 0.2 }).addTo(layer);
      L.polyline(route.coords, { ...lineOpts, weight: 4, opacity: 0.95 }).addTo(layer);
    } else {
      L.polyline(ordered.map((p) => [p.lat, p.lng]), { ...lineOpts, weight: 3, opacity: 0.8, dashArray: "10 6" })
        .addTo(layer);
    }

    // Stop markers (green = pickup, red = drop), labelled "<batch>·S / 1 / 2 / E"
    const last = ordered.length - 1;
    ordered.forEach((p, n) => {
      const step = n === 0 ? "S" : n === last ? "E" : String(n);
      const tag = n === 0 ? "Start" : n === last ? "End (shortest)" : `Stop ${n}`;
      L.circleMarker([p.lat, p.lng], {
        pane: "tripPane",
        radius: 6,
        color,
        weight: 3,
        fillColor: p.kind === "pickup" ? "#16a34a" : "#dc2626",
        fillOpacity: 1,
      })
        .bindTooltip(`${b + 1}·${step}`, {
          permanent: true,
          direction: "top",
          offset: [0, -8],
          className: `stop-label batch-${b % BATCH_COLORS.length}`,
        })
        .bindPopup(
          `<strong>Batch ${b + 1} — ${tag}</strong><br>${escapeHtml(p.name)}<br>` +
          `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
        )
        .addTo(layer);
    });

    const km = route ? route.distance_km : +(plan.cost / 1000).toFixed(2);
    totalKm += km;
    const pickups = ordered.filter((p) => p.kind === "pickup").length;
    const drops = ordered.length - pickups;
    const time = route ? ` · ${route.duration_min} min` : " (estimate)";
    rows.push(
      `<div class="batch-row" data-batch="${b}">` +
      `<span class="batch-dot" style="background:${color};"></span>` +
      `<div><strong>Batch ${b + 1}</strong> · ${pickups}P / ${drops}D · ${km} km${time}<br>` +
      `<span class="trip-note">${escapeHtml(ordered[0].name)} → ${escapeHtml(ordered[last].name)}</span></div>` +
      `</div>`
    );
  }

  info.innerHTML =
    `${batches.length} batch${batches.length > 1 ? "es" : ""} · max ${BATCH_MAX_PICKUPS} pickups + ` +
    `${BATCH_MAX_DROPS} drops each · ${totalKm.toFixed(2)} km total` +
    (road ? "" : " <span class=\"trip-note\">(straight-line distances)</span>") +
    rows.join("");

  // Click a batch to zoom to it
  info.querySelectorAll(".batch-row").forEach((row) => {
    row.addEventListener("click", () => {
      map.fitBounds(layers[+row.dataset.batch].getBounds().pad(0.2));
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ── Actions ──────────────────────────────────────────────────────────────
function focusLocation(id) {
  const group = savedGroupLayers[id];
  if (group) {
    const bounds = L.featureGroup(group.getLayers().filter((l) => l.getLatLng)).getBounds();
    map.fitBounds(bounds.pad(0.3));
  }
}

async function editLocation(id) {
  try {
    const res = await fetch(`${API}/${id}`);
    const loc = await res.json();

    editingId = id;
    document.getElementById("formTitle").textContent = "Edit Location Group";
    document.getElementById("btnCancel").style.display = "";
    document.getElementById("labelInput").value = loc.label;
    document.getElementById("pickupAddress").value = loc.pickup.address;
    document.getElementById("pickupLat").value = loc.pickup.lat;
    document.getElementById("pickupLng").value = loc.pickup.lng;

    // Set pickup marker on map
    setPickup(loc.pickup.lat, loc.pickup.lng, loc.pickup.address);

    // Clear and reload drops
    clearDropMarkers();
    drops = [];
    for (const d of loc.drops) {
      await addDrop(d.lat, d.lng, d.address);
    }

    // Scroll to top
    document.getElementById("sidebar").scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    toast("Failed to load location: " + err.message, "error");
  }
}

async function deleteLocation(id) {
  if (!confirm("Delete this location group?")) return;
  try {
    await fetch(`${API}/${id}`, { method: "DELETE" });
    toast("Deleted!", "success");
    loadSavedLocations();
  } catch (err) {
    toast("Delete failed: " + err.message, "error");
  }
}

// ── Reset ────────────────────────────────────────────────────────────────
function resetForm() {
  editingId = null;
  document.getElementById("formTitle").textContent = "New Location Group";
  document.getElementById("btnCancel").style.display = "none";
  document.getElementById("locationForm").reset();

  // Clear map layers for form
  if (pickupMarker) { allMarkerLayers.removeLayer(pickupMarker); pickupMarker = null; }
  if (pickupCircle) { allMarkerLayers.removeLayer(pickupCircle); pickupCircle = null; }
  clearDropMarkers();
  drops = [];
  renderDropsList();
  removeBanner();
  clickMode = null;
}

function clearDropMarkers() {
  dropMarkers.forEach((m) => {
    if (m._routeLayers) {
      if (m._routeLayers.glow) allMarkerLayers.removeLayer(m._routeLayers.glow);
      if (m._routeLayers.line) allMarkerLayers.removeLayer(m._routeLayers.line);
    }
    allMarkerLayers.removeLayer(m);
  });
  dropMarkers = [];
}

// ── Haversine ────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Toast ────────────────────────────────────────────────────────────────
function toast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  // Force reflow for animation
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 300);
  }, 3500);
}
