"""Converte os espaços TMA de um pacote AIXM 5.1 do AISWEB em GeoJSON.

Uso:
    python scripts/import-aixm-tmas.py BL__decoded.xml data/tmas/brazil-tmas-aixm.json

O conversor preserva somente geometrias publicadas no AIXM. Composições por união
são resolvidas recursivamente até os setores que possuem projeção horizontal.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
GML_ID = "{http://www.opengis.net/gml/3.2}id"
EARTH_RADIUS_M = 6_371_008.8


def local(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def first(element: ET.Element, name: str) -> ET.Element | None:
    return next((child for child in element.iter() if local(child) == name), None)


def text(element: ET.Element, name: str, default: str = "") -> str:
    found = first(element, name)
    return (found.text or "").strip() if found is not None else default


def child_text(element: ET.Element, name: str, default: str = "") -> str:
    found = next((child for child in element if local(child) == name), None)
    return (found.text or "").strip() if found is not None else default


def number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def position_values(element: ET.Element) -> list[tuple[float, float]]:
    values: list[float] = []
    for position in element.iter():
        if local(position) not in {"pos", "posList"} or not position.text:
            continue
        values.extend(float(value) for value in position.text.split())
    return [(values[index + 1], values[index]) for index in range(0, len(values) - 1, 2)]


def destination(latitude: float, longitude: float, bearing: float, distance_m: float) -> tuple[float, float]:
    angular = distance_m / EARTH_RADIUS_M
    lat1, lon1, course = map(math.radians, (latitude, longitude, bearing))
    lat2 = math.asin(math.sin(lat1) * math.cos(angular) + math.cos(lat1) * math.sin(angular) * math.cos(course))
    lon2 = lon1 + math.atan2(math.sin(course) * math.sin(angular) * math.cos(lat1), math.cos(angular) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lon2), math.degrees(lat2)


def distance_metres(radius: ET.Element | None) -> float | None:
    value = number(radius.text if radius is not None else None)
    if value is None:
        return None
    unit = (radius.attrib.get("uom", "M") if radius is not None else "M").upper()
    return value * {"NM": 1852.0, "KM": 1000.0, "FT": 0.3048, "M": 1.0}.get(unit, 1.0)


def sampled_arc(segment: ET.Element, full_circle: bool = False) -> list[tuple[float, float]]:
    center = first(segment, "pos")
    center_values = [float(value) for value in (center.text or "").split()] if center is not None else []
    radius = distance_metres(first(segment, "radius"))
    if len(center_values) < 2 or radius is None:
        return []
    latitude, longitude = center_values[:2]
    if full_circle:
        bearings = range(0, 361, 4)
    else:
        start = number(text(segment, "startAngle"))
        end = number(text(segment, "endAngle"))
        if start is None or end is None:
            return []
        # AIXM/GML usa azimute geodésico: graus no sentido horário a partir do norte.
        sweep = (end - start) % 360
        if sweep == 0:
            sweep = 360
        steps = max(4, math.ceil(sweep / 4))
        bearings = [start + sweep * index / steps for index in range(steps + 1)]
    return [destination(latitude, longitude, bearing, radius) for bearing in bearings]


def segment_coordinates(segment: ET.Element, diagnostics: Counter[str]) -> list[tuple[float, float]]:
    kind = local(segment)
    diagnostics[kind] += 1
    if kind == "CircleByCenterPoint":
        return sampled_arc(segment, full_circle=True)
    if kind == "ArcByCenterPoint":
        return sampled_arc(segment)
    return position_values(segment)


def surface_polygons(surface: ET.Element, diagnostics: Counter[str]) -> list[list[tuple[float, float]]]:
    polygons: list[list[tuple[float, float]]] = []
    patches = [element for element in surface.iter() if local(element) == "PolygonPatch"]
    for patch in patches:
        ring = next((element for element in patch.iter() if local(element) == "Ring"), None)
        if ring is None:
            continue
        coordinates: list[tuple[float, float]] = []
        for curve_member in (element for element in ring if local(element) == "curveMember"):
            segments = [element for element in curve_member.iter() if local(element) in {"GeodesicString", "LineStringSegment", "ArcString", "ArcByCenterPoint", "CircleByCenterPoint"}]
            for segment in segments:
                points = segment_coordinates(segment, diagnostics)
                if coordinates and points and coordinates[-1] == points[0]:
                    points = points[1:]
                coordinates.extend(points)
        if len(coordinates) >= 3:
            if coordinates[0] != coordinates[-1]:
                coordinates.append(coordinates[0])
            polygons.append(coordinates)
    return polygons


def formatted_limit(volume: ET.Element, field: str) -> str:
    element = next((child for child in volume if local(child) == field), None)
    if element is None or not (element.text or "").strip():
        return "N/I"
    raw = element.text.strip()
    value = number(raw)
    if value is None:
        return raw
    unit = element.attrib.get("uom", "").upper()
    reference = child_text(volume, f"{field}Reference")
    if unit == "FL":
        return f"FL{round(value):03d}"
    if unit == "FT":
        return f"{round(value)} FT {reference or 'AMSL'}"
    return f"{value:g} {unit} {reference}".strip()


def parse_airspaces(source: Path) -> tuple[dict[str, dict], list[dict], Counter[str]]:
    airspaces: dict[str, dict] = {}
    aerodromes: list[dict] = []
    runways_by_airport: dict[str, list[str]] = defaultdict(list)
    diagnostics: Counter[str] = Counter()
    for _, element in ET.iterparse(source, events=("end",)):
        element_type = local(element)
        if element_type == "Runway":
            time_slices = [item for item in element.iter() if local(item) == "RunwayTimeSlice"]
            baseline = next((item for item in time_slices if text(item, "interpretation") == "BASELINE"), time_slices[-1] if time_slices else None)
            if baseline is not None and child_text(baseline, "type") == "RWY" and child_text(baseline, "abandoned", "NO") != "YES":
                airport_link = first(baseline, "associatedAirportHeliport")
                href = airport_link.attrib.get(XLINK_HREF, "") if airport_link is not None else ""
                designator = child_text(baseline, "designator")
                if href and designator:
                    runways_by_airport[href.rsplit(":", 1)[-1]].append(designator)
            element.clear()
            continue
        if element_type == "AirportHeliport":
            identifier = (element.attrib.get(GML_ID, "").removeprefix("uuid.") or text(element, "identifier"))
            time_slices = [item for item in element.iter() if local(item) == "AirportHeliportTimeSlice"]
            baseline = next((item for item in time_slices if text(item, "interpretation") == "BASELINE"), time_slices[-1] if time_slices else None)
            if baseline is not None and child_text(baseline, "type") == "AD":
                arp = next((item for item in baseline if local(item) == "ARP"), None)
                position = first(arp, "pos") if arp is not None else None
                values = [float(value) for value in (position.text or "").split()] if position is not None else []
                designator = child_text(baseline, "designator")
                if designator and len(values) >= 2:
                    elevation = next((item for item in baseline if local(item) == "fieldElevation"), None)
                    elevation_value = number(elevation.text if elevation is not None else None)
                    elevation_ft = elevation_value * 3.28084 if elevation_value is not None and elevation.attrib.get("uom", "").upper() == "M" else elevation_value
                    city = first(baseline, "City")
                    aerodromes.append({
                        "id": designator,
                        "name": child_text(baseline, "name") or designator,
                        "city": text(city, "name") if city is not None else "",
                        "type": "Aeródromo AIXM",
                        "lat": values[0],
                        "lon": values[1],
                        "elevation_ft": round(elevation_ft) if elevation_ft is not None else None,
                        "runways": sorted(set(runways_by_airport.get(identifier, []))),
                        "privateUse": child_text(baseline, "privateUse") == "YES",
                        "effective_date": text(baseline, "beginPosition"),
                        "source": "AISWEB/DECEA — AIXM completo AMDT 2608A1",
                        "source_url": "https://aisweb.decea.mil.br/?i=publicacoes&p=aixm",
                    })
            element.clear()
            continue
        if element_type != "Airspace":
            continue
        identifier = (element.attrib.get(GML_ID, "").removeprefix("uuid.") or text(element, "identifier"))
        time_slices = [item for item in element.iter() if local(item) == "AirspaceTimeSlice"]
        baseline = next((item for item in time_slices if text(item, "interpretation") == "BASELINE"), time_slices[-1] if time_slices else None)
        if baseline is None:
            element.clear()
            continue
        components = []
        for component in (item for item in baseline if local(item) == "geometryComponent"):
            volume = first(component, "AirspaceVolume")
            if volume is None:
                continue
            surfaces = [item for item in volume.iter() if local(item) == "Surface"]
            polygons = [polygon for surface in surfaces for polygon in surface_polygons(surface, diagnostics)]
            references = []
            for linked in (item for item in volume.iter() if local(item) == "theAirspace"):
                href = linked.attrib.get(XLINK_HREF, "")
                if href:
                    references.append(href.rsplit(":", 1)[-1])
            components.append({
                "operation": text(component, "operation", "BASE"),
                "polygons": polygons,
                "references": references,
                "upper": formatted_limit(volume, "upperLimit"),
                "lower": formatted_limit(volume, "lowerLimit"),
            })
        classes = sorted({(item.text or "").strip() for item in baseline.iter() if local(item) == "classification" and (item.text or "").strip()})
        airspaces[identifier] = {
            "id": identifier,
            "type": child_text(baseline, "type"),
            "designator": child_text(baseline, "designator"),
            "name": child_text(baseline, "name"),
            "classes": classes,
            "effective": text(baseline, "beginPosition"),
            "components": components,
        }
        element.clear()
    aerodromes.sort(key=lambda item: item["id"])
    return airspaces, aerodromes, diagnostics


def family_name(name: str) -> str:
    clean = re.sub(r"\s+\d+[A-Z]?$", "", name.strip(), flags=re.I)
    clean = unicodedata.normalize("NFKD", clean).encode("ascii", "ignore").decode("ascii").title()
    accents = {
        "Amazonica": "Amazônica", "Anapolis": "Anápolis", "Belem": "Belém", "Brasilia": "Brasília",
        "Cuiaba": "Cuiabá", "Florianopolis": "Florianópolis", "Goiania": "Goiânia", "Ilheus": "Ilhéus",
        "Macae": "Macaé", "Macapa": "Macapá", "Maceio": "Maceió", "Maraba": "Marabá",
        "Rio De Janeiro": "Rio de Janeiro", "Sao Luis": "São Luís", "Sao Paulo": "São Paulo",
        "Santarem": "Santarém", "Uberlandia": "Uberlândia", "Vitoria": "Vitória",
    }
    return f"TMA {accents.get(clean, clean)}"


def resolve_geometries(root: dict, airspaces: dict[str, dict]) -> list[dict]:
    resolved: list[dict] = []

    def visit(item: dict, seen: set[str]) -> None:
        if item["id"] in seen:
            return
        seen = {*seen, item["id"]}
        for component in item["components"]:
            for polygon in component["polygons"]:
                resolved.append({"owner": item, "component": component, "polygon": polygon})
            for reference in component["references"]:
                linked = airspaces.get(reference)
                if linked:
                    visit(linked, seen)

    visit(root, set())
    return resolved


def build_geojson(airspaces: dict[str, dict], source_name: str) -> dict:
    excluded_families = {"TMA Paso De Los Libres"}
    tmas = [item for item in airspaces.values() if item["type"] == "TMA" and family_name(item["name"] or item["designator"]) not in excluded_families]
    features = []
    emitted = set()
    for tma in tmas:
        family = family_name(tma["name"] or tma["designator"])
        for index, resolved in enumerate(resolve_geometries(tma, airspaces), start=1):
            owner, component, polygon = resolved["owner"], resolved["component"], resolved["polygon"]
            key = (family, owner["id"], component["lower"], component["upper"], json.dumps(polygon, separators=(",", ":")))
            if key in emitted:
                continue
            emitted.add(key)
            sector_name = owner["name"] or owner["designator"] or f"SETOR {index:02d}"
            features.append({
                "type": "Feature",
                "id": f"aixm:{owner['id']}:{index}",
                "properties": {
                    "name": f"{family} · {sector_name.title()}",
                    "family": family,
                    "sector_name": sector_name,
                    "designator": owner["designator"],
                    "type": "TMA",
                    "upper_limit": component["upper"],
                    "lower_limit": component["lower"],
                    "airspace_class": f"Classe {'/'.join(owner['classes'] or tma['classes'])}" if (owner["classes"] or tma["classes"]) else "N/I",
                    "effective_date": owner["effective"] or tma["effective"],
                    "source": "AISWEB/DECEA — AIXM completo AMDT 2608A1",
                    "source_url": "https://aisweb.decea.mil.br/?i=publicacoes&p=aixm",
                    "dataset": "brazil-aixm-2608a1",
                },
                "geometry": {"type": "Polygon", "coordinates": [polygon]},
            })
    features.sort(key=lambda feature: (feature["properties"]["family"], feature["properties"]["sector_name"]))
    return {
        "type": "FeatureCollection",
        "metadata": {
            "scope": "Brazil",
            "authority": "AISWEB/DECEA",
            "amendment": "2608A1",
            "effectiveDate": "2026-08-06",
            "sourceFile": source_name,
            "notice": "Geometrias TMA extraídas do pacote AIXM oficial. Não substitui consulta às publicações vigentes e NOTAM.",
        },
        "features": features,
    }


def build_aerodrome_catalog(aerodromes: list[dict], source_name: str) -> dict:
    return {
        "schemaVersion": 1,
        "scope": "Brazil",
        "authority": "AISWEB/DECEA",
        "amendment": "2608A1",
        "effectiveDate": "2026-08-06",
        "sourceFile": source_name,
        "notice": "Aeródromos e pistas extraídos do pacote AIXM oficial. Consulte ROTAER, AIP e NOTAM vigentes para uso real.",
        "aerodromes": aerodromes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--aerodromes-output", type=Path)
    parser.add_argument("--inspect", action="store_true")
    arguments = parser.parse_args()
    airspaces, aerodromes, diagnostics = parse_airspaces(arguments.source)
    result = build_geojson(airspaces, arguments.source.name)
    families = sorted({feature["properties"]["family"] for feature in result["features"]})
    print(f"Airspaces: {len(airspaces)} | TMA: {len(families)} famílias | polígonos: {len(result['features'])} | aeródromos: {len(aerodromes)}")
    print("Segmentos:", dict(sorted(diagnostics.items())))
    print("Famílias:", ", ".join(families))
    if arguments.inspect:
        return
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Arquivo criado: {arguments.output}")
    if arguments.aerodromes_output:
        arguments.aerodromes_output.parent.mkdir(parents=True, exist_ok=True)
        arguments.aerodromes_output.write_text(json.dumps(build_aerodrome_catalog(aerodromes, arguments.source.name), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Arquivo criado: {arguments.aerodromes_output}")


if __name__ == "__main__":
    main()
