/**
 * =========================================================
 * GOOGLE MAPS + OPENROUTESERVICE ROUTING (MO + IL)
 * Fully corrected, single-file, browser-safe version
 * =========================================================
 */

/*************************
 * GLOBAL CONFIG
 *************************/

const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA0YjU2NDRlNDA5ZDQyMDE5ZTMxNjYyMDdlOTEwZDkyIiwiaCI6Im11cm11cjY0In0=";

const CENTER_COORDINATES = { lat: 38.6251, lng: -90.1868 };
const MAX_ROUTE_KM = 5500;
const ROUTE_CACHE_PREFIX = "ors_route_";
const DISABLE_ORS_NEAREST = true; // must stay true in browser (CORS)

let map;
let routePolylines = [];

/*************************
 * MAP INIT
 *************************/

function initMap() {
    if (!google.maps.places) {
        throw new Error("Google Places library missing (?libraries=places)");
    }

    map = new google.maps.Map(document.getElementById("map"), {
        center: CENTER_COORDINATES,
        zoom: 7,
        mapTypeId: "roadmap"
    });
}

/*************************
 * PLACE → COORDINATES
 *************************/

async function getPlaceCoordinates(el) {
    if (!el || !el.value) {
        throw new Error("Please select a valid address from autocomplete");
    }

    // New Places API selection
    if (typeof el.value === "object" && el.value.location) {
        return {
            lat: el.value.location.lat,
            lng: el.value.location.lng
        };
    }

    const raw = String(el.value).trim();

    // lat,lng manual entry
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) {
        const [lat, lng] = raw.split(",").map(Number);
        return { lat, lng };
    }

    // Fallback geocoder
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

/*************************
 * DISTANCE HELPER
 *************************/

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

/*************************
 * ROUTE CACHE
 *************************/

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
    } catch {
        clearORSCache();
    }
}

function clearORSCache() {
    Object.keys(localStorage)
        .filter(k => k.startsWith(ROUTE_CACHE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
}

/*************************
 * OPENROUTESERVICE ROUTING
 *************************/

function withSnapRadius(coords, meters = 1500) {
    return { coordinates: coords, radiuses: coords.map(() => meters) };
}

async function routeWithORS(source, dest) {
    const cached = loadCachedRoute(source, dest);
    if (cached) return cached;

    const distanceKm = haversine(source, dest) / 1000;
    if (distanceKm > MAX_ROUTE_KM) {
        throw new Error("Route exceeds ORS free tier limits");
    }

    const body = {
        ...withSnapRadius([
            [source.lng, source.lat],
            [dest.lng, dest.lat]
        ]),
        instructions: true,
        geometry: true,
        preference: "fastest",
        options: { avoid_features: ["ferries"] }
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
        throw new Error(`[ORS] ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    saveCachedRoute(source, dest, data);
    return data;
}

async function routeWithORSSnapping(source, dest) {
    // snapping intentionally disabled in browser
    return routeWithORS(source, dest);
}

/*************************
 * MAP VISUALIZATION
 *************************/

function visualizeORSRoute(geojson) {
    routePolylines.forEach(p => p.setMap(null));
    routePolylines = [];

    const coords = geojson.features[0].geometry.coordinates;

    const polyline = new google.maps.Polyline({
        path: coords.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: "#3498db",
        strokeWeight: 5,
        map
    });

    routePolylines.push(polyline);

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    map.fitBounds(bounds);
}

/*************************
 * DIRECTIONS UI
 *************************/

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
    if (instructions) {
        instructions.style.display = "none";
        instructions.innerHTML = "";
    }
}

function turnIcon(step) {
    const t = step.instruction.toLowerCase();
    if (t.includes("left")) return "⬅️";
    if (t.includes("right")) return "➡️";
    if (t.includes("merge")) return "↗️";
    if (t.includes("exit")) return "⤴️";
    if (t.includes("roundabout")) return "⭕";
    return "⬆️";
}

function highwayShield(text) {
    const match = text.match(/(I-|US-|MO-|IL-)?\s?\d+/);
    if (!match) return null;

    const span = document.createElement("span");
    span.textContent = match[0];
    span.style.cssText = "padding:2px 6px;margin-right:6px;border-radius:6px;background:#2c3e50;color:white;font-size:.75rem";
    return span;
}

function groupSteps(steps) {
    const groups = [];
    let current = null;

    for (const step of steps) {
        const road = step.name || "Continue";
        if (!current || current.road !== road) {
            current = { road, steps: [] };
            groups.push(current);
        }
        current.steps.push(step);
    }
    return groups;
}

function renderDirections(geojson) {
    const container = document.getElementById("instructions");
    container.innerHTML = "";

    const segment = geojson.features[0].properties.segments[0];

    container.innerHTML += `
        <strong>Total Distance:</strong> ${(segment.distance / 1000).toFixed(1)} km<br>
        <strong>Estimated Time:</strong> ${(segment.duration / 60).toFixed(0)} min
        <hr>
    `;

    groupSteps(segment.steps).forEach(group => {
        const details = document.createElement("details");
        details.open = true;

        const summary = document.createElement("summary");
        const shield = highwayShield(group.road);
        if (shield) summary.appendChild(shield);
        summary.append(group.road);

        details.appendChild(summary);

        const list = document.createElement("ol");
        list.style.paddingLeft = "20px";

        group.steps.forEach(step => {
            const li = document.createElement("li");
            li.textContent = `${turnIcon(step)} ${step.instruction} (${step.distance.toFixed(0)} m)`;
            list.appendChild(li);
        });

        details.appendChild(list);
        container.appendChild(details);
    });

    const back = document.createElement("button");
    back.textContent = "Edit Route";
    back.style.marginTop = "12px";
    back.onclick = resetRouteUI;
    container.appendChild(back);
}

/*************************
 * ENTRY POINT
 *************************/

async function findPath() {
    try {
        const sourceEl = document.getElementById("source-address");
        const destEl = document.getElementById("destination-address");

        const source = await getPlaceCoordinates(sourceEl);
        const dest = await getPlaceCoordinates(destEl);

        const geojson = await routeWithORSSnapping(source, dest);

        renderDirections(geojson);
        visualizeORSRoute(geojson);
        showDirectionsPanel();

    } catch (err) {
        console.error(err);
        alert(err.message);
    }
}
