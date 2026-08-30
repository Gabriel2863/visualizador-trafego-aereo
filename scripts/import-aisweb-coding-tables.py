"""Importa cartas SID/STAR/IAC da AISWEB na arquitetura modular do projeto.

O importador não publica os PDFs e nunca copia latitude/longitude para um JSON
de procedimento. Quando uma tabela de codificação publica uma coordenada que
ainda não existe na base global, ela é acrescentada a ``data/waypoints.json``
com a fonte AISWEB. Assim, os procedimentos continuam contendo apenas relações
entre identificadores e ``coordinate_ref``.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
AISWEB_MARKER = "aisweb-coding-tables-v1"
CATALOG_URL = "https://aisweb.decea.mil.br/?i=cartas"
PROCEDURE_TYPES = {"SID", "STAR", "IAC"}


def load_builder() -> Any:
    source = ROOT / "scripts" / "build-tma-sp.py"
    spec = importlib.util.spec_from_file_location("aisweb_coding_builder", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Não foi possível carregar o leitor de tabelas AISWEB.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILDER = load_builder()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalized(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    return "".join(char for char in text if unicodedata.category(char) != "Mn").upper().strip()


def slug(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalized(value).lower()).strip("-") or "item"


def safe_filename(title: str) -> str:
    value = re.sub(r'[<>:"/\\\\|?*\x00-\x1f]+', "-", title).strip().rstrip(".")
    return value[:150] or "Carta"


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def haversine_meters(first: dict[str, Any], second: dict[str, Any]) -> float:
    radius = 6_371_008.8
    lat1, lon1 = math.radians(float(first["latitude"])), math.radians(float(first["longitude"]))
    lat2, lon2 = math.radians(float(second["latitude"])), math.radians(float(second["longitude"]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


class WaypointStore:
    """Resolve e amplia a única fonte global de coordenadas, com rastreabilidade."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = read_json(path)
        self.features = list(self.data.get("features", []))
        self.by_id = {feature.get("id"): feature for feature in self.features if feature.get("id")}
        self.by_ident: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.by_stable_key: dict[str, dict[str, Any]] = {}
        for feature in self.features:
            properties = feature.get("properties", {})
            ident = normalized(properties.get("ident"))
            if ident:
                self.by_ident[ident].append(feature)
            if properties.get("generated_by") == AISWEB_MARKER and properties.get("source_key"):
                self.by_stable_key[str(properties["source_key"])] = feature
        self.created = 0

    @staticmethod
    def coordinates(feature: dict[str, Any]) -> dict[str, float] | None:
        properties = feature.get("properties", {})
        if finite(properties.get("latitude")) and finite(properties.get("longitude")):
            return {"latitude": float(properties["latitude"]), "longitude": float(properties["longitude"])}
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) >= 2 and finite(coordinates[0]) and finite(coordinates[1]):
            return {"latitude": float(coordinates[1]), "longitude": float(coordinates[0])}
        return None

    def resolve(self, ident: str, published: dict[str, Any] | None, source: str, hidden: bool = False) -> str | None:
        key = normalized(ident)
        if not key:
            return None
        if published and finite(published.get("latitude")) and finite(published.get("longitude")):
            coordinates = {"latitude": float(published["latitude"]), "longitude": float(published["longitude"])}
            candidates = [(haversine_meters(self.coordinates(feature), coordinates), feature) for feature in self.by_ident.get(key, []) if self.coordinates(feature)]
            if candidates:
                distance, nearest = min(candidates, key=lambda item: item[0])
                if distance <= 15:
                    return str(nearest["id"])
            stable_key = f"{key}|{coordinates['latitude']:.8f}|{coordinates['longitude']:.8f}"
            if stable_key in self.by_stable_key:
                return str(self.by_stable_key[stable_key]["id"])
            digest = hashlib.sha1(stable_key.encode("utf-8")).hexdigest()[:14]
            feature = {
                "type": "Feature",
                "id": f"waypoint:aisweb-{digest}",
                "geometry": {"type": "Point", "coordinates": [coordinates["longitude"], coordinates["latitude"]]},
                "properties": {
                    "ident": key,
                    "latitude": coordinates["latitude"],
                    "latitude_gms": None,
                    "longitude": coordinates["longitude"],
                    "longitude_gms": None,
                    "tipo": "AISWEB_CODING_POINT",
                    "point_ref": None,
                    "hidden_on_map": hidden,
                    "generated_by": AISWEB_MARKER,
                    "source_key": stable_key,
                    "source": source,
                },
            }
            self.features.append(feature)
            self.by_id[feature["id"]] = feature
            self.by_ident[key].append(feature)
            self.by_stable_key[stable_key] = feature
            self.created += 1
            return str(feature["id"])
        candidates = self.by_ident.get(key, [])
        return str(candidates[0]["id"]) if len(candidates) == 1 else None

    def save(self) -> None:
        generated = sum(1 for feature in self.features if feature.get("properties", {}).get("generated_by"))
        extension = dict(self.data.get("coordinateExtensions", {}))
        extension["aiswebCodingTables"] = {
            "generatedBy": "scripts/import-aisweb-coding-tables.py",
            "rule": "Coordenadas publicadas pelas tabelas AISWEB são guardadas somente nesta base global; procedimentos mantêm identificadores e coordinate_ref.",
        }
        self.data.update({
            "recordCount": len(self.features),
            "procedurePointCount": generated,
            "coordinateExtensions": extension,
            "features": self.features,
        })
        write_json(self.path, self.data)


