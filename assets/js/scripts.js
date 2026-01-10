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

function getPlaceCoordinates(el) {
    const place = el.value?.location;

    if (!place) {
        throw new Error("Please select a valid address from autocomplete");
    }

    return {
        lat: place.lat,
        lng: place.lng
    };
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
        throw new Error("Route distance exceeds OpenRouteService free tier limits");
    }

    const body = {
        coordinates: [
            [source.lng, source.lat],
            [dest.lng, dest.lat]
        ],
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
    const steps = geojson.features[0].properties.segments[0].steps;

    console.group("[ORS] Turn-by-turn");
    steps.forEach(step => {
        console.log(`${step.instruction} (${step.distance.toFixed(0)} m)`);
    });
    console.groupEnd();
}

/**
 * ============================
 * ENTRY POINT
 * ============================
 */

async function findPath() {
    try {
        console.info("[APP] Starting route");

        const sourceEl = document.getElementById("source");
        const destEl = document.getElementById("destination");

        const source = getPlaceCoordinates(sourceEl);
        const dest = getPlaceCoordinates(destEl);

        const geojson = await routeWithORS(source, dest);

        visualizeORSRoute(geojson);
        printInstructions(geojson);

        console.info("[APP] Routing complete");
    } catch (err) {
        console.error("[APP] Routing failed", err);
        alert(err.message);
    }
}
