#!/usr/bin/env python3
"""Bake Natural Earth (public domain) geography into the game's tile map.

Writes public/data/world.bin (one terrain byte per tile, row-major) and art/world-terrain.png
(a 1px-per-tile preview that is touched up in Pixeter). Run: python3 tools/bake_map.py
"""
import json, os, struct
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
W, H = 640, 238            # 0.5625 degrees per tile
LAT_TOP, LAT_BOT = 78.0, -55.9
SS = 4                     # supersample for smoother coastlines

# terrain ids (must match src/shared/terrain.js)
OCEAN, SHALLOW, PLAINS, FOREST, JUNGLE, DESERT, HILLS, MOUNTAIN, TUNDRA, SNOW, RIVER = range(11)
COLORS = {
    OCEAN: (30, 52, 92), SHALLOW: (44, 84, 132), PLAINS: (118, 158, 82), FOREST: (64, 116, 64),
    JUNGLE: (40, 98, 58), DESERT: (214, 186, 120), HILLS: (146, 140, 92), MOUNTAIN: (126, 112, 104),
    TUNDRA: (150, 160, 140), SNOW: (226, 232, 240), RIVER: (82, 140, 170),
}


def to_px(lon, lat):
    x = (lon + 180.0) / 360.0 * W
    y = (LAT_TOP - lat) / (LAT_TOP - LAT_BOT) * H
    return x * SS, y * SS


def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    polys = [c] if t == "Polygon" else c if t == "MultiPolygon" else []
    for poly in polys:
        for i, ring in enumerate(poly):
            yield i == 0, ring


def raster(path, keep=lambda p: True):
    img = Image.new("L", (W * SS, H * SS), 0)
    d = ImageDraw.Draw(img)
    for f in json.load(open(path))["features"]:
        if not keep(f["properties"]):
            continue
        for outer, ring in rings(f["geometry"]):
            d.polygon([to_px(*pt[:2]) for pt in ring], fill=255 if outer else 0)
    return img.resize((W, H), Image.BOX).load()


def lines(path):
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    for f in json.load(open(path))["features"]:
        if (f["properties"].get("scalerank") or 10) > 5:
            continue
        g = f["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for part in parts:
            d.line([((p[0] + 180) / 360 * W, (LAT_TOP - p[1]) / (LAT_TOP - LAT_BOT) * H) for p in part], fill=255)
    return img.load()


def hash01(x, y, s):
    h = (x * 374761393 + y * 668265263 + s * 2147483647) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return (h ^ (h >> 16)) / 0xFFFFFFFF


def noise(x, y, scale, s):
    """cheap value noise, smooth enough to break up latitude bands"""
    gx, gy = x / scale, y / scale
    x0, y0 = int(gx), int(gy)
    fx, fy = gx - x0, gy - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = hash01(x0, y0, s), hash01(x0 + 1, y0, s)
    c, d = hash01(x0, y0 + 1, s), hash01(x0 + 1, y0 + 1, s)
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy


def main():
    land = raster(os.path.join(RAW, "ne_50m_land.geojson"))
    lakes = raster(os.path.join(RAW, "ne_50m_lakes.geojson"))
    geo = os.path.join(RAW, "ne_50m_geography_regions_polys.geojson")
    mtn = raster(geo, lambda p: p["FEATURECLA"] == "Range/mtn")
    desert = raster(geo, lambda p: p["FEATURECLA"] == "Desert")
    plateau = raster(geo, lambda p: p["FEATURECLA"] in ("Plateau", "Foothills"))
    tundra = raster(geo, lambda p: p["FEATURECLA"] == "Tundra")
    rivers = lines(os.path.join(RAW, "ne_50m_rivers_lake_centerlines.geojson"))

    t = bytearray(W * H)
    for y in range(H):
        lat = LAT_TOP - (y + 0.5) / H * (LAT_TOP - LAT_BOT)
        for x in range(W):
            i = y * W + x
            if land[x, y] < 110 or lakes[x, y] > 140:
                t[i] = OCEAN
                continue
            n = noise(x, y, 9, 1)
            alat = abs(lat) + (n - 0.5) * 8
            if mtn[x, y] > 120:
                t[i] = SNOW if alat > 52 and n > 0.5 else MOUNTAIN
            elif desert[x, y] > 110 or (14 < alat < 32 and noise(x, y, 14, 2) > 0.7):
                t[i] = DESERT
            elif tundra[x, y] > 110 or alat > 64:
                t[i] = SNOW if alat > 72 else TUNDRA
            elif plateau[x, y] > 110:
                t[i] = HILLS
            elif alat < 12:
                t[i] = JUNGLE if n > 0.32 else PLAINS
            elif alat > 50:
                t[i] = FOREST if n > 0.38 else PLAINS
            else:
                t[i] = FOREST if n > 0.62 else HILLS if noise(x, y, 6, 3) > 0.8 else PLAINS
            if rivers[x, y] > 100 and t[i] not in (MOUNTAIN, SNOW):
                t[i] = RIVER
    # shallow water: ocean within 2 tiles of land
    out = bytearray(t)
    for y in range(H):
        for x in range(W):
            if t[y * W + x] != OCEAN:
                continue
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    yy, xx = y + dy, (x + dx) % W
                    if 0 <= yy < H and t[yy * W + xx] not in (OCEAN, SHALLOW):
                        out[y * W + x] = SHALLOW
                        break
                else:
                    continue
                break
    os.makedirs(os.path.join(ROOT, "public", "data"), exist_ok=True)
    with open(os.path.join(ROOT, "public", "data", "world.bin"), "wb") as f:
        f.write(struct.pack("<HH", W, H) + bytes(out))
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            px[x, y] = COLORS[out[y * W + x]]
    img.save(os.path.join(ROOT, "art", "world-terrain.png"))
    landn = sum(1 for v in out if v > SHALLOW)
    print(f"world.bin {W}x{H}, land tiles {landn}")


if __name__ == "__main__":
    main()
