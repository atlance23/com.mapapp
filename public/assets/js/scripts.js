/**
 * =========================================================
 * LIVE TURN‑BY‑TURN NAVIGATION (GOOGLE MAPS + ORS)
 * One instruction at a time, real‑time GPS updates
 * =========================================================
 */

const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA0YjU2NDRlNDA5ZDQyMDE5ZTMxNjYyMDdlOTEwZDkyIiwiaCI6Im11cm11cjY0In0=";
const CENTER_COORDINATES = { lat: 38.6251, lng: -90.1868 };
const ROUTE_CACHE_PREFIX = "ors_route_";
const GPS_UPDATE_MS = 1000;
const STEP_ARRIVAL_METERS = 25;
const REROUTE_THRESHOLD_METERS = 80;
const METERS_PER_MILE = 1609.344;
const FEET_PER_MILE = 5280;


let map;
let userMarker;
let accuracyCircle;
let routePolyline;
let routeCoords = [];
let navSteps = [];
let currentStepIndex = 0;
let watchId = null;
let rerouting = false;
let lastRerouteTime = 0;

/* ============================
 * HIGH-FREQUENCY RENDER STATE
 * ============================ */

const RENDER_INTERVAL_MS = 100;

let lastFix = null;           // last GPS fix
let lastFixTime = 0;
let displayedPosition = null;
let renderTimer = null;


/* ============================
 * MAP INIT
 * ============================ */

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: CENTER_COORDINATES,
        zoom: 14,
        tilt: 45,
        mapTypeId: "roadmap",
        mapId: "62adc9fbef5b7a4a72c5cb13"
    });
}

let userAdvancedMarker;

/* ============================
 * INPUT → COORDINATES
 * ============================ */

async function getPlaceCoordinates(el) {
  const raw = el.value.trim();

  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(raw)) {
    const [lat, lng] = raw.split(",").map(Number);
    return { lat, lng };
  }

  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ address: raw }, (results, status) => {
      if (status !== "OK" || !results[0]) {
        reject(new Error("Unable to resolve address"));
        return;
      }
      const loc = results[0].geometry.location;
      resolve({ lat: loc.lat(), lng: loc.lng() });
    });
  });
}

/* ============================
 * ROUTING (ORS)
 * ============================ */

function routeCacheKey(a, b) {
  return `${ROUTE_CACHE_PREFIX}${a.lat},${a.lng}_${b.lat},${b.lng}`;
}

