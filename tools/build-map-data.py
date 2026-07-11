import json
from collections import Counter
from pathlib import Path

from shapely.geometry import shape, MultiPolygon, Polygon, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

SOURCE = Path(r"E:\EC Coverage Area Brgy Level.geojson")
OUT = Path("data/coverage-map.json")
SIMPLIFY_TOLERANCE = 0.0015


def empty_bounds():
    return [float("inf"), float("inf"), float("-inf"), float("-inf")]


def expand_bounds(bounds, geom):
    minx, miny, maxx, maxy = geom.bounds
    bounds[0] = min(bounds[0], minx)
    bounds[1] = min(bounds[1], miny)
    bounds[2] = max(bounds[2], maxx)
    bounds[3] = max(bounds[3], maxy)


def round_point(point):
    return [round(point[0], 5), round(point[1], 5)]


def ring_to_coords(ring):
    return [round_point(point) for point in ring.coords]


def geom_to_multipolygon_coords(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        polygons = [geom]
    elif isinstance(geom, MultiPolygon):
        polygons = list(geom.geoms)
    else:
        polygons = [part for part in getattr(geom, "geoms", []) if isinstance(part, Polygon)]

    coords = []
    for polygon in polygons:
        if polygon.is_empty or polygon.area == 0:
            continue
        rings = [ring_to_coords(polygon.exterior)]
        rings.extend(ring_to_coords(interior) for interior in polygon.interiors)
        coords.append(rings)
    return coords


def representative_label_point(geom):
    point = geom.representative_point()
    return round(point.x, 5), round(point.y, 5)


def province_text(counter):
    names = sorted(counter)
    if not names:
        return ""
    if len(names) <= 3:
        return ", ".join(names)
    return f"{len(names)} provinces"


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with SOURCE.open("r", encoding="utf-8-sig") as src:
        data = json.load(src)

    groups = {}
    skipped = 0

    for index, feature in enumerate(data["features"]):
        props = feature.get("properties") or {}
        ec = props.get("Phil-MunCity_EC") or "#N/A"
        province = props.get("PROVINCE") or props.get("Phil-MunCity_PROVINCE") or ""
        status = props.get("Phil-MunCity_Status of Operation") or "Blank"
        area_type = props.get("Phil-MunCity_ENGTYPE_2") or props.get("ENGTYPE_3") or ""
        geom_data = feature.get("geometry")

        if not geom_data:
            skipped += 1
            continue

        try:
            geom = shape(geom_data)
            if not geom.is_valid:
                geom = make_valid(geom)
            if geom.is_empty:
                skipped += 1
                continue
        except Exception:
            skipped += 1
            continue

        group = groups.setdefault(
            ec,
            {
                "e": ec,
                "geoms": [],
                "ps": Counter(),
                "s": Counter(),
                "types": Counter(),
                "n": 0,
            },
        )
        group["geoms"].append(geom)
        group["ps"][province] += 1
        group["s"][status] += 1
        group["types"][area_type] += 1
        group["n"] += 1

        if index % 5000 == 0:
            print(f"processed {index:,} source features")

    features = []
    labels = []
    bounds = empty_bounds()
    ec_counts = Counter()
    province_counts = Counter()
    status_counts = Counter()
    type_counts = Counter()
    source_polygon_count = 0

    for feature_id, group in enumerate(sorted(groups.values(), key=lambda item: item["e"])):
        print(f"dissolving {group['e']} ({group['n']:,} source polygons)")
        dissolved = unary_union(group["geoms"])
        if not dissolved.is_valid:
            dissolved = make_valid(dissolved)
        dissolved = dissolved.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)

        coords = geom_to_multipolygon_coords(dissolved)
        if not coords:
            continue

        expand_bounds(bounds, dissolved)
        status = group["s"].most_common(1)[0][0] if group["s"] else "Blank"
        label_x, label_y = representative_label_point(dissolved)
        provinces = sorted(group["ps"])
        bbox = [round(v, 5) for v in dissolved.bounds]

        features.append(
            {
                "id": feature_id,
                "p": province_text(group["ps"]),
                "ps": provinces,
                "e": "N/A" if group["e"] == "#N/A" else group["e"],
                "s": status,
                "t": "Unassigned Coverage" if group["e"] == "#N/A" else "EC Coverage",
                "b": bbox,
                "g": coords,
                "n": group["n"],
            }
        )
        labels.append(
            {
                "p": province_text(group["ps"]),
                "ps": provinces,
                "e": "N/A" if group["e"] == "#N/A" else group["e"],
                "x": label_x,
                "y": label_y,
                "n": group["n"],
            }
        )

        ec_counts[group["e"]] += group["n"]
        province_counts.update(group["ps"])
        status_counts.update(group["s"])
        type_counts.update(group["types"])
        source_polygon_count += group["n"]

    payload = {
        "name": data.get("name", "EC Coverage Area Brgy Level"),
        "bbox": [round(v, 5) for v in bounds],
        "stats": {
            "features": len(features),
            "sourcePolygons": source_polygon_count,
            "ecs": len(ec_counts),
            "namedEcs": len([ec for ec in ec_counts if ec != "#N/A"]),
            "provinces": len(province_counts),
            "sourceTypes": type_counts.most_common(),
            "status": status_counts.most_common(),
            "topEcs": ec_counts.most_common(20),
        },
        "filters": {
            "provinces": sorted(province_counts),
            "ecs": sorted(ec for ec in ec_counts if ec != "#N/A"),
        },
        "labels": sorted((label for label in labels if label["e"] != "N/A"), key=lambda item: item["n"], reverse=True),
        "features": features,
    }

    with OUT.open("w", encoding="utf-8") as out:
        json.dump(payload, out, separators=(",", ":"))

    print(
        f"wrote {OUT} with {len(features):,} dissolved EC polygons "
        f"from {source_polygon_count:,} source polygons; skipped {skipped:,} invalid features"
    )


if __name__ == "__main__":
    main()
