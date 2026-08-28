"""Valida invariantes da base nacional gerada a partir do AIXM AISWEB 2608A1."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def point_in_ring(longitude: float, latitude: float, ring: list[list[float]]) -> bool:
    inside = False
    for index, (current_lon, current_lat) in enumerate(ring):
        previous_lon, previous_lat = ring[index - 1]
        intersects = ((current_lat > latitude) != (previous_lat > latitude)
                      and longitude < (previous_lon - current_lon) * (latitude - current_lat)
                      / ((previous_lat - current_lat) or 1e-12) + current_lon)
        if intersects:
            inside = not inside
    return inside


def point_in_feature(latitude: float, longitude: float, feature: dict) -> bool:
    geometry = feature["geometry"]
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(point_in_ring(longitude, latitude, polygon[0])
               and not any(point_in_ring(longitude, latitude, hole) for hole in polygon[1:])
               for polygon in polygons)


def main() -> None:
    tmas = load("data/tmas/brazil-tmas-aixm.json")
    aerodromes = load("data/tmas/brazil-aerodromes-aixm.json")
    procedures = load("data/tmas/brazil-procedures-aixm.json")
    waypoints = load("data/waypoints.json")

    assert tmas["metadata"]["amendment"] == "2608A1"
    assert aerodromes["amendment"] == procedures["amendment"] == "2608A1"
    features = tmas["features"]
    families = {feature["properties"]["family"] for feature in features}
    assert len(families) == 40, f"Esperadas 40 TMA, encontradas {len(families)}"
    assert len(features) == 139, f"Esperados 139 setores compostos, encontrados {len(features)}"

    for feature in features:
        properties, geometry = feature["properties"], feature["geometry"]
        assert properties["lower_limit"] != "N/I" and properties["upper_limit"] != "N/I"
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for polygon in polygons:
            assert polygon and len(polygon[0]) >= 4 and polygon[0][0] == polygon[0][-1]
            for ring in polygon:
                assert ring[0] == ring[-1]
                assert all(-80 <= longitude <= -25 and -40 <= latitude <= 10 for longitude, latitude in ring)

    foz = [feature for feature in features if feature["properties"]["family"] == "TMA Foz"]
    assert len(foz) == 2
    assert len(next(feature for feature in foz if feature["properties"]["sector_name"] == "FOZ SECT 01")["geometry"]["coordinates"]) == 2
    sao_paulo = [feature for feature in features if feature["properties"]["family"] == "TMA São Paulo"]
    assert len(sao_paulo) == 16 and any(feature["properties"]["sector_name"] == "SAO PAULO 2" for feature in sao_paulo)
    assert {feature["properties"]["sector_name"] for feature in sao_paulo if "SECT" in feature["properties"]["sector_name"]} == {
        "SAO PAULO SECT 01", "SAO PAULO SECT 02", "SAO PAULO SECT 02F", "SAO PAULO SECT 03", "SAO PAULO SECT 03F",
        "SAO PAULO SECT 04", "SAO PAULO SECT 05", "SAO PAULO SECT 06", "SAO PAULO SECT 07", "SAO PAULO SECT 08",
        "SAO PAULO SECT 09", "SAO PAULO SECT 10", "SAO PAULO SECT 11", "SAO PAULO SECT 12", "SAO PAULO SECT 13",
    }

    formerly_collapsed = {"TMA Boa Vista", "TMA Macapá", "TMA Porto Velho", "TMA Rio Branco", "TMA Santarém", "TMA São Luís", "TMA Teresina"}
    for family in formerly_collapsed:
        family_points = [point for feature in features if feature["properties"]["family"] == family for ring in feature["geometry"]["coordinates"] for point in ring]
        assert max(point[0] for point in family_points) - min(point[0] for point in family_points) > 0.2, f"{family} voltou a colapsar"

    procedure_records = procedures["procedures"]
    assert Counter(procedure["type"] for procedure in procedure_records) == Counter({"SID": 252, "STAR": 109, "IAC": 62})
    assert len(procedure_records) == 423
    assert all(isinstance(records, list) and records for records in procedures["publishedPoints"].values())
    assert next(procedure for procedure in procedure_records if procedure["name"] == "RNAV UTLOT 1A RWY15")["runways"] == ["15"]
    allowed_speed = {None, "BELOW_UPPER", "ABOVE_LOWER", "AT_LOWER", "AS_ASSIGNED"}
    allowed_altitude = {"at-or-above", "at-or-below", "at", "between-bound", "recommended", "expected", "as-assigned", "published"}
    for procedure in procedure_records:
        for transition in procedure["transitions"]:
            for segment in transition["segments"]:
                point = segment["destinationPoint"]
                assert point["ident"] == segment["destination"] and isinstance(point["latitude"], (int, float)) and isinstance(point["longitude"], (int, float))
                assert segment["speedLimitDescription"] in allowed_speed
                for field in ("lowerLimitAltitude", "upperLimitAltitude"):
                    if segment[field]:
                        assert segment[field]["meaning"] in allowed_altitude

    base_waypoints = [
        feature for feature in waypoints["features"]
        if feature.get("properties", {}).get("generated_by") != "data-architecture-v1"
    ]
    waypoint_idents = Counter(str(feature["properties"]["ident"]).upper() for feature in base_waypoints)
    assert sum(waypoint_idents.values()) == waypoints.get("baseRecordCount", 7938) == 7938 and len(waypoint_idents) == 7932
    assert waypoints["recordCount"] == len(waypoints["features"])
    assert any(waypoint_idents[ident] > 1 and len(procedures["publishedPoints"].get(ident, [])) > 1 for ident in waypoint_idents)

    aerodrome_by_id = {item["id"]: item for item in aerodromes["aerodromes"]}
    procedures_by_airport: dict[str, int] = Counter(procedure["airport"] for procedure in procedure_records)
    associated_families: dict[str, set[str]] = defaultdict(set)
    for airport, count in procedures_by_airport.items():
        item = aerodrome_by_id.get(airport)
        if not item or not count:
            continue
        for feature in features:
            if point_in_feature(item["lat"], item["lon"], feature):
                associated_families[feature["properties"]["family"]].add(airport)
    assert len(associated_families) >= 28, f"Somente {len(associated_families)} TMA ficaram ligadas a procedimentos"

    print(f"OK: {len(families)} TMA, {len(features)} setores, {len(procedure_records)} procedimentos, {len(associated_families)} TMA com IFR estruturado.")


if __name__ == "__main__":
    main()
