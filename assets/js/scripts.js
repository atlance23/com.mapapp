/**
 * ============================
 * GLOBAL CONFIG
 * ============================
 */

const centerCoordinates = { lat: 38.6251, lng: -90.1868 };
let map;

const TILE_ZOOM = 12;          // Good for MO + IL
const TILE_CONCURRENCY = 3;    // Overpass-safe
const TILE_DELAY_MS = 250;

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
 * Global routing graph
 */
let globalGraph = {};
let globalNodeCoords = {};

/**
 * ============================
 * MAP INIT
 * ============================
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
 * TILE MATH (XYZ)
 * ============================
 */

function latLngToTile(lat, lng, z = TILE_ZOOM) {
    const n = 2 ** z;
    const x = Math.floor((lng + 180) / 360 * n);
    const y = Math.floor(
        (1 - Math.log(Math.tan(lat * Math.PI / 180) +
        1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
    );
    return [x, y];
}

function tilesAlongRoute(a, b, z = TILE_ZOOM) {
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

/**
 * ============================
 * TILE CACHE
 * ============================
 */

function tileKey(x, y, z) {
    return `tile_${z}_${x}_${y}`;
}

function loadCachedTile(x, y, z) {
    const raw = localStorage.getItem(tileKey(x, y, z));
    return raw ? JSON.parse(raw) : null;
}

function saveCachedTile(x, y, z, data) {
    localStorage.setItem(tileKey(x, y, z), JSON.stringify(data));
}

/**
 * ============================
 * FETCH TILE (OVERPASS)
 * ============================
 */

async function fetchTile(x, y, z = TILE_ZOOM) {
    const cached = loadCachedTile(x, y, z);
    if (cached) {
        console.debug(`Tile ${x}:${y} loaded from cache`);
        return cached;
    }

    const n = 2 ** z;

    const lon1 = x / n * 360 - 180;
    const lon2 = (x + 1) / n * 360 - 180;
    const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;

    const query = `
        [out:json][timeout:25];
        way["highway"](${lat2},${lon1},${lat1},${lon2});
        (._;>;);
        out body;
    `;

    console.debug(`Fetching tile ${x}:${y}`);

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

    saveCachedTile(x, y, z, data);
    return data;
}

/**
 * ============================
 * MERGE TILE INTO GRAPH
 * ============================
 */

function mergeTile(data) {
    for (const el of data.elements) {
        if (el.type === "node") {
            globalNodeCoords[el.id] = { lat: el.lat, lng: el.lon };
        }
    }

    for (const el of data.elements) {
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
    }
}

/**
 * ============================
 * PARALLEL TILE LOADER
 * ============================
 */

async function ensureTilesLoaded(source, dest) {
    const tiles = tilesAlongRoute(source, dest);
    console.info(`Loading ${tiles.length} tiles`);

    let completed = 0;
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
            console.debug(`Tile progress: ${completed}/${tiles.length}`);
            await new Promise(r => setTimeout(r, TILE_DELAY_MS));
        }
    }

    for (let i = 0; i < TILE_CONCURRENCY; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    if (!Object.keys(globalGraph).length) {
        throw new Error("No road data loaded");
    }
}

/**
 * ============================
 * ROUTING CORE
 * ============================
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
            if (!current || f[v] < f[current]) current = v;
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
                f[n] = tentative +
                    haversine(globalNodeCoords[n], globalNodeCoords[goal]);
                open.add(n);
            }
        }
    }
    return null;
}

/**
 * ============================
 * VISUALIZATION
 * ============================
 */

function visualizeRoute(path) {
    if (!path || path.length < 2) return;

    const coords = path.map(id => globalNodeCoords[id]).filter(Boolean);

    const poly = new google.maps.Polyline({
        path: coords,
        map,
        strokeWeight: 5
    });

    const bounds = new google.maps.LatLngBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds);
}

/**
 * ============================
 * ENTRY POINT
 * ============================
 */

async function findPath() {
    try {
        globalGraph = {};
        globalNodeCoords = {};

        const s = document.getElementById("source").value.split(",");
        const d = document.getElementById("destination").value.split(",");

        const source = { lat: +s[0], lng: +s[1] };
        const dest = { lat: +d[0], lng: +d[1] };

        await ensureTilesLoaded(source, dest);

        const start = snapToRoad(source.lat, source.lng);
        const end = snapToRoad(dest.lat, dest.lng);

        if (!start || !end) {
            throw new Error("Unable to snap to road network");
        }

        const path = aStar(start, end);
        visualizeRoute(path);

        console.info("Routing complete");
    } catch (e) {
        console.error("Routing failed:", e);
        alert(e.message);
    }
}
