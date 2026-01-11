/**
 *  ===============================
 *  ####### MAP APPLICATION #######
 *  ===============================
 *  Current Version: v1.0.0
 *  By: @atlance23
 */

/**
 *  ==============================
 *  ##### INITIALIZE & SETUP #####
 *  ==============================
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

const INSTRUCTIONS = true;
const ORS_URI = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA0YjU2NDRlNDA5ZDQyMDE5ZTMxNjYyMDdlOTEwZDkyIiwiaCI6Im11cm11cjY0In0=";
const RENDER_INTERVAL_MS = 100;
const SMOOTHING = 0.15;
const STEP_ARRIVAL_METERS = 25;
const REROUTE_THRESHOLD_METERS = 80;
const METERS_PER_MILE = 1609.344;
const CENTER_COORDINATES = { lat: 38.6251, lng: -90.1868 };

let map;
let watchId;
let renderTimer;
let routePolyline;
let navSteps = [];
let routeCoords = [];
let currentStepIndex = 0;
let userAdvancedMarker;
let accuracyCircle;
let lastFix = null;
let lastFixTime = 0;
let displayedPosition = null;
let rerouting = false;
let lastRerouteTime = 0;
let lastNearestIndex = 0;
let prevFixTime = 0;
let lastVelocity = null;


/**
 *  =============================
 *  #### CORE ROUTING ENGINE ####
 *  =============================
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: CENTER_COORDINATES,
        zoom: 18,
        tilt: 0,
        mapTypeId: "roadmap",
        mapId: "62adc9fbef5b7a4a72c5cb13"
    });
}

async function findPath() {
    try {
        const src = await getPlaceCoordinates(document.getElementById("src-address"));
        const dst = await getPlaceCoordinates(document.getElementById("dst-address"));
        const geojson = await fetchORSData(src, dst);
        startNav(geojson);
    } catch (e) {
        alert(e.message);
    }
};

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

async function fetchORSData(src, dst) {

    // Create Request Body
    const body = {
        coordinates: [
            [src.lng, src.lat],
            [dst.lng, dst.lat]
        ],
        radiuses: [
            1500,
            1500
        ],
        instructions: INSTRUCTIONS,
        preference: "fastest",
        options: [

        ]
    };

    // Send POST Request
    const res = await fetch(
        `"${ORS_URI}"`,
        {
            method: "POST",
            headers: {
                Authorization: ORS_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    // Error Checking
    if (!res.ok) {
        throw new Error(`[APP] Routing Failed. Status code: "[${res.status}] ${res.statusText}"`)
    };

    const data = await res.json();
    return data;
};

function startNav(geojson) {
    // Index Nav Steps
    navSteps = geojson.features[0].properties.segments[0].steps;
    currentStepIndex = 0;

    // Generate Coordinates
    routeCoords = geojson.features[0].geometry.coordinates.map(
        ([lng, lat]) => ({ lat, lng })
    );

    // Call Core Rendering Functions
    renderRoute(routeCoords);
    if (!watchId) startGPS();
    $(document).ready(function(){
        setTimeout(updateInstructionUI, 1000);
    });
};

function renderRoute(coords) {
    if (routePolyline) routePolyline.setMap(null);

    routePolyline = new google.maps.Polyline({
        path: coords,
        strokeColor: "#1a73e8",
        strokeWeight: 8,
        strokeLinecap: "round",
        map
    });
};


/**
 *  ===============================================
 *  #### GPS + COMPASS + RENDER INITIALIZATION ####
 *  ===============================================
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

function startGPS() {
    watchId = navigator.geolocation.watchPosition(
        pos => {
            const now = performance.now();

            if (lastFix && lastFixTime) {
                const dt = (now - lastFixTime) / 1000;
                if (dt > 0) {
                    lastVelocity = {
                        lat: (pos.coords.latitude - lastFix.lat) / dt,
                        lng: (pos.coords.longitude - lastFix.lng) / dt
                    };
                }
            }

            lastFixTime = now;
            lastFix = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                heading: pos.coords.heading ?? null,
                accuracy: pos.coords.accuracy
            };

            if (!renderTimer) {
                renderTimer = setInterval(() => {
                    if (lastFix) renderFrame(lastFix);
                }, RENDER_INTERVAL_MS);
            }

            // Create Marker
            if (!userAdvancedMarker){
                const marker = document.createElement("div");
                marker.id = "marker";

                userAdvancedMarker = new google.maps.marker.AdvancedMarkerElement({
                    position: lastFix,
                    map,
                    content: marker
                });

                accuracyCircle = new google.maps.Circle({
                    map,
                    center: lastFix,
                    radius: pos.coords.accuracy,
                    fillColor: "#1a73e8",
                    fillOpacity: 0.15,
                    strokeOpacity: 0
                });
            };
        },
        () => alert("Location Permission Required!"),
        {
            enableHighAccuracy: true, 
            maximumAge: 0, 
            timeout: 10000
        }
    );
};


/**
 *  =====================================
 *  ##### CORE MAP RENDERING ENGINE #####
 *  =====================================
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

function renderFrame(fix) {
    if (!displayedPosition) {
        displayedPosition = { ...fix };
    };

    const now = performance.now();
    const dt = prevFixTime ? (now - prevFixTime) : RENDER_INTERVAL_MS;
    prevFixTime = now;

    // Smooth interpolation
    const expected = RENDER_INTERVAL_MS; // expected ms between renders
    const t = Math.min(dt / expected, 1);

    displayedPosition.lat += (fix.lat - displayedPosition.lat) * SMOOTHING * t;
    displayedPosition.lng += (fix.lng - displayedPosition.lng) * SMOOTHING * t;

    if (lastVelocity) {
        displayedPosition.lat += lastVelocity.lat * (dt / 1000);
        displayedPosition.lng += lastVelocity.lng * (dt / 1000);
    }

    userAdvancedMarker.position = displayedPosition;

    accuracyCircle.setCenter(displayedPosition);
    accuracyCircle.setRadius(fix.accuracy);

    let heading = fix.heading;

    if (heading === null && lastVelocity) {
        const speed = Math.hypot(lastVelocity.lat, lastVelocity.lng);
        if (speed > 0.00001) {
            heading = Math.atan2(lastVelocity.lng, lastVelocity.lat) * (180 / Math.PI);
        }
    }

    map.setOptions({
        heading,
        tilt: 45
    });

    if (!map.getBounds()?.contains(displayedPosition)) {
        map.panTo(displayedPosition);
    }

    // Navigation logic uses REAL GPS, not interpolated
    checkRouteProgress(fix);
    checkRouteDeviation(fix);
};


/** 
 *  ===========================
 *  #### ROUTE PROGRESSION ####
 *  ===========================
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

function checkRouteProgress(position) {
    const step = navSteps[currentStepIndex];
    if (!step) return;

    const target = routeCoords[step.way_points[1]];

    const dist = google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(position.lat, position.lng),
        new google.maps.LatLng(target.lat, target.lng)
    );

    if (map.getZoom() !== 18) {
        map.setZoom(18);
    }

    if (dist < STEP_ARRIVAL_METERS) {
        currentStepIndex++;
        updateInstructionUI();
    }
};


/** 
 *  ==================================
 *  #### OPTIMIZED AUTO-REROUTING ####
 *  ================================== 
 *  Updated: @v1.0.0
 *  By: @atlance23
 */