def point_in_ring(longitude: float, latitude: float, ring: list[list[float]]) -> bool:
    inside = False
    for current, previous in zip(range(len(ring)), range(-1, len(ring) - 1)):
        current_lon, current_lat = ring[current][:2]
        previous_lon, previous_lat = ring[previous][:2]
        if (current_lat > latitude) != (previous_lat > latitude):
            hit = longitude < (previous_lon - current_lon) * (latitude - current_lat) / ((previous_lat - current_lat) or 1e-12) + current_lon
            if hit:
                inside = not inside
    return inside


def point_in_feature(latitude: float, longitude: float, feature: dict[str, Any]) -> bool:
    geometry = feature.get("geometry", {})
    polygons = [geometry.get("coordinates", [])] if geometry.get("type") == "Polygon" else geometry.get("coordinates", []) if geometry.get("type") == "MultiPolygon" else []
    return any(polygon and polygon[0] and point_in_ring(longitude, latitude, polygon[0]) and not any(point_in_ring(longitude, latitude, ring) for ring in polygon[1:]) for polygon in polygons)


def tma_context(data_root: Path) -> tuple[dict[str, dict[str, Any]], list[tuple[str, dict[str, Any]]], dict[str, str]]:
    catalog = read_json(data_root / "tmas" / "catalog.json")
    entries = {entry["slug"]: entry for entry in catalog.get("tmas", [])}
    family_to_slug = {normalized(entry["name"].replace("TMA ", "", 1)): slug_value for slug_value, entry in entries.items() if not entry.get("technicalGroup")}
    features = [(normalized(feature.get("properties", {}).get("family") or feature.get("properties", {}).get("name")).replace("TMA ", "", 1), feature) for feature in read_json(data_root / "tmas" / "brazil-tmas-aixm.json").get("features", [])]
    airport_slugs: dict[str, str] = {}
    for slug_value, entry in entries.items():
        index_path = data_root.parent / entry["file"]
        tma = read_json(index_path)
        index = read_json(data_root.parent / tma["airportsIndex"])
        for airport in index.get("airports", []):
            airport_slugs[normalized(airport["icao"])] = slug_value
    return entries, features, airport_slugs


