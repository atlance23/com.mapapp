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

const centerCoordinates = { lat: 38.6251, lng: -90.1868 };
let map;

const MAX_ROUTE_KM = 5500;
const ROUTE_CACHE_PREFIX = "ors_route_";

/**
 * ============================
 * MAP INIT + AUTOCOMPLETE
 * ============================
 */

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: centerCoordinates,
        zoom: 7,
        mapTypeId: "roadmap"
    });

    const sourceInput = document.getElementById("source");
    const destInput = document.getElementById("destination");

    new google.maps.places.Autocomplete(sourceInput, { fields: ["geometry", "formatted_address"] });
    new google.maps.places.Autocomplete(destInput, { fields: ["geometry", "formatted_address"] });
}

/**
 * ============================
 * DISTANCE HELPER
 * ============================
 */

function haversine(a, b) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
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
 * ADDRESS → COORDINATES
 * ============================
 */

async function geocodeAddress(input) {
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(input)) {
        const [lat, lng] = input.split(",").map(Number);
        return { lat, lng };
    }

    const geocoder = new google.maps.Geocoder();

    return new Promise((resolve, reject) => {
        geocoder.geocode({ address: input }, (results, status) => {
            if (status !== "OK" || !results[0]) {
                reject(new Error("Unable to geocode address"));
                return;
            }

            const loc = results[0].geometry.location;
            resolve({ lat: loc.lat(), lng: loc.lng() });
        });
    });
}

/**
 * ============================
 * ROUTE CACHE
 * ============================
 */

function routeCacheKey(a, b) {
    return ROUTE_CACHE_PREFIX + `${a.lat},${a.lng}_${b.lat},${b.lng}`;
}

function loadCachedRoute(a, b) {
    const raw = localStorage.getItem(routeCacheKey(a, b));
    return raw ? JSON.parse(raw) : null;
}

function saveCachedRoute(a, b, data) {
    localStorage.setItem(routeCacheKey(a, b), JSON.stringify(data));
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
        throw new Error("Route distance exceeds OpenRouteService free tier limits.");
    }

    const body = {
        coordinates: [[source.lng, source.lat], [dest.lng, dest.lat]],
        instructions: true,
        geometry: true,
        preference: "fastest",
        options: {
            avoid_features: ["ferries"],
            avoid_polygons: null
        }
    };

    const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
        method: "POST",
        headers: {
            "Authorization": ORS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

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
    const coords = geojson.features[0].geometry.coordinates;
    const steps = geojson.features[0].properties.segments[0].steps;

    for (let i = 0; i < steps.length; i++) {
        const speed = steps[i].distance / Math.max(steps[i].duration, 1);
        let color = "#2ecc71"; // fast = green
        if (speed < 8) color = "#e67e22"; // moderate = orange
        if (speed < 4) color = "#e74c3c"; // slow = red

        const segmentCoords = coords.slice(steps[i].way_points[0], steps[i].way_points[1] + 1)
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
 * TURN-BY-TURN
 * ============================
 */

function printInstructions(geojson) {
    const steps = geojson.features[0].properties.segments[0].steps;
    console.group("[ORS] Turn-by-turn");
    steps.forEach(s => console.log(`${s.instruction} (${s.distance.toFixed(0)} m)`));
    console.groupEnd();
}

/**
 * ============================
 * ENTRY POINT
 * ============================
 */

async function findPath() {
    try {
        const sourceInput = document.getElementById("source").value.trim();
        const destInput = document.getElementById("destination").value.trim();

        console.info("[APP] Starting route");

        const source = await geocodeAddress(sourceInput);
        const dest = await geocodeAddress(destInput);

        const geojson = await routeWithORS(source, dest);

        visualizeORSRoute(geojson);
        printInstructions(geojson);

        console.info("[APP] Routing complete");
    } catch (e) {
        console.error("[APP] Routing failed", e);
        alert(e.message);
    }
}
