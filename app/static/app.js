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
  tripLayer.addTo(map);
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
function setPickup(lat, lng) {
  document.getElementById("pickupLat").value = lat.toFixed(6);
  document.getElementById("pickupLng").value = lng.toFixed(6);
  document.getElementById("pickupAddress").value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

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
    renderStoppageRoute(locations);
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

// ── Stoppage Route ───────────────────────────────────────────────────────

/**
 * Flatten all saved groups into a list of stops.
 * Each stop: { lat, lng, kind: 'pickup'|'drop', name }.
 */
function collectStops(locations) {
  const stops = [];
  for (const loc of locations) {
    stops.push({ lat: loc.pickup.lat, lng: loc.pickup.lng, kind: "pickup", name: `${loc.label} — Pickup` });
    loc.drops.forEach((d, i) => {
      stops.push({ lat: d.lat, lng: d.lng, kind: "drop", name: `${loc.label} — Drop #${i + 1}` });
    });
  }
  return stops;
}

/** Return [pickupIdx, dropIdx] of the pickup/drop pair that are farthest apart. */
function farthestPickupDropPair(stops) {
  let best = null;
  let bestDist = -1;
  stops.forEach((p, pi) => {
    if (p.kind !== "pickup") return;
    stops.forEach((d, di) => {
      if (d.kind !== "drop") return;
      const dist = haversine(p.lat, p.lng, d.lat, d.lng);
      if (dist > bestDist) {
        bestDist = dist;
        best = [pi, di];
      }
    });
  });
  return best;
}

/**
 * Ask OSRM's trip service for the shortest driving order that starts at
 * points[0], ends at points[last] and visits every point in between.
 * Returns { order: [inputIdx,...], coords, distance_km, duration_min } or null.
 */
async function fetchTrip(points) {
  try {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `${OSRM.replace("/route/", "/trip/")}/${coordStr}` +
      "?source=first&destination=last&roundtrip=false&overview=full&geometries=geojson";
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "Ok" || !data.trips || data.trips.length === 0) return null;

    const trip = data.trips[0];
    // waypoints[i].waypoint_index = position of input i within the trip
    const order = data.waypoints
      .map((w, inputIdx) => ({ inputIdx, pos: w.waypoint_index }))
      .sort((a, b) => a.pos - b.pos)
      .map((w) => w.inputIdx);

    return {
      order,
      coords: trip.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distance_km: +(trip.distance / 1000).toFixed(2),
      duration_min: +(trip.duration / 60).toFixed(1),
    };
  } catch (err) {
    console.warn("OSRM trip failed:", err);
    return null;
  }
}

/** Fallback ordering: nearest-neighbour from the first point, last point fixed at the end. */
function nearestNeighbourOrder(points) {
  const last = points.length - 1;
  const remaining = new Set(points.map((_, i) => i).slice(1, last));
  const order = [0];
  while (remaining.size) {
    const cur = points[order[order.length - 1]];
    let next = null;
    let nextDist = Infinity;
    for (const i of remaining) {
      const dist = haversine(cur.lat, cur.lng, points[i].lat, points[i].lng);
      if (dist < nextDist) { nextDist = dist; next = i; }
    }
    order.push(next);
    remaining.delete(next);
  }
  if (last > 0) order.push(last);
  return order;
}

/**
 * Draw a second route across ALL saved points: it starts at the pickup and
 * ends at the drop that are farthest apart, and visits every other saved
 * point as a numbered stoppage in the shortest order found.
 */
async function renderStoppageRoute(locations) {
  tripLayer.clearLayers();
  ++tripRenderSeq;
  const summary = document.getElementById("tripSummary");
  const info = document.getElementById("tripInfo");

  const stops = collectStops(locations);
  const pair = farthestPickupDropPair(stops);
  if (!pair) {
    summary.style.display = "none";
    return;
  }

  // Order the points so the start is first and the end is last
  const [startIdx, endIdx] = pair;
  const points = [
    stops[startIdx],
    ...stops.filter((_, i) => i !== startIdx && i !== endIdx),
    stops[endIdx],
  ];

  summary.style.display = "";
  info.textContent = "Calculating shortest route…";

  const seq = ++tripRenderSeq;
  const trip = await fetchTrip(points);
  if (seq !== tripRenderSeq) return; // a newer render has started
  const order = trip ? trip.order : nearestNeighbourOrder(points);
  const ordered = order.map((i) => points[i]);

  // Route line: real roads from OSRM, or straight segments as a fallback
  const lineOpts = { pane: "tripPane", color: "#0e7490", lineCap: "round", lineJoin: "round" };
  if (trip) {
    L.polyline(trip.coords, { ...lineOpts, weight: 9, opacity: 0.25 }).addTo(tripLayer);
    L.polyline(trip.coords, { ...lineOpts, weight: 4, opacity: 0.95 }).addTo(tripLayer);
  } else {
    L.polyline(ordered.map((p) => [p.lat, p.lng]), { ...lineOpts, weight: 3, opacity: 0.8, dashArray: "10 6" })
      .addTo(tripLayer);
  }

  // Numbered stoppage markers
  ordered.forEach((p, n) => {
    const tag = n === 0 ? "Start" : n === ordered.length - 1 ? "End" : `Stop ${n}`;
    L.circleMarker([p.lat, p.lng], {
      pane: "tripPane",
      radius: 5,
      color: "#fff",
      weight: 2,
      fillColor: "#0e7490",
      fillOpacity: 1,
    })
      .bindTooltip(n === 0 ? "S" : n === ordered.length - 1 ? "E" : String(n), {
        permanent: true,
        direction: "top",
        offset: [0, -8],
        className: "stop-label",
      })
      .bindPopup(`<strong>${tag}</strong><br>${escapeHtml(p.name)}<br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`)
      .addTo(tripLayer);
  });

  const start = ordered[0];
  const end = ordered[ordered.length - 1];
  const totals = trip
    ? `${trip.distance_km} km · ${trip.duration_min} min driving`
    : "Routing unavailable — showing straight-line order";
  info.innerHTML =
    `${escapeHtml(totals)}<br>` +
    `${ordered.length} points · ${Math.max(ordered.length - 2, 0)} stoppages<br>` +
    `Start: ${escapeHtml(start.name)}<br>End: ${escapeHtml(end.name)}`;
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
    setPickup(loc.pickup.lat, loc.pickup.lng);

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
