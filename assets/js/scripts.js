/**
 * Constants
 */

const centerCoordinates = { lat: 38.6251, lng: -90.1868 };
let map;

/**
 * Tile system
 */

const TILE_SIZE = 0.25;
const tileCache = new Map();

const globalGraph = {};
const globalNodeCoords = {};

/**
 * Road weights
 */

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

/**
 * Initialize Google Map
 */

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: centerCoordinates,
        zoom: 7,
        mapTypeId: "roadmap"
    });
}

/**
 * Tile helpers
 */

function tileId(lat, lng) {
    return `${Math.floor(lng / TILE_SIZE)}:${Math.floor(lat / TILE_SIZE)}`;
}

function tileBBox(x, y) {
    return {
        west: x * TILE_SIZE,
        east: (x + 1) * TILE_SIZE,
        south: y * TILE_SIZE,
        north: (y + 1) * TILE_SIZE
    };
}

/**
 * Cache helpers
 */

function loadCachedTile(id) {
    if (tileCache.has(id)) return tileCache.get(id);
    const raw = localStorage.getItem("tile_" + id);
    if (!raw) return null;
    const data = JSON.parse(raw);
    tileCache.set(id, data);
    return data;
}

function cacheTile(id, data) {
    tileCache.set(id, data);
    localStorage.setItem("tile_" + id, JSON.stringify(data));
}

/**
 * Fetch one tile
 */

async function fetchTile(x, y) {
    const id = `${x}:${y}`;
    const cached = loadCachedTile(id);
    if (cached) return cached;

    const bbox = tileBBox(x, y);

    const query = `
        [out:json][timeout:25];
        way["highway"]
          (${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        (._;>;);
        out body;
    `;

    const res = await fetch(
        "https://overpass-api.de/api/interpreter",
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "data=" + encodeURIComponent(query)
        }
    );

    if (!res.ok) throw new Error("Tile fetch failed");

    const data = await res.json();
    cacheTile(id, data);
    return data;
}

/**
 * Merge tile into global graph
 */

function mergeTile(data) {
    data.elements.forEach(el => {
        if (el.type === "node") {
            globalNodeCoords[el.id] = { lat: el.lat, lng: el.lon };
        }
    });

    data.elements.forEach(el => {
        if (el.type === "way" && el.nodes && el.tags?.highway) {
            const weight = ROAD_WEIGHTS[el.tags.highway] ?? 1.3;
            const oneway = ["yes", "true", "1"].includes(el.tags.oneway);

            for (let i = 0; i < el.nodes.length - 1; i++) {
                const a = el.nodes[i];
                const b = el.nodes[i + 1];

                if (!globalNodeCoords[a] || !globalNodeCoords[b]) continue;

                globalGraph[a] ??= {};
                globalGraph[b] ??= {};

                globalGraph[a][b] = weight;
                if (!oneway) globalGraph[b][a] = weight;
            }
        }
    });
}

/**
 * Corridor tiles
 */

function tilesAlongRoute(a, b) {
    const tiles = new Set();
    const steps = 60;

    for (let i = 0; i <= steps; i++) {
        const lat = a.lat + (b.lat - a.lat) * (i / steps);
        const lng = a.lng + (b.lng - a.lng) * (i / steps);
        tiles.add(tileId(lat, lng));
    }

    return [...tiles].map(id => id.split(":").map(Number));
}

/**
 * Ensure tiles loaded
 */

async function ensureTilesLoaded(source, dest) {
    const tiles = tilesAlongRoute(source, dest);
    for (const [x, y] of tiles) {
        const data = await fetchTile(x, y);
        mergeTile(data);
    }
}

/**
 * Snap to road
 */

function snapToRoad(lat, lng) {
    let best = null;
    let min = Infinity;

    for (const id in globalGraph) {
        const n = globalNodeCoords[id];
        if (!n) continue;

        const d = (lat - n.lat) ** 2 + (lng - n.lng) ** 2;
        if (d < min) {
            min = d;
            best = id;
        }
    }

    return best;
}

/**
 * Haversine
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
 * A*
 */

function aStar(start, goal) {
    const open = new Set([start]);
    const came = {};
    const g = {};
    const f = {};

    for (const v in globalGraph) {
        g[v] = Infinity;
        f[v] = Infinity;
    }

    g[start] = 0;
    f[start] = haversine(globalNodeCoords[start], globalNodeCoords[goal]);

    while (open.size) {
        let current = null;
        for (const v of open) {
            if (current === null || f[v] < f[current]) current = v;
        }

        if (current === goal) {
            const path = [];
            while (current) {
                path.push(current);
                current = came[current];
            }
            return path.reverse();
        }

        open.delete(current);

        for (const n in globalGraph[current]) {
            const tentative =
                g[current] +
                globalGraph[current][n] *
                haversine(globalNodeCoords[current], globalNodeCoords[n]);

            if (tentative < g[n]) {
                came[n] = current;
                g[n] = tentative;
                f[n] = tentative + haversine(globalNodeCoords[n], globalNodeCoords[goal]);
                open.add(n);
            }
        }
    }

    return null;
}

/**
 * Visualization
 */

function visualizeRoute(path) {
    if (!path || path.length < 2) return;

    const coords = path.map(id => globalNodeCoords[id]).filter(Boolean);
    const polyline = new google.maps.Polyline({
        path: coords,
        map,
        strokeWeight: 5
    });

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds);
}

/**
 * Main
 */

async function findPath() {
    const s = document.getElementById("source").value.split(",");
    const d = document.getElementById("destination").value.split(",");

    const source = { lat: +s[0], lng: +s[1] };
    const dest = { lat: +d[0], lng: +d[1] };

    try {
        await ensureTilesLoaded(source, dest);

        const start = snapToRoad(source.lat, source.lng);
        const end = snapToRoad(dest.lat, dest.lng);

        if (!start || !end) {
            alert("No nearby roads found");
            return;
        }

        const path = aStar(start, end);
        visualizeRoute(path);
    } catch (e) {
        alert("Routing service busy. Try again.");
    }
}
