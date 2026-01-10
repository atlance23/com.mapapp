/**
 * Constants
 */
const centerCoordinates = { lat: 38.6251, lng: -90.1868 };
let map;

const ROAD_WEIGHTS = {
    motorway: 0.6,
    trunk: 0.7,
    primary: 0.8,
    secondary: 0.9,
    tertiary: 1.0,
    residential: 1.2,
    service: 1.5,
    unclassified: 1.1
};

let cachedOSMData = null;

/**
 * Initialize Google Map
 */
function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: centerCoordinates,
        zoom: 15,
        mapTypeId: "roadmap"
    });
}

/**
 * Fetch OSM data
 */
async function fetchStreetData() {
    const query = `
        [out:json][timeout:25];
        way["highway"]
          (around:600, ${centerCoordinates.lat}, ${centerCoordinates.lng});
        (._;>;);
        out body;
    `;

    const response = await fetch(
        "https://overpass-api.de/api/interpreter",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: "data=" + encodeURIComponent(query)
        }
    );

    if (!response.ok) {
        throw new Error("Overpass error " + response.status);
    }

    return response.json();
}

/**
 * Fetch Street Data with Retry
 */
async function fetchStreetDataWithRetry(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetchStreetData();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}


/**
 * Build graph
 */
function buildGraph(data) {
    const graph = {};
    const nodeCoords = {};

    // Store nodes
    data.elements.forEach(el => {
        if (el.type === "node") {
            nodeCoords[el.id] = { lat: el.lat, lng: el.lon };
        }
    });

    // Build edges
    data.elements.forEach(el => {
        if (el.type === "way" && el.nodes && el.tags?.highway) {
            const weight =
                ROAD_WEIGHTS[el.tags.highway] ?? 1.3;

            const oneway =
                el.tags.oneway === "yes" ||
                el.tags.oneway === "true" ||
                el.tags.oneway === "1";

            for (let i = 0; i < el.nodes.length - 1; i++) {
                const a = el.nodes[i];
                const b = el.nodes[i + 1];

                if (!nodeCoords[a] || !nodeCoords[b]) continue;

                graph[a] ??= {};
                graph[b] ??= {};

                graph[a][b] = weight;

                if (!oneway) {
                    graph[b][a] = weight;
                }
            }
        }
    });

    return { graph, nodeCoords };
}

/**
 * Nearest node lookup
 */
function snapToRoad(lat, lng, nodeCoords, graph) {
    let best = null;
    let min = Infinity;

    for (const id in graph) {
        const n = nodeCoords[id];
        if (!n) continue;

        const d =
            (lat - n.lat) ** 2 +
            (lng - n.lng) ** 2;

        if (d < min) {
            min = d;
            best = id;
        }
    }

    return best;
}

/**
 * Distance & heuristic helpers
 */

function haversine(a, b) {
    const R = 6371000; // meters
    const toRad = x => x * Math.PI / 180;

    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);

    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);

    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(dLng / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(h));
}


/**
 * A* function
 */
function aStar(graph, nodeCoords, start, goal) {
    const open = new Set([start]);
    const cameFrom = {};

    const g = {};
    const f = {};

    for (const v in graph) {
        g[v] = Infinity;
        f[v] = Infinity;
    }

    g[start] = 0;
    f[start] = haversine(nodeCoords[start], nodeCoords[goal]);

    while (open.size) {
        let current = null;
        for (const v of open) {
            if (current === null || f[v] < f[current]) {
                current = v;
            }
        }

        if (current === goal) {
            const path = [];
            let c = current;
            while (c) {
                path.push(c);
                c = cameFrom[c];
            }
            return path.reverse();
        }

        open.delete(current);

        for (const n in graph[current]) {
            const tentative =
                g[current] +
                graph[current][n] *
                haversine(nodeCoords[current], nodeCoords[n]);

            if (tentative < g[n]) {
                cameFrom[n] = current;
                g[n] = tentative;
                f[n] =
                    tentative +
                    haversine(nodeCoords[n], nodeCoords[goal]);

                open.add(n);
            }
        }
    }

    return null;
}

/**
 * Turn By Turn Instructions
 */

function bearing(a, b) {
    const toRad = x => x * Math.PI / 180;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x =
        Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
        Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
        Math.cos(toRad(b.lng - a.lng));

    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function turnDirection(b1, b2) {
    const d = (b2 - b1 + 360) % 360;
    if (d < 30 || d > 330) return "Continue straight";
    if (d < 180) return "Turn right";
    return "Turn left";
}

function buildInstructions(path, nodeCoords) {
    const steps = [];

    for (let i = 1; i < path.length - 1; i++) {
        const a = nodeCoords[path[i - 1]];
        const b = nodeCoords[path[i]];
        const c = nodeCoords[path[i + 1]];

        const b1 = bearing(a, b);
        const b2 = bearing(b, c);

        steps.push(turnDirection(b1, b2));
    }

    return steps;
}

function showInstructions(steps) {
    const panel = document.getElementById("instructions");
    panel.innerHTML = "<h3>Directions</h3>";

    steps.forEach((s, i) => {
        panel.innerHTML += `<div>${i + 1}. ${s}</div>`;
    });
}


/**
 * Draw route
 */
function visualizeRoute(path, nodeCoords) {
    if (!path || path.length < 2) {
        alert("No route found");
        return;
    }

    const coords = path
        .map(id => nodeCoords[id])
        .filter(c => c && isFinite(c.lat) && isFinite(c.lng));

    if (coords.length < 2) {
        alert("Route geometry invalid");
        return;
    }

    const polyline = new google.maps.Polyline({
        path: coords,
        map: map,
        strokeWeight: 5
    });

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(c => bounds.extend(c));

    map.fitBounds(bounds);

    console.log("Path length:", path?.length);
}

/**
 * Main
 */
async function findPath() {
    const s = document.getElementById("source").value.split(",");
    const d = document.getElementById("destination").value.split(",");

    const source = { lat: parseFloat(s[0]), lng: parseFloat(s[1]) };
    const dest = { lat: parseFloat(d[0]), lng: parseFloat(d[1]) };

    try {

        const data = cachedOSMData ??
        (cachedOSMData = await fetchStreetDataWithRetry());

        const { graph, nodeCoords } = buildGraph(data);

        const start = snapToRoad(source.lat, source.lng, nodeCoords, graph);
        const end = snapToRoad(dest.lat, dest.lng, nodeCoords, graph);

        if (!start || !end) {
            alert("No nearby road nodes found");
            return;
        }

        const path = aStar(graph, nodeCoords, start, end);
        visualizeRoute(path, nodeCoords);

        const instructions = buildInstructions(path, nodeCoords);
        showInstructions(instructions);

        visualizeRoute(path, nodeCoords);
    } catch (e) {
        alert("Routing service temporarily busy. Please try again.");
        return;
    }
}