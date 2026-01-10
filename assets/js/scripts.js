/**
 * =========================================================
 * GOOGLE MAPS + OPENROUTESERVICE ROUTING (MO + IL)
 * Clean, minimal, quota-safe
 * =========================================================
 */

/**
 * ============================
 * GLOBAL CONFIG
 * ============================
 */

const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA0YjU2NDRlNDA5ZDQyMDE5ZTMxNjYyMDdlOTEwZDkyIiwiaCI6Im11cm11cjY0In0=";

const CENTER_COORDINATES = { lat: 38.6251, lng: -90.1868 };
const MAX_ROUTE_KM = 5500;
const ROUTE_CACHE_PREFIX = "ors_route_";
const DISABLE_ORS_NEAREST = true;

let map;

/**
 * ============================
 * MAP INIT + PLACES CHECK
 * ============================
 */

function initMap() {
    if (!google.maps.places) {
        throw new Error(
            "Google Places library not loaded. " +
            "Add &libraries=places to the Maps JS script tag."
        );
    }

    map = new google.maps.Map(document.getElementById("map"), {
        center: CENTER_COORDINATES,
        zoom: 7,
        mapTypeId: "roadmap"
    });
}

/**
 * ============================
 * PLACE → COORDINATES (NEW API)
 * ============================
 */

async function getPlaceCoordinates(el) {
    // Case 1: New Places API (PlaceAutocompleteElement-style)
    if (el.value && typeof el.value === "object" && el.value.location) {
        return {
            lat: el.value.location.lat,
            lng: el.value.location.lng
        };
    }

    const raw = el.value.trim();

    // Case 2: User typed "lat,lng"
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) {
        const [lat, lng] = raw.split(",").map(Number);
        return { lat, lng };
    }

    // Case 3: Fallback to geocoding typed address
    const geocoder = new google.maps.Geocoder();

    return new Promise((resolve, reject) => {
        geocoder.geocode({ address: raw }, (results, status) => {
            if (status !== "OK" || !results[0]) {
                reject(new Error("Unable to resolve address"));
                return;
            }

            const loc = results[0].geometry.location;
            resolve({
                lat: loc.lat(),
                lng: loc.lng()
            });
        });
    });
}


/**
 * ============================
 * DISTANCE HELPER
 * ============================
 */

function haversine(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;

    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);

    return 2 * R * Math.asin(Math.sqrt(
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
        Math.sin(dLng / 2) ** 2
    ));
}

/**
 * ============================
 * ROUTE CACHE (LOCALSTORAGE)
 * ============================
 */

function routeCacheKey(a, b) {
    return `${ROUTE_CACHE_PREFIX}${a.lat},${a.lng}_${b.lat},${b.lng}`;
}

function loadCachedRoute(a, b) {
    const raw = localStorage.getItem(routeCacheKey(a, b));
    return raw ? JSON.parse(raw) : null;
}

function saveCachedRoute(a, b, data) {
    try {
        localStorage.setItem(routeCacheKey(a, b), JSON.stringify(data));
    } catch (e) {
        console.warn("[CACHE] Storage full, clearing ORS cache");
        clearORSCache();
    }
}