async function checkRouteDeviation(position) {
    if (rerouting || !routeCoords.length) return;

    const offRoute = distanceFromRoute(position);
    if (offRoute < REROUTE_THRESHOLD_METERS) return;

    const now = Date.now();
    const cooldown = offRoute > 120 ? 3000 : 6000; // adaptive cooldown
    if (now - lastRerouteTime < cooldown) return;

    rerouting = true;
    lastRerouteTime = now;

    const dst = routeCoords[routeCoords.length - 1];

    // Fire reroute without blocking UI
    fetchORSData(position, dst)
        .then(geojson => startNav(geojson))
        .catch(e => console.warn("[NAV] Reroute failed", e))
        .finally(() => rerouting = false);
};

function distanceFromRoute(position) {
    let min = Infinity;
    const start = lastNearestIndex;
    const end = Math.min(lastNearestIndex + 20, routeCoords.length - 1);

    for (let i = start; i <= end; i++) {
        const p = routeCoords[i];
        const d = google.maps.geometry.spherical.computeDistanceBetween(
            new google.maps.LatLng(position.lat, position.lng),
            new google.maps.LatLng(p.lat, p.lng)
        );

        if (d < min) {
            min = d;
            lastNearestIndex = i;
        }
    }

    return min;
};


/** 
 *  ==========================
 *  ##### INSTRUCTION UI #####
 *  ==========================
 *  Updated: @v1.0.0 
 *  By: @atlance23
 */

function updateInstructionUI() {
    const instructions = document.getElementById("instructions");
    const distance = document.getElementById("distance");
    const turnIconElement = document.getElementById("turnIcon");

    instructions.innerHTML = "";
    distance.innerHTML = "";
    turnIconElement.innerHTML = ""

    const step = navSteps[currentStepIndex];
    
    // if (!step) {
    //     instructions.innerHTML = "<strong>Destination reached</strong>";
    //     navigator.geolocation.clearWatch(watchId);
    //     stopRenderLoop();
    //     return;
    // }

    turnIconElement.innerHTML = `${turnIcon(step)}`
    instructions.innerHTML = `${step.instruction}`
    distance.innerHTML = `${formatDistance(step.distance)}`;
}

function turnIcon(step) {
    const t = step.instruction.toLowerCase();
    if (t.includes("left")) return `<i class="bi bi-arrow-90deg-left"></i>`;
    if (t.includes("right")) return `<i class="bi bi-arrow-90deg-right"></i>`;
    if (t.includes("exit")) return ``;
    return `<i class="bi bi-arrow-up"></i>`;
};


/**
 * ================================
 * ####### HELPER FUNCTIONS #######
 * ================================
 * Updated: @v1.0.0
 * By: @atlance23
 */

function formatDistance(meters) {
    const miles = meters / METERS_PER_MILE;

    if (miles >= 0.1) {
        return `${miles.toFixed(1)} mi`;
    }

    const feet = meters * 3.28084;
    return `${Math.round(feet)} ft`;

};