async function routeWithORS(source, dest) {
  const key = routeCacheKey(source, dest);
  const cached = localStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const body = {
    coordinates: [[source.lng, source.lat], [dest.lng, dest.lat]],
    radiuses: [1500, 1500],
    instructions: true,
    preference: "fastest",
    options: {
      avoid_features: ["ferries"]
    }
  };

  const res = await fetch(
    "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
    {
      method: "POST",
      headers: {
        Authorization: ORS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) throw new Error("Routing failed");

  const data = await res.json();
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
  return data;
}

/* ============================
 * NAVIGATION SETUP
 * ============================ */

function startNavigation(geojson) {
  navSteps = geojson.features[0].properties.segments[0].steps;
  currentStepIndex = 0;

  routeCoords = geojson.features[0].geometry.coordinates.map(
    ([lng, lat]) => ({ lat, lng })
  );

  drawRoute(routeCoords);

  document.getElementById("controls").style.display = "none";
  document.getElementById("instructions").style.display = "block";

  startGPS();
  updateInstruction();
}

function formatDistance(meters) {
    const miles = meters / METERS_PER_MILE;

    if (miles >= 0.1) {
        return `${miles.toFixed(1)} mi`;
    }

    const feet = meters * 3.28084;
    return `${Math.round(feet)} ft`;
}


/* ============================
 * ROUTE DRAWING (GOOGLE MAPS STYLE)
 * ============================ */

function drawRoute(coords) {
  if (routePolyline) routePolyline.setMap(null);

  new google.maps.Polyline({
    path: coords,
    strokeColor: "#1a73e8",
    strokeWeight: 10,
    map
  });

  routePolyline = new google.maps.Polyline({
    path: coords,
    strokeColor: "#1a73e8",
    strokeWeight: 6,
    strokeLinecap: "round",
    map
  });
}

/* ============================
 * GPS + COMPASS
 * ============================ */

function startGPS() {
    watchId = navigator.geolocation.watchPosition(
        pos => {
            lastFix = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                heading: pos.coords.heading ?? null,
                accuracy: pos.coords.accuracy
            };
            lastFixTime = performance.now();

            // Create marker once
            if (!userAdvancedMarker) {
                const el = document.createElement("div");
                el.style.width = "16px";
                el.style.height = "16px";
                el.style.borderRadius = "50%";
                el.style.background = "#1a73e8";
                el.style.border = "3px solid white";
                el.style.boxShadow = "0 0 8px rgba(26,115,232,.6)";

                userAdvancedMarker = new google.maps.marker.AdvancedMarkerElement({
                    position: lastFix,
                    map,
                    content: el
                });

                accuracyCircle = new google.maps.Circle({
                    map,
                    center: lastFix,
                    radius: pos.coords.accuracy,
                    fillColor: "#1a73e8",
                    fillOpacity: 0.15,
                    strokeOpacity: 0
                });
            }
        },
        () => alert("Location permission required"),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    startRenderLoop();
}


/* ============================
 * 100ms RENDER LOOP
 * ============================ */

function startRenderLoop() {
    if (renderTimer) return;

    renderTimer = setInterval(() => {
        if (!lastFix) return;
        renderFrame(lastFix);
    }, RENDER_INTERVAL_MS);
}

function stopRenderLoop() {
    clearInterval(renderTimer);
    renderTimer = null;
}

function renderFrame(fix) {
    if (!displayedPosition) {
        displayedPosition = { ...fix };
    }

    // Smooth interpolation (Google Maps style)
    displayedPosition.lat += (fix.lat - displayedPosition.lat) * 0.25;
    displayedPosition.lng += (fix.lng - displayedPosition.lng) * 0.25;

    userAdvancedMarker.position = displayedPosition;

    accuracyCircle.setCenter(displayedPosition);
    accuracyCircle.setRadius(fix.accuracy);

    map.setOptions({
        zoom: 18,
        heading: fix.heading ?? map.getHeading() ?? 0,
        tilt: 45
    });

    map.panTo(displayedPosition);

    // 🚨 Navigation logic uses REAL GPS, not interpolated
    checkStepProgress(fix);
    checkOffRoute(fix);
}


/* ============================
 * STEP PROGRESSION
 * ============================ */

function checkStepProgress(position) {
  const step = navSteps[currentStepIndex];
  if (!step) return;

  const target = routeCoords[step.way_points[1]];

  const dist = google.maps.geometry.spherical.computeDistanceBetween(
    new google.maps.LatLng(position.lat, position.lng),
    new google.maps.LatLng(target.lat, target.lng)
  );

  if (dist < STEP_ARRIVAL_METERS) {
    currentStepIndex++;
    updateInstruction();
  }
}

/* ============================
 * AUTO REROUTING
 * ============================ */

async function checkOffRoute(position) {
  if (rerouting) return;

  const now = Date.now();
  if (now - lastRerouteTime < 15000) return; // 15s cooldown

  const nearest = routeCoords.reduce((min, p) => {
    const d = google.maps.geometry.spherical.computeDistanceBetween(
      new google.maps.LatLng(position.lat, position.lng),
      new google.maps.LatLng(p.lat, p.lng)
    );
    return d < min ? d : min;
  }, Infinity);

  if (nearest > REROUTE_THRESHOLD_METERS) {
    rerouting = true;
    lastRerouteTime = now;

    try {
      const dest = routeCoords[routeCoords.length - 1];
      const geojson = await routeWithORS(position, dest);
      startNavigation(geojson);
    } catch (e) {
      console.warn("[NAV] Reroute failed", e);
    } finally {
      rerouting = false;
    }
  }
}


/* ============================
 * INSTRUCTION UI
 * ============================ */

function updateInstruction() {
  const container = document.getElementById("instructions");
  container.innerHTML = "";

  const step = navSteps[currentStepIndex];
  if (!step) {
    container.innerHTML = "<strong>Destination reached</strong>";
    navigator.geolocation.clearWatch(watchId);
    stopRenderLoop();
    return;
  }

  container.innerHTML = `
    <div style="
      padding:16px;
      font-family:Roboto,sans-serif;
      border-radius:12px;
      box-shadow:0 4px 12px rgba(0,0,0,.15)
      background-color: #000 !important;
      color: #FFF !important;
      ">
      <div style="font-size:32px">${turnIcon(step)}</div>
      <strong>${step.instruction}</strong><br>
      <small>${formatDistance(step.distance)}</small>
    </div>
  `;
}

function turnIcon(step) {
  const t = step.instruction.toLowerCase();
  if (t.includes("left")) return "⬅️";
  if (t.includes("right")) return "➡️";
  if (t.includes("exit")) return "⤴️";
  if (t.includes("merge")) return "↗️";
  return "⬆️";
}

/* ============================
 * PWA DEFERRED PROMPT
 * ============================ */

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById("install-btn").style.display = "block";
});

async function installApp() {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;

    document.getElementById("install-btn").style.display = "none";
}


/* ============================
 * ENTRY POINT
 * ============================ */

async function findPath() {
  try {
    const src = await getPlaceCoordinates(document.getElementById("source-address"));
    const dst = await getPlaceCoordinates(document.getElementById("destination-address"));
    const geojson = await routeWithORS(src, dst);
    startNavigation(geojson);
  } catch (e) {
    alert(e.message);
  }
}