def airport_for(airport_id: str, records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    record = records.get(airport_id) or {}
    return {
        "icao": airport_id,
        "name": record.get("name") or airport_id,
        "city": record.get("city") or None,
        "latitude": float(record["lat"]) if finite(record.get("lat")) else None,
        "longitude": float(record["lon"]) if finite(record.get("lon")) else None,
        "elevation_ft": float(record["elevation_ft"]) if finite(record.get("elevation_ft")) else None,
        "runways": record.get("runways") or [],
        "source": record.get("source") or "AISWEB/DECEA — AIXM completo",
        "source_url": record.get("source_url") or "https://aisweb.decea.mil.br/?i=publicacoes&p=aixm",
        "effective_date": record.get("effective_date") or None,
    }


def altitude_model(lower: dict[str, Any] | None, upper: dict[str, Any] | None) -> dict[str, float | None]:
    result: dict[str, float | None] = {"at": None, "min": None, "max": None}
    for value in (lower, upper):
        if not value or not finite(value.get("valueFt")):
            continue
        feet = float(value["valueFt"])
        meaning = value.get("meaning")
        if meaning == "at":
            result["at"] = feet
        elif meaning in {"at-or-above", "recommended", "expected"}:
            result["min"] = feet
        elif meaning == "at-or-below":
            result["max"] = feet
        elif meaning == "between-bound":
            target = "min" if result["min"] is None else "max"
            result[target] = feet
    if result["min"] is not None and result["max"] is not None and result["min"] > result["max"]:
        result["min"], result["max"] = result["max"], result["min"]
    return result


def table_file(tables: Path, item: dict[str, Any]) -> Path | None:
    code = re.sub(r"[^A-Za-z0-9._-]+", "-", item.get("chartCode") or "").strip("-")
    matches = list(tables.glob(f"{item['airport']}_{item['type']}_{code}_coding-table.pdf")) if code else []
    return matches[0] if len(matches) == 1 else None


def source_for(item: dict[str, Any], coding_table: bool) -> dict[str, Any]:
    return {
        "authority": "AISWEB/DECEA",
        "catalog": CATALOG_URL,
        "chartCode": item.get("chartCode"),
        "amendment": item.get("amendment"),
        "effectiveDate": item.get("effectiveDate"),
        "use": item.get("use"),
        "codingTable": coding_table,
    }


def new_procedure(item: dict[str, Any], points: dict[str, Any], legs: list[dict[str, Any]], transitions: list[dict[str, Any]], missed: list[dict[str, Any]], warnings: list[str], coding_table: bool) -> dict[str, Any]:
    title = item["title"]
    runways = BUILDER.parse_runways(title)
    return {
        "schemaVersion": 1,
        "procedure": {
            "id": f"AISWEB-{item['airport']}-{item['type']}-{item.get('chartCode') or slug(title)}",
            "airport": item["airport"],
            "name": title,
            "type": item["type"],
            "runway": runways[0] if runways else None,
            "runways": runways,
            "modes": BUILDER.procedure_mode(item["type"], title),
            "status": "structured-aisweb-coding-table" if coding_table and legs else "catalog-only",
            "source": source_for(item, coding_table),
        },
        "points": points,
        "legs": legs,
        "transitions": transitions,
        "missed_approach": missed,
        "warnings": list(dict.fromkeys(warnings)),
    }


def build_structured_procedure(item: dict[str, Any], table: Path, waypoints: WaypointStore) -> dict[str, Any]:
    rows, published_points, notes = BUILDER.extract_coding_table(table)
    if not rows:
        return new_procedure(item, {}, [], [], [], [*notes, "A tabela de codificação foi localizada, mas nenhuma perna pôde ser extraída; nenhuma geometria foi inferida."], True)
    groups = BUILDER.build_groups(rows)
    transitions_raw, missed_raw = BUILDER.compose_routes(item["type"], groups)
    source_label = f"AISWEB/DECEA — tabela de codificação {item.get('chartCode') or item['title']} / {item.get('amendment') or 'emenda não informada'}"
    fictional = {row.get("fixIdent") for row in rows if "*" in str(row.get("fixIdentRaw") or "")}
    point_metadata: dict[str, dict[str, Any]] = {}
    for row in rows:
        ident = row.get("fixIdent")
        if not ident:
            continue
        existing = point_metadata.setdefault(ident, {"role": row.get("fixRole"), "altitude": altitude_model(row.get("lowerLimitAltitude"), row.get("upperLimitAltitude"))})
        if not existing.get("role") and row.get("fixRole"):
            existing["role"] = row.get("fixRole")
    for route in [*transitions_raw, *missed_raw]:
        for segment in route.get("segments", []):
            for ident in (segment.get("origin"), segment.get("destination"), segment.get("arcCenterFix")):
                if ident:
                    point_metadata.setdefault(ident, {"role": None, "altitude": {"at": None, "min": None, "max": None}})

    points: dict[str, Any] = {}
    warnings = list(notes)
    for ident, metadata in point_metadata.items():
        published = published_points.get(ident)
        reference = waypoints.resolve(ident, published, source_label, hidden=ident in fictional or ident.startswith("RWY"))
        points[ident] = {"ident": ident, "coordinate_ref": reference, "role": metadata["role"], "altitude": metadata["altitude"]}
        if not reference:
            warnings.append(f"FIX/WAYPOINT {ident} não encontrado em data/waypoints.json; segmentos dependentes não serão desenhados.")

    legs: list[dict[str, Any]] = []
    by_signature: dict[tuple[Any, ...], str] = {}

    def convert_segment(segment: dict[str, Any], context: str, index: int, default_origin: str | None = None) -> str:
        origin = segment.get("origin") or default_origin
        destination = segment.get("destination")
        signature = (segment.get("groupId"), segment.get("sequenceNumber"), origin, destination, segment.get("pathTerminator"), context)
        if signature in by_signature:
            return by_signature[signature]
        leg_id = f"{slug(context)}-{index + 1}-{slug(segment.get('groupId') or 'leg')}-{segment.get('sequenceNumber') or 0}"
        course = segment.get("course") or {}
        magnetic = course.get("magnetic") if isinstance(course, dict) else None
        true = course.get("true") if isinstance(course, dict) else None
        lower, upper = segment.get("lowerLimitAltitude"), segment.get("upperLimitAltitude")
        legs.append({
            "id": leg_id,
            "from": origin,
            "to": destination,
            "via": [],
            "path_terminator": segment.get("pathTerminator"),
            "course": magnetic if finite(magnetic) else true if finite(true) else None,
            "course_reference": "MAG" if finite(magnetic) else "TRUE" if finite(true) else None,
            "course_magnetic": float(magnetic) if finite(magnetic) else None,
            "course_true": float(true) if finite(true) else None,
            "distance_nm": segment.get("distanceNm"),
            "turn": segment.get("turn"),
            "arc_center": segment.get("arcCenterFix"),
            "arc_radius_nm": segment.get("arcRadiusNm"),
            "lower_limit": lower,
            "upper_limit": upper,
            "altitude": altitude_model(lower, upper),
            "speed_limit_kt": segment.get("speedLimitKt"),
            "speed_interpretation": segment.get("speedLimitDescription"),
            "vertical_angle": segment.get("verticalAngle"),
            "fly_over": segment.get("flyOver"),
            "fix_role": segment.get("fixRole"),
            "navigation_specification": segment.get("navigationSpecification"),
            "source_page": segment.get("sourcePage"),
        })
        by_signature[signature] = leg_id
        return leg_id

    transitions: list[dict[str, Any]] = []
    for route_index, route in enumerate(transitions_raw, start=1):
        route_legs = [convert_segment(segment, f"transition-{route_index}", index) for index, segment in enumerate(route.get("segments", []))]
        transitions.append({"id": route.get("id") or f"TRANSITION-{route_index}", "name": route.get("name") or f"Transição {route_index}", "kind": route.get("kind") or "published", "sequence": [ident for ident in route.get("sequence", []) if ident in points], "leg_ids": route_legs})

    missed: list[dict[str, Any]] = []
    mapts = [ident for route in transitions_raw for ident in route.get("sequence", []) if point_metadata.get(ident, {}).get("role") == "MAPT"]
    for route_index, route in enumerate(missed_raw, start=1):
        carry_origin = route.get("startMapt") or (mapts[0] if mapts else None)
        route_legs = []
        for index, segment in enumerate(route.get("segments", [])):
            origin = carry_origin if not segment.get("origin") and segment.get("destination") else None
            route_legs.append(convert_segment(segment, f"missed-{route_index}", index, origin))
            if segment.get("destination"):
                carry_origin = segment["destination"]
        sequence = list(route.get("sequence", []))
        if carry_origin and carry_origin not in sequence:
            sequence.insert(0, carry_origin)
        missed.append({"id": route.get("id") or f"MISSED-{route_index}", "name": route.get("name") or "Aproximação perdida", "kind": "MISSED", "sequence": [ident for ident in sequence if ident in points], "legs": [next(leg for leg in legs if leg["id"] == leg_id) for leg_id in route_legs]})

    return new_procedure(item, points, legs, transitions, missed, warnings, True)


def chart_key(airport: str, procedure_type: str, chart_code: str | None, title: str = "") -> tuple[str, str, str]:
    marker = str(chart_code).upper() if chart_code else f"TITLE:{normalized(title)}"
    return airport.upper(), procedure_type.upper(), marker


def existing_chart_files(data_root: Path) -> dict[tuple[str, str, str], Path]:
    result: dict[tuple[str, str, str], Path] = {}
    for file in data_root.glob("tmas/*/airports/*/procedures/*/*.json"):
        try:
            document = read_json(file)
        except json.JSONDecodeError:
            continue
        metadata = document.get("procedure", {})
        source = metadata.get("source", {})
        if isinstance(source, dict) and source.get("authority") == "AISWEB/DECEA":
            result[chart_key(str(metadata.get("airport", "")), str(metadata.get("type", "")), source.get("chartCode"), str(metadata.get("name", "")))] = file
    return result


def unique_file(directory: Path, title: str, chart_code: str | None) -> Path:
    base = safe_filename(title)
    target = directory / f"{base}.json"
    if not target.exists():
        return target
    if chart_code:
        target = directory / f"{base} — {chart_code}.json"
    suffix = 2
    while target.exists():
        target = directory / f"{base} — {chart_code or 'carta'} {suffix}.json"
        suffix += 1
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Converte o catálogo e as tabelas AISWEB para JSONs IFR modulares.")
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--tables", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data")
    parser.add_argument("--audit", type=Path, default=ROOT / "data" / "tmas" / "aisweb-chart-import-audit.json")
    parser.add_argument("--only-airport", action="append", default=[])
    parser.add_argument("--refresh-existing", action="store_true", help="Reinterpreta cartas AISWEB já importadas quando a tabela estiver disponível.")
    parser.add_argument("--offset", type=int, default=0, help="Primeira carta do catálogo a importar; permite execução em lotes retomáveis.")
    parser.add_argument("--max-procedures", type=int, default=0, help="Quantidade máxima de cartas neste lote; 0 importa todas as selecionadas.")
    args = parser.parse_args()

    catalog = read_json(args.catalog)
    selected_airports = {normalized(value) for value in args.only_airport if value.strip()}
    all_items = [item for item in catalog.get("procedures", []) if item.get("type") in PROCEDURE_TYPES and (not selected_airports or normalized(item["airport"]) in selected_airports)]
    items = all_items[max(0, args.offset):]
    if args.max_procedures:
        items = items[:args.max_procedures]
    if not items:
        raise SystemExit("Não há cartas IFR no catálogo com os filtros informados.")
    entries, tma_features, existing_airports = tma_context(args.data_root)
    aerodrome_records = {normalized(item.get("id")): item for item in read_json(args.data_root / "tmas" / "brazil-aerodromes-aixm.json").get("aerodromes", [])}
    waypoints = WaypointStore(args.data_root / "waypoints.json")
    known_chart_files = existing_chart_files(args.data_root)
    audit_rows = []
    counts: Counter[str] = Counter()

    def airport_slug(airport: dict[str, Any]) -> str:
        if airport["icao"] in existing_airports:
            return existing_airports[airport["icao"]]
        if airport["latitude"] is not None and airport["longitude"] is not None:
            matches = [family for family, feature in tma_features if point_in_feature(airport["latitude"], airport["longitude"], feature)]
            if matches:
                selected = entries.get({normalized(entry["name"].replace("TMA ", "", 1)): key for key, entry in entries.items()}.get(matches[0]))
                if selected:
                    return selected["slug"]
        return "sem-tma-associada"

    for item in sorted(items, key=lambda value: (value["airport"], value["type"], value["title"], value.get("chartCode") or "")):
        code_key = chart_key(item["airport"], item["type"], item.get("chartCode"), item["title"])
        existing_file = known_chart_files.get(code_key)
        airport = airport_for(item["airport"], aerodrome_records)
        tma_slug = airport_slug(airport)
        entry = entries[tma_slug]
        airport_root = args.data_root / "tmas" / tma_slug / "airports" / airport["icao"]
        airport_file = airport_root / "airport.json"
        if not airport_file.exists():
            write_json(airport_file, {"schemaVersion": 1, **airport, "tma": entry["id"], "aliases": [], "proceduresIndex": f"data/tmas/{tma_slug}/airports/{airport['icao']}/procedures/index.json"})
        table = table_file(args.tables, item)
        existing_document = read_json(existing_file) if existing_file else None
        existing_status = existing_document.get("procedure", {}).get("status") if existing_document else None
        if existing_file and (not table or (existing_status == "structured-aisweb-coding-table" and not args.refresh_existing)):
            counts["already-present"] += 1
            audit_rows.append({"airport": item["airport"], "type": item["type"], "title": item["title"], "chartCode": item.get("chartCode"), "status": "already-present", "file": existing_file.relative_to(ROOT).as_posix()})
            continue
        if table:
            try:
                procedure = build_structured_procedure(item, table, waypoints)
                status = "structured" if procedure["legs"] else "table-without-legs"
            except Exception as error:
                procedure = new_procedure(item, {}, [], [], [], [f"Falha controlada ao interpretar a tabela AISWEB: {error}", "Nenhuma geometria foi inferida."], True)
                status = "table-read-error"
        else:
            procedure = new_procedure(item, {}, [], [], [], ["A AISWEB não disponibiliza tabela de codificação para esta carta neste ciclo; nenhuma geometria foi inferida."], False)
            status = "catalog-only"
        directory = airport_root / "procedures" / item["type"]
        directory.mkdir(parents=True, exist_ok=True)
        file = existing_file or unique_file(directory, item["title"], item.get("chartCode"))
        write_json(file, procedure)
        counts[status] += 1
        audit_rows.append({"airport": item["airport"], "tma": entry["id"], "type": item["type"], "title": item["title"], "chartCode": item.get("chartCode"), "status": status, "file": file.relative_to(ROOT).as_posix(), "pointCount": len(procedure["points"]), "legCount": len(procedure["legs"]), "transitionCount": len(procedure["transitions"]), "warningCount": len(procedure["warnings"])})

    waypoints.save()
    audit = {
        "schemaVersion": 1,
        "generatedBy": "scripts/import-aisweb-coding-tables.py",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "authority": "AISWEB/DECEA",
        "catalog": CATALOG_URL,
        "sourceCycle": {"amendments": sorted({item.get("amendment") for item in items if item.get("amendment")}), "effectiveDates": sorted({item.get("effectiveDate") for item in items if item.get("effectiveDate")})},
        "coordinateSource": "data/waypoints.json",
        "summary": {"catalogProcedures": len(items), "newWaypointFeatures": waypoints.created, **dict(sorted(counts.items()))},
        "batch": {"offset": max(0, args.offset), "available": len(all_items), "count": len(items)},
        "records": audit_rows,
        "notes": ["Os PDFs brutos de cartas e tabelas permanecem em tmp/ e não são publicados.", "Cartas sem tabela de codificação aparecem no seletor com status catalog-only; nenhuma trajetória é inventada.", "Todos os JSONs de procedimento contêm somente identificadores e coordinate_ref; latitude/longitude ficam exclusivamente em data/waypoints.json."],
    }
    write_json(args.audit, audit)
    print(json.dumps(audit["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
