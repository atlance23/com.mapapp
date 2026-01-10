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

let map;
let userMarker;
let routePolyline;
let navSteps = [];
let currentStepIndex = 0;
let watchId = null;

/** ============================
 * MAP INIT
 * ============================ */

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: CENTER_COORDINATES,
    zoom: 14,
    mapTypeId: "roadmap"
  });
}

/** ============================
 * GEOCODING / INPUT
 * ============================ */

async function getPlaceCoordinates(el) {
  const raw = el.value.trim();

  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(raw)) {
    const [lat, lng] = raw.split(',').map(Number);
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

/** ============================
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
    preference: "fastest"
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

/** ============================
 * NAVIGATION SETUP
 * ============================ */

function startNavigation(geojson) {
  navSteps = geojson.features[0].properties.segments[0].steps;
  currentStepIndex = 0;

  if (routePolyline) routePolyline.setMap(null);

  const coords = geojson.features[0].geometry.coordinates.map(
    ([lng, lat]) => ({ lat, lng })
  );

  routePolyline = new google.maps.Polyline({
    path: coords,
    strokeColor: "#3498db",
    strokeWeight: 5,
    map
  });

  document.getElementById("controls").style.display = "none";
  document.getElementById("instructions").style.display = "block";

  startGPS();
  updateInstruction();
}

/** ============================
 * GPS + REALTIME UPDATES
 * ============================ */

function startGPS() {
  if (!navigator.geolocation) {
    alert("Geolocation not supported");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const here = { lat, lng };

      if (!userMarker) {
        userMarker = new google.maps.Marker({
          position: here,
          map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#1abc9c",
            fillOpacity: 1,
            strokeWeight: 2
          }
        });
      } else {
        userMarker.setPosition(here);
      }

      map.setCenter(here);
      map.setZoom(18);

      checkStepProgress(here);
    },
    err => alert("Location permission required"),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

function stopGPS() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
}

/** ============================
 * STEP TRACKING
 * ============================ */

function checkStepProgress(position) {
  if (!navSteps[currentStepIndex]) return;

  const wp = navSteps[currentStepIndex].way_points;
  const target = routePolyline.getPath().getAt(wp[1]);

  const dist = google.maps.geometry.spherical.computeDistanceBetween(
    new google.maps.LatLng(position.lat, position.lng),
    target
  );

  if (dist < 25) {
    currentStepIndex++;
    updateInstruction();
  }
}

function updateInstruction() {
  const container = document.getElementById("instructions");
  container.innerHTML = "";

  if (!navSteps[currentStepIndex]) {
    container.innerHTML = "<strong>Destination reached</strong>";
    stopGPS();
    return;
  }

  const step = navSteps[currentStepIndex];

  const card = document.createElement("div");
  card.style.fontSize = "1.2rem";
  card.style.padding = "12px";
  card.style.border = "1px solid #ccc";
  card.style.borderRadius = "8px";

  card.innerHTML = `
    <div style="font-size:2rem">${turnIcon(step)}</div>
    <strong>${step.instruction}</strong><br>
    <small>${step.distance.toFixed(0)} m</small>
  `;

  container.appendChild(card);
}

function turnIcon(step) {
  const t = step.instruction.toLowerCase();
  if (t.includes("left")) return "⬅️";
  if (t.includes("right")) return "➡️";
  if (t.includes("exit")) return "⤴️";
  if (t.includes("merge")) return "↗️";
  return "⬆️";
}

/** ============================
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
