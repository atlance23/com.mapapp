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

const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA0YjU2NDRlNDA5ZDQyMDE5ZTMxNjYyMDdlOTEwZDkyIiwiaCI6Im11cm11cjY0In0="; // REQUIRED

const centerCoordinates = { lat: 38.6251, lng: -90.1868 };
let map;

// ORS free tier safety limit (~6000 km)
const MAX_ROUTE_KM = 5500;

/**
 * ============================
 * MAP INIT
 * ============================
 * Load Google Maps JS with:
 * <script async defer
 *   src="https://maps.googleapis.com/maps/api/js?key=YOUR_KEY&callback=initMap">
 * </script>
 */

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: centerCoordinates,
        zoom: 7,
        mapTypeId: "roadmap"
    });
}

/**
 * ============================
 * DISTANCE HELPER (VALIDATION ONLY)
 * ============================
 */

function haversine(a, b) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;

    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);

    return 2 * R * Math.asin(Math.sqrt(
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) *
        Math.cos(toRad(b.lat)) *
        Math.sin(dLng / 2) ** 2
    ));
}

/**
 * ============================
 * OPENROUTESERVICE ROUTING
 * ============================
 */

async function routeWithORS(source, dest) {
    console.info("[ORS] Requesting route");

    console.debug("[DEBUG] Source:", source);
    console.debug("[DEBUG] Destination:", dest);

    const distanceKm = haversine(source, dest) / 1000;
    console.debug("[DEBUG] Straight-line distance (km):", distanceKm);

    if (distanceKm > MAX_ROUTE_KM) {
        throw new Error("Route distance exceeds OpenRouteService free tier limits.");
    }

    const body = {
        coordinates: [
            [source.lng, source.lat],
            [dest.lng, dest.lat]
        ],
        instructions: true,
        geometry: true,
        preference: "fastest"
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
    console.info("[ORS] Route received");
    return data;
}

/**
 * ============================
 * VISUALIZATION
 * ============================
 */

function visualizeORSRoute(geojson) {
    const coords = geojson.features[0].geometry.coordinates.map(
        ([lng, lat]) => ({ lat, lng })
    );

    const poly = new google.maps.Polyline({
        path: coords,
        map,
        strokeColor: "#000",
        strokeWeight: 5
    });

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds);
}

/**
 * ============================
 * TURN-BY-TURN INSTRUCTIONS
 * ============================
 */

function printInstructions(geojson) {
    const steps = geojson.features[0]
        .properties.segments[0].steps;

    console.group("[ORS] Turn-by-turn instructions");
    for (const step of steps) {
        console.log(`${step.instruction} (${step.distance.toFixed(0)} m)`);
    }
    console.groupEnd();
}

/**
 * ============================
 * ENTRY POINT
 * ============================
 */

async function findPath() {
    try {
        const s = document.getElementById("source").value.split(",");
        const d = document.getElementById("destination").value.split(",");

        const source = { lat: +s[0], lng: +s[1] };
        const dest = { lat: +d[0], lng: +d[1] };

        console.info("[APP] Starting route");

        const geojson = await routeWithORS(source, dest);

        visualizeORSRoute(geojson);
        printInstructions(geojson);

        console.info("[APP] Routing complete");
    } catch (e) {
        console.error("[APP] Routing failed", e);
        alert(e.message);
    }
}