function clearORSCache() {
    Object.keys(localStorage)
        .filter(k => k.startsWith(ROUTE_CACHE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
}

/**
 * ============================
 * OPENROUTESERVICE ROUTING
 * ============================
 */

async function routeWithORS(source, dest) {
    const cached = loadCachedRoute(source, dest);
    if (cached) {
        console.info("[ORS] Loaded route from cache");
        return cached;
    }

    const distanceKm = haversine(source, dest) / 1000;
    if (distanceKm > MAX_ROUTE_KM) {
        throw new Error("Route distance exceeds OpenRouteService free tier limits");
    }

    const body = {
        ...withSnapRadius(
            [
                [source.lng, source.lat],
                [dest.lng, dest.lat]
            ],
            1500 // snap radius in meters
        ),
        instructions: true,
        geometry: true,
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
                "Authorization": ORS_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`[ORS] ${res.status}: ${txt}`);
    }

    const data = await res.json();
    saveCachedRoute(source, dest, data);

    return data;
}

/**
 * ============================
 * VISUALIZATION (TRAFFIC COLORS)
 * ============================
 */

function visualizeORSRoute(geojson) {
    const feature = geojson.features[0];
    const coords = feature.geometry.coordinates;
    const steps = feature.properties.segments[0].steps;

    for (const step of steps) {
        const speed = step.distance / Math.max(step.duration, 1);

        let color = "#2ecc71"; // fast
        if (speed < 8) color = "#e67e22"; // moderate
        if (speed < 4) color = "#e74c3c"; // slow

        const segmentCoords = coords
            .slice(step.way_points[0], step.way_points[1] + 1)
            .map(([lng, lat]) => ({ lat, lng }));

        new google.maps.Polyline({
            path: segmentCoords,
            map,
            strokeColor: color,
            strokeWeight: 5
        });
    }

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    map.fitBounds(bounds);
}

/**
 * ============================
 * TURN-BY-TURN INSTRUCTIONS
 * ============================
 */

function printInstructions(geojson) {
    const container = document.getElementById("instructions");
    container.innerHTML = "";

    const steps = geojson.features[0]
        .properties
        .segments[0]
        .steps;

    const list = document.createElement("ol");
    list.style.paddingLeft = "20px";

    steps.forEach(step => {
        const item = document.createElement("li");
        item.style.marginBottom = "8px";
        item.textContent = `${step.instruction} (${step.distance.toFixed(0)} m)`;
        list.appendChild(item);
    });

    container.appendChild(list);
}


/**
 * ============================
 * ORS NEAREST-ROAD SNAPPING
 * ============================
 */

async function snapToRoad(coord) {
    if (DISABLE_ORS_NEAREST) {
        throw new Error("ORS nearest disabled (CORS)");
    }

    const url =
        "https://api.openrouteservice.org/v2/directions/driving-car/geojson" +
        `?coordinates=${point.lng},${point.lat}` +
        "&number=1";

    const res = await fetch(url, {
        headers: {
            "Authorization": ORS_API_KEY
        }
    });

    if (!res.ok) {
        throw new Error("[ORS] Failed to snap coordinate to road");
    }

    const data = await res.json();

    if (!data.features || !data.features[0]) {
        throw new Error("[ORS] No routable road found near point");
    }

    const [lng, lat] = data.features[0].geometry.coordinates;
    return { lat, lng };
}

/**
 * ============================
 * ROUTE WITH SNAPPING WRAPPER
 * ============================
 */

async function routeWithORSSnapping(source, dest) {
    
    if (DISABLE_ORS_NEAREST) {
        return routeWithORS(source, dest);
    }

    let snappedSource = source;
    let snappedDest = dest;

    try {
        snappedSource = await snapToRoad(source);
        snappedDest = await snapToRoad(dest);
        console.info("[ORS] Coordinates snapped to road");
    } catch (err) {
        console.warn("[ORS] Snapping failed, falling back to raw coordinates", err);
    }

    return routeWithORS(snappedSource, snappedDest);
}

/**
 * ============================
 * ADD SNAPPING HELPER
 * ============================
 */

function withSnapRadius(coords, meters = 1000) {
    return {
        coordinates: coords,
        radiuses: [meters, meters]
    };
}

/**
 * ============================
 * UI TOGGLE HELPER
 * ============================
 */

function showDirectionsPanel() {
    const controls = document.getElementById("controls");
    const instructions = document.getElementById("instructions");

    if (controls) controls.style.display = "none";
    if (instructions) instructions.style.display = "block";
}

function resetRouteUI() {
    const controls = document.getElementById("controls");
    const instructions = document.getElementById("instructions");

    if (controls) controls.style.display = "block";
    if (instructions) instructions.style.display = "none";
    if (instructions) instructions.innerHTML = "";
}

function addBackButton() {
    const container = document.getElementById("instructions");

    const btn = document.createElement("button");
    btn.textContent = "Edit Route";
    btn.style.marginBottom = "12px";
    btn.onclick = resetRouteUI;

    container.prepend(btn);
}


/**
 * ============================
 * ENTRY POINT
 * ============================
 */

async function findPath() {
    try {
        console.info("[APP] Starting route");

        const sourceEl = document.getElementById("source-address");
        const destEl = document.getElementById("destination-address");

        const source = await getPlaceCoordinates(sourceEl);
        const dest = await getPlaceCoordinates(destEl);

        const geojson = await routeWithORSSnapping(source, dest);

        visualizeORSRoute(geojson);
        printInstructions(geojson);
        addBackButton();
        showDirectionsPanel();

        console.info("[APP] Routing complete");
    } catch (err) {
        console.error("[APP] Routing failed", err);
        alert(err.message);
    }
}
