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
 * Helpers
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

function latLngToTile(lat, lng, z = 12) {
    const n = 2 ** z;
    const x = Math.floor((lng + 180) / 360 * n);
    const y = Math.floor(
        (1 - Math.log(Math.tan(lat * Math.PI / 180) +
        1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
    );
    return [x, y];
}

function tilesAlongRoute(a, b, z = 12) {
    const [x1, y1] = latLngToTile(a.lat, a.lng, z);
    const [x2, y2] = latLngToTile(b.lat, b.lng, z);

    const tiles = [];
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
            tiles.push([x, y]);
        }
    }
    return tiles;
}

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

async function fetchTile(x, y, z = 12) {
    const n = 2 ** z;

    const lon1 = x / n * 360 - 180;
    const lon2 = (x + 1) / n * 360 - 180;

    const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;

    const query = `
        [out:json][timeout:25];
        way["highway"]
          (${lat2},${lon1},${lat1},${lon2});
        (._;>;);
        out body;
    `;

    const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
    });

    if (!res.ok) {
        throw new Error(`Overpass HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data.elements || !data.elements.length) {
        throw new Error("Empty tile");
    }

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

            const oneway =
                el.tags.oneway === "yes" ||
                el.tags.oneway === "true" ||
                el.tags.oneway === "1";

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
 * Parallel Tile Loader 
 */

async function ensureTilesLoaded(source, dest) {
    const tiles = tilesAlongRoute(source, dest);
    const total = tiles.length;
    let completed = 0;

    const progress = document.getElementById("progress");
    const progressText = document.getElementById("progressText");
    progress.style.display = "block";

    const CONCURRENCY = 3;
    const queue = [...tiles];
    const workers = [];

    async function worker() {
        while (queue.length) {
            const [x, y] = queue.shift();
            try {
                const data = await fetchTile(x, y);
                mergeTile(data);
            } catch (e) {
                console.warn(`Tile ${x}:${y} skipped`, e.message);
            }

            completed++;
            progressText.textContent =
                Math.round((completed / total) * 100) + "%";

            await new Promise(r => setTimeout(r, 250));
        }
    }

    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    progress.style.display = "none";

    if (Object.keys(globalGraph).length === 0) {
        throw new Error("No road data loaded");
    }
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
        try {
            const data = await fetchTile(x, y);
            mergeTile(data);
        } catch (e) {
            console.warn(`Tile ${x}:${y} failed, skipping`, e.message);
            // DO NOT throw — continue
        }

        // small delay to avoid Overpass throttling
        await new Promise(r => setTimeout(r, 350));
    }

    if (Object.keys(globalGraph).length === 0) {
        throw new Error("No road data loaded");
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
        globalGraph = {};
        globalNodeCoords = {};

        await ensureTilesLoaded(source, dest);

        const start = snapToRoad(source.lat, source.lng, globalNodeCoords, globalGraph);
        const end = snapToRoad(dest.lat, dest.lng, globalNodeCoords, globalGraph);

        if (!start || !end) {
            throw new Error("Unable to snap to road network");
        }

        const path = aStar(globalGraph, globalNodeCoords, start, end);
        visualizeRoute(path);
    } catch (e) {
        alert("Routing service busy. Try again.");
    }
}
