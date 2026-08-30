from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import pdfplumber


AIRPORTS = {
    "SBSP": "Congonhas - Deputado Freitas Nobre",
    "SBGR": "Guarulhos - Governador André Franco Montoro",
    "SBSJ": "São José dos Campos - Professor Urbano Ernesto Stumpf",
    "SBKP": "Viracopos",
    "SBJH": "São Paulo Catarina",
    "SBJD": "Jundiaí - Comandante Rolim Adolfo Amaro",
    "SDCO": "Sorocaba",
    "SDAM": "Campos dos Amarais - Prefeito Francisco Amaral",
}

NA_VALUES = {"", "N/A", "NA", "NIL", "NONE"}
ROW_FIELDS = (
    "sequenceNumber",
    "transitionIdentifier",
    "flyOver",
    "recommendedNavaid",
    "fixIdent",
    "pathTerminator",
    "courseAngle",
    "turn",
    "upperLimitAltitudeFt",
    "lowerLimitAltitudeFt",
    "speedLimitKt",
    "speedLimitDescription",
    "distanceNm",
    "verticalAngle",
    "fixRole",
    "navigationSpecification",
)

# A tabela de codificação da AISWEB é publicada com 16 campos semânticos, mas
# muitos PDFs incluem duas colunas vazias de espaçamento (após Speed Limit e
# Role Of The Fix).  O pdfplumber as preserva, resultando em 18 células.  Não
# as descartamos pelo tamanho da linha: removemos somente essas colunas vazias
# conhecidas para manter as pernas, os rumos e as restrições publicados.
CODING_TABLE_VISUAL_COLUMNS = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 17)


def canonical_table_row(values: list[Any]) -> list[Any] | None:
    """Converte uma linha visual de uma tabela AISWEB nos 16 campos lógicos."""
    if len(values) == len(ROW_FIELDS):
        return values
    if len(values) >= max(CODING_TABLE_VISUAL_COLUMNS) + 1:
        return [values[index] for index in CODING_TABLE_VISUAL_COLUMNS]
    return None


def text(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", str(value)).strip()
    return None if cleaned.upper() in NA_VALUES else cleaned


def safe_code(value: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value or "")


def clean_ident(value: Any) -> str | None:
    value = text(value)
    if not value:
        return None
    value = value.rstrip("*").upper()
    runway = re.fullmatch(r"RWY\s*((?:0[1-9]|[12]\d|3[0-6])[LRC]?)", value)
    return f"RWY{runway.group(1)}" if runway else value


def slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")


def parse_number(value: Any) -> float | None:
    value = text(value)
    if not value:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    return float(match.group()) if match else None


def parse_course(value: Any) -> dict[str, float] | None:
    value = text(value)
    if not value:
        return None
    result: dict[str, float] = {}
    magnetic = re.search(r"(-?\d+(?:\.\d+)?)\D+Mag", value, re.I)
    true = re.search(r"(-?\d+(?:\.\d+)?)\D+True", value, re.I)
    if magnetic:
        result["magnetic"] = float(magnetic.group(1))
    if true:
        result["true"] = float(true.group(1))
    return result or None


def parse_altitude(value: Any) -> dict[str, Any] | None:
    value = text(value)
    if not value:
        return None
    prefix = value[0] if value[0] in "+-@RB=" else None
    number = parse_number(value)
    meanings = {
        "+": "at-or-above",
        "-": "at-or-below",
        "@": "at",
        "R": "recommended",
        "B": "between-bound",
        "=": "assigned",
    }
    return {"raw": value, "valueFt": number, "meaning": meanings.get(prefix, "published")}


def parse_dms(value: str) -> tuple[float, float] | None:
    match = re.search(
        r"([NS])\s*(\d{1,2})[:\s]+(\d{2})[:\s]+(\d{2}(?:\.\d+)?)\s*([EW])\s*(\d{1,3})[:\s]+(\d{2})[:\s]+(\d{2}(?:\.\d+)?)",
        value,
        re.I,
    )
    if not match:
        return None
    lat_hemi, lat_d, lat_m, lat_s, lon_hemi, lon_d, lon_m, lon_s = match.groups()
    lat = int(lat_d) + int(lat_m) / 60 + float(lat_s) / 3600
    lon = int(lon_d) + int(lon_m) / 60 + float(lon_s) / 3600
    if lat_hemi.upper() == "S":
        lat = -lat
    if lon_hemi.upper() == "W":
        lon = -lon
    return lat, lon


def parse_runways(title: str) -> list[str]:
    runway_text = title.split("RWY", 1)[1] if "RWY" in title else ""
    return list(dict.fromkeys(re.findall(r"\b(?:0[1-9]|[12]\d|3[0-6])[LRC]?\b", runway_text)))


def procedure_mode(procedure_type: str, title: str) -> list[str]:
    upper = title.upper()
    if procedure_type != "IAC":
        return ["RNAV"] if "RNAV" in upper else ["OMNI"] if "OMNI" in upper else []
    modes = [mode for mode in ("ILS", "LOC", "RNP", "VOR", "NDB") if re.search(rf"\b{mode}\b", upper)]
    return modes or [upper.split()[0]]


def table_path(tables_dir: Path, item: dict[str, Any]) -> Path | None:
    code = safe_code(item.get("chartCode"))
    matches = list(tables_dir.glob(f"{item['airport']}_{item['type']}_{code}_coding-table.pdf"))
    return matches[0] if len(matches) == 1 else None


def normalize_leg(record: dict[str, Any], page_number: int) -> dict[str, Any]:
    normalized = {key: text(record.get(key)) for key in ROW_FIELDS}
    normalized["sequenceNumber"] = int(normalized["sequenceNumber"] or 0)
    normalized["fixIdentRaw"] = normalized["fixIdent"]
    normalized["fixIdent"] = clean_ident(normalized["fixIdent"])
    normalized["recommendedNavaid"] = clean_ident(normalized["recommendedNavaid"])
    normalized["course"] = parse_course(normalized.pop("courseAngle"))
    normalized["distanceNm"] = parse_number(normalized["distanceNm"])
    normalized["verticalAngle"] = parse_number(normalized["verticalAngle"])
    normalized["speedLimitKt"] = parse_number(normalized["speedLimitKt"])
    normalized["upperLimitAltitude"] = parse_altitude(normalized.pop("upperLimitAltitudeFt"))
    normalized["lowerLimitAltitude"] = parse_altitude(normalized.pop("lowerLimitAltitudeFt"))
    normalized["sourcePage"] = page_number
    return normalized


def extract_rows_from_text(page_text: str, page_number: int) -> list[dict[str, Any]]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in page_text.splitlines()]
    starts = [index for index, line in enumerate(lines) if re.match(r"^\d+\s+\S+\s+", line)]
    rows = []
    navigation_suffixes = (
        "RNAV 1 or RNP 1",
        "RNP 1 or RNAV 1",
        "RNP APCH",
        "RNAV 1",
        "RNP 1",
        "N/A",
    )
    for start in starts:
        block = lines[start]
        match = re.match(r"^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Z]{2})\s+(.+)$", block)
        if not match:
            continue
        seq, transition, fly_over, navaid, fix, path, remainder = match.groups()
        navigation = next((suffix for suffix in navigation_suffixes if remainder.endswith(suffix)), None)
        if not navigation:
            continue
        remainder = remainder[: -len(navigation)].strip()
        tokens = remainder.split()
        if len(tokens) < 8:
            continue
        role = tokens.pop()
        vertical_angle = tokens.pop()
        if tokens and tokens[-1].lower() == "min" and len(tokens) >= 2:
            distance = f"{tokens[-2]} {tokens[-1]}"
            del tokens[-2:]
        else:
            distance = tokens.pop()
        speed_description = tokens.pop()
        speed = tokens.pop()
        lower = tokens.pop()
        upper = tokens.pop()
        turn = tokens.pop()
        course = " ".join(tokens)
        if not course:
            previous_course_lines = []
            for previous_index in range(start - 1, max(-1, start - 3), -1):
                previous_line = lines[previous_index]
                if re.search(r"\b(?:Mag|True)\b", previous_line, re.I):
                    previous_course_lines.insert(0, previous_line)
                else:
                    break
            course = " ".join(previous_course_lines) or "N/A"
        rows.append(
            normalize_leg(
                {
                    "sequenceNumber": seq,
                    "transitionIdentifier": transition,
                    "flyOver": fly_over,
                    "recommendedNavaid": navaid,
                    "fixIdent": fix,
                    "pathTerminator": path,
                    "courseAngle": course,
                    "turn": turn,
                    "upperLimitAltitudeFt": upper,
                    "lowerLimitAltitudeFt": lower,
                    "speedLimitKt": speed,
                    "speedLimitDescription": speed_description,
                    "distanceNm": distance,
                    "verticalAngle": vertical_angle,
                    "fixRole": role,
                    "navigationSpecification": navigation,
                },
                page_number,
            )
        )
    return rows


def extract_coding_table(path: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    points: dict[str, dict[str, Any]] = {}
    notes: list[str] = []
    page_texts: list[tuple[int, str]] = []
    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            page_text = page.extract_text() or ""
            page_texts.append((page_number, page_text))
            for line in page_text.splitlines():
                if "Fictitious point" in line or "FICTITIOUS" in line.upper():
                    notes.append(text(line) or line)
            for table in page.extract_tables():
                pending_row: list[Any] | None = None
                orphan_row: list[Any] | None = None
                pending_extras: dict[str, Any] = {}

                def flush_pending() -> None:
                    nonlocal pending_row, pending_extras
                    if pending_row and text(pending_row[0]) and str(text(pending_row[0])).isdigit():
                        leg = normalize_leg(dict(zip(ROW_FIELDS, pending_row)), page_number)
                        leg.update(pending_extras)
                        rows.append(leg)
                    pending_row = None
                    pending_extras = {}

                def merge_cells(target: list[Any], source: list[Any]) -> None:
                    for index, value in enumerate(source):
                        value_text = text(value)
                        if not value_text:
                            continue
                        existing = text(target[index])
                        if not existing:
                            target[index] = value_text
                        elif index == 6 and value_text not in existing:
                            target[index] = f"{existing} {value_text}"

                for raw_row in table:
                    if not raw_row:
                        continue
                    values = list(raw_row)
                    logical_values = canonical_table_row(values)
                    if logical_values is not None:
                        values = logical_values
                        header_text = " ".join(str(value or "") for value in values).upper()
                        if (
                            "FIX IDENT" in header_text
                            or "FLY OVER" in header_text
                            or ("TRANSITION" in header_text and "NAVIGATION" in header_text)
                            # Algumas tabelas dividem o cabeçalho em duas linhas;
                            # a segunda começa em "Identifier" e antes era mesclada
                            # indevidamente à primeira perna publicada.
                            or ("IDENTIFIER" in header_text and "TERMINATOR" in header_text and "ALTITUDE" in header_text)
                        ):
                            continue
                        first_raw = re.sub(r"\s+", " ", str(values[0] or "")).strip()
                        first = text(values[0])
                        if first and str(first).isdigit():
                            flush_pending()
                            pending_row = values
                            if orphan_row:
                                merge_cells(pending_row, orphan_row)
                                orphan_row = None
                        elif pending_row and first_raw.upper() in {"N/A", "NA"}:
                            arc_center = clean_ident(values[4])
                            if arc_center:
                                pending_extras["arcCenterFix"] = arc_center
                            arc_radius = parse_number(values[12])
                            if arc_radius is not None:
                                pending_extras["arcRadiusNm"] = arc_radius
                        elif any(text(value) for value in values):
                            incoming_has_core = bool(text(values[5]))
                            pending_has_core = bool(pending_row and text(pending_row[5]))
                            if pending_row and incoming_has_core and pending_has_core:
                                flush_pending()
                                orphan_row = values
                            elif pending_row:
                                merge_cells(pending_row, values)
                            else:
                                orphan_row = values
                        continue

                    if len(values) == 2:
                        ident = clean_ident(values[0])
                        coordinate_text = text(values[1])
                        coordinate = parse_dms(coordinate_text or "")
                        if ident and coordinate:
                            points[ident] = {
                                "latitude": round(coordinate[0], 9),
                                "longitude": round(coordinate[1], 9),
                                "published": coordinate_text,
                                "sourcePage": page_number,
                            }
                            if re.fullmatch(r"(?:0[1-9]|[12]\d|3[0-6])[LRC]?", ident):
                                points[f"RWY{ident}"] = {**points[ident]}
                flush_pending()
            for line in page_text.splitlines():
                coordinate = parse_dms(line)
                if not coordinate:
                    continue
                runway_match = re.match(r"\s*RWY\s*((?:0[1-9]|[12]\d|3[0-6])[LRC]?)\s+", line, re.I)
                ident_match = runway_match or re.match(
                    r"\s*(?:(?:VOR/DME|DVOR/DME|VOR|DME|NDB)\s+)?([A-Z0-9*]{2,10})\s+", line, re.I
                )
                ident = f"RWY{runway_match.group(1).upper()}" if runway_match else clean_ident(ident_match.group(1)) if ident_match else None
                if ident:
                    points.setdefault(
                        ident,
                        {
                            "latitude": round(coordinate[0], 9),
                            "longitude": round(coordinate[1], 9),
                            "published": text(line[len(ident_match.group(0)) :]) or text(line),
                            "sourcePage": page_number,
                        },
                    )
                    if re.fullmatch(r"(?:0[1-9]|[12]\d|3[0-6])[LRC]?", ident):
                        points.setdefault(f"RWY{ident}", {**points[ident]})
    text_rows: list[dict[str, Any]] = []
    for page_number, page_text in page_texts:
        text_rows.extend(extract_rows_from_text(page_text, page_number))

    text_by_key: dict[tuple[str | None, int], list[dict[str, Any]]] = defaultdict(list)
    for row in text_rows:
        text_by_key[(row.get("transitionIdentifier"), row["sequenceNumber"])].append(row)
    for row in rows:
        if row.get("fixIdent") and row.get("pathTerminator"):
            continue
        candidates = text_by_key.get((row.get("transitionIdentifier"), row["sequenceNumber"]), [])
        replacement = next((candidate for candidate in candidates if candidate.get("fixIdent") or candidate.get("pathTerminator")), None)
        if replacement:
            source_page = row["sourcePage"]
            row.update(replacement)
            row["sourcePage"] = source_page

    def extraction_quality(candidate: list[dict[str, Any]]) -> tuple[int, int, int]:
        return (
            sum(bool(row.get("fixIdent") and row.get("pathTerminator")) for row in candidate),
            sum(bool(row.get("course")) for row in candidate),
            len(candidate),
        )

    if extraction_quality(text_rows) > extraction_quality(rows):
        rows = text_rows
    return rows, points, list(dict.fromkeys(notes))


def build_groups(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    occurrence: Counter[str] = Counter()
    current: dict[str, Any] | None = None
    previous_sequence = -1
    for row in rows:
        published_id = row.get("transitionIdentifier") or "UNSPECIFIED"
        if current is None or published_id != current["publishedId"] or row["sequenceNumber"] <= previous_sequence:
            occurrence[published_id] += 1
            current = {
                "id": f"{published_id}-{occurrence[published_id]}",
                "publishedId": published_id,
                "legs": [],
            }
            groups.append(current)
        current["legs"].append(row)
        previous_sequence = row["sequenceNumber"]

    for group in groups:
        fixes = [leg["fixIdent"] for leg in group["legs"] if leg.get("fixIdent")]
        group["sequence"] = list(dict.fromkeys(fixes)) if fixes else []
        group["firstFix"] = fixes[0] if fixes else None
        group["lastFix"] = fixes[-1] if fixes else None
    return groups


def classify_group(procedure_type: str, group: dict[str, Any]) -> str:
    ident = group["publishedId"].upper()
    roles = {str(leg.get("fixRole") or "").upper() for leg in group["legs"]}
    if procedure_type == "IAC":
        if ident in {"MA", "MISSED", "MISED"} or "MAHF" in roles:
            return "missed-approach"
        if ident == "FINAL" or "FAF" in roles or "MAPT" in roles:
            return "final"
        return "approach-transition"
    if procedure_type == "SID":
        if ident.startswith("RW"):
            return "runway-transition"
        if ident in {"COMMON", "COMON"}:
            return "common"
        return "enroute-transition"
    if ident.startswith("RW") or ident in {"COMMON", "COMON"}:
        return "common"
    return "enroute-transition"


def route_from_groups(route_id: str, name: str, groups: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    sequence: list[str] = []
    segments: list[dict[str, Any]] = []
    previous_fix: str | None = None
    for group in groups:
        for leg in group["legs"]:
            fix = leg.get("fixIdent")
            path = (leg.get("pathTerminator") or "").upper()
            if fix and (not sequence or sequence[-1] != fix):
                sequence.append(fix)

            if path == "IF":
                origin = None
                destination = fix
                previous_fix = fix
            elif fix:
                origin = previous_fix
                destination = fix
                previous_fix = fix
            else:
                origin = previous_fix
                destination = None
                if path in {"CA", "CD", "CI", "CR", "VA", "VD", "VI", "VM", "VR"}:
                    previous_fix = None

            segments.append(
                {
                    "groupId": group["id"],
                    "sequenceNumber": leg["sequenceNumber"],
                    "origin": origin,
                    "destination": destination,
                    "pathTerminator": leg.get("pathTerminator"),
                    "course": leg.get("course"),
                    "distanceNm": leg.get("distanceNm"),
                    "turn": leg.get("turn"),
                    "flyOver": leg.get("flyOver"),
                    "recommendedNavaid": leg.get("recommendedNavaid"),
                    "upperLimitAltitude": leg.get("upperLimitAltitude"),
                    "lowerLimitAltitude": leg.get("lowerLimitAltitude"),
                    "speedLimitKt": leg.get("speedLimitKt"),
                    "speedLimitDescription": leg.get("speedLimitDescription"),
                    "verticalAngle": leg.get("verticalAngle"),
                    "fixRole": leg.get("fixRole"),
                    "navigationSpecification": leg.get("navigationSpecification"),
                    "arcCenterFix": leg.get("arcCenterFix"),
                    "arcRadiusNm": leg.get("arcRadiusNm"),
                    "sourcePage": leg.get("sourcePage"),
                    "geometryStatus": "plottable" if origin and destination else "non-geometric-leg",
                }
            )
    return {
        "id": route_id,
        "name": name,
        "kind": kind,
        "publishedGroupIds": [group["id"] for group in groups],
        "sequence": sequence,
        "segments": segments,
    }


def exact_link(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return bool(left.get("lastFix") and left.get("lastFix") == right.get("firstFix"))


def unique_route_ids(routes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: Counter[str] = Counter()
    for route in routes:
        base = route["id"] or "route"
        seen[base] += 1
        if seen[base] > 1:
            group_suffix = slug("-".join(route.get("publishedGroupIds", []))) or str(seen[base])
            route["id"] = f"{base}-{group_suffix}"
    return routes


def compose_routes(procedure_type: str, groups: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    for group in groups:
        group["kind"] = classify_group(procedure_type, group)

    missed_groups = [group for group in groups if group["kind"] == "missed-approach"]
    normal_groups = [group for group in groups if group["kind"] != "missed-approach"]
    routes: list[dict[str, Any]] = []
    missed: list[dict[str, Any]] = []

    if procedure_type == "IAC":
        approach = [group for group in normal_groups if group["kind"] == "approach-transition"]
        finals = [group for group in normal_groups if group["kind"] == "final"]
        if approach:
            for group in approach:
                matches = [final for final in finals if exact_link(group, final)]
                selected = matches or []
                if selected:
                    for final in selected:
                        entry = group.get("firstFix") or group["id"]
                        routes.append(route_from_groups(slug(str(entry)), f"Entrada {entry}", [group, final], "approach"))
                else:
                    entry = group.get("firstFix") or group["id"]
                    route = route_from_groups(slug(str(entry)), f"Entrada {entry} (conexao final nao confirmada)", [group], "approach")
                    route["compositionStatus"] = "not-confirmed"
                    routes.append(route)
        else:
            for final in finals:
                routes.append(route_from_groups(slug(str(final.get("firstFix") or final["id"])), "Sequencia final publicada", [final], "approach"))

        mapts = []
        for final in finals:
            for leg in final["legs"]:
                if str(leg.get("fixRole") or "").upper() == "MAPT" and leg.get("fixIdent"):
                    mapts.append(leg["fixIdent"])
        for index, group in enumerate(missed_groups, start=1):
            route = route_from_groups(f"missed-{index}", "Aproximacao perdida", [group], "missed-approach")
            if mapts and (not route["sequence"] or route["sequence"][0] != mapts[0]):
                route["sequence"].insert(0, mapts[0])
                route["startMapt"] = mapts[0]
            missed.append(route)
        return unique_route_ids(routes), unique_route_ids(missed)

    if procedure_type == "STAR":
        common = [group for group in normal_groups if group["kind"] == "common"]
        entries = [group for group in normal_groups if group["kind"] != "common"]
        if common:
            for common_group in common:
                entry = common_group.get("firstFix") or common_group["id"]
                routes.append(route_from_groups(slug(str(entry)), f"Entrada {entry}", [common_group], "arrival"))
                for group in entries:
                    if exact_link(group, common_group):
                        entry = group.get("firstFix") or group["id"]
                        routes.append(route_from_groups(slug(str(entry)), f"Transicao {entry}", [group, common_group], "arrival"))
        else:
            for group in entries:
                entry = group.get("firstFix") or group["id"]
                routes.append(route_from_groups(slug(str(entry)), f"Transicao {entry}", [group], "arrival"))
        return unique_route_ids(routes), unique_route_ids(missed)

    runway_groups = [group for group in normal_groups if group["kind"] == "runway-transition"]
    common_groups = [group for group in normal_groups if group["kind"] == "common"]
    exits = [group for group in normal_groups if group["kind"] == "enroute-transition"]
    bases: list[list[dict[str, Any]]] = []
    if runway_groups:
        for runway in runway_groups:
            matches = [common for common in common_groups if exact_link(runway, common)]
            bases.extend([[runway, common] for common in matches] or [[runway]])
    elif common_groups:
        bases = [[common] for common in common_groups]

    if bases:
        for base in bases:
            matches = [exit_group for exit_group in exits if exact_link(base[-1], exit_group)]
            if matches:
                for exit_group in matches:
                    runway = base[0]["publishedId"]
                    exit_name = exit_group.get("lastFix") or exit_group["publishedId"]
                    routes.append(route_from_groups(slug(f"{runway}-{exit_name}"), f"{runway} - {exit_name}", [*base, exit_group], "departure"))
            else:
                runway = base[0]["publishedId"]
                routes.append(route_from_groups(slug(runway), runway, base, "departure"))
    else:
        for group in exits or normal_groups:
            exit_name = group.get("lastFix") or group["publishedId"]
            routes.append(route_from_groups(slug(str(exit_name)), str(exit_name), [group], "departure"))
    return unique_route_ids(routes), unique_route_ids(missed)


def build_procedure(item: dict[str, Any], tables_dir: Path, chart_catalog: dict[str, Any]) -> dict[str, Any]:
    procedure_id = f"{item['airport']}-{item['type']}-{item.get('chartCode') or slug(item['title'])}"
    source = {
        "authority": "AISWEB/DECEA",
        "catalog": "https://aisweb.decea.mil.br/?i=cartas",
        "chartCode": item.get("chartCode"),
        "amendment": item.get("amendment"),
        "effectiveDate": item.get("effectiveDate"),
        "use": item.get("use"),
        "chartPage": 1,
    }
    procedure = {
        "id": procedure_id,
        "name": item["title"],
        "type": item["type"],
        "airport": item["airport"],
        "runways": parse_runways(item["title"]),
        "modes": procedure_mode(item["type"], item["title"]),
        "source": source,
        "status": "structured",
        "transitions": [],
        "publishedGroups": [],
        "publishedPoints": {},
        "missedApproach": [],
        "notes": [],
    }

    path = table_path(tables_dir, item)
    if not path:
        matching_chart = next(
            (
                chart
                for chart in chart_catalog.get("charts", [])
                if chart.get("airport") == item["airport"]
                and chart.get("type") == item["type"]
                and chart.get("title") == item["title"]
            ),
            None,
        )
        procedure["status"] = "text-only"
        procedure["publishedText"] = "\n\n".join((matching_chart or {}).get("pageTexts", [])) or None
        procedure["notes"].append("AISWEB nao disponibiliza tabela de codificacao para esta carta; nenhuma sequencia de FIX foi inferida.")
        return procedure

    rows, points, notes = extract_coding_table(path)
    groups = build_groups(rows)
    transitions, missed = compose_routes(item["type"], groups)
    procedure["transitions"] = transitions
    procedure["publishedGroups"] = groups
    procedure["publishedPoints"] = points
    procedure["missedApproach"] = missed
    procedure["notes"] = notes
    procedure["source"]["codingTablePages"] = sorted({leg["sourcePage"] for group in groups for leg in group["legs"]})
    if not rows:
        procedure["status"] = "not-confirmed"
        procedure["notes"].append("A tabela de codificacao foi localizada, mas nenhuma linha de perna foi extraida.")
    return procedure


def waypoint_index(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(feature.get("properties", {}).get("ident", "")).upper(): feature
        for feature in data.get("features", [])
        if feature.get("properties", {}).get("ident")
    }


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    value = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def build_connections(procedures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    connections = []
    stars = [procedure for procedure in procedures if procedure["type"] == "STAR"]
    approaches = [procedure for procedure in procedures if procedure["type"] == "IAC"]
    for star in stars:
        for star_transition in star["transitions"]:
            if not star_transition["sequence"]:
                continue
            connection_fix = star_transition["sequence"][-1]
            for approach in approaches:
                if approach["airport"] != star["airport"]:
                    continue
                if star["runways"] and approach["runways"] and not set(star["runways"]) & set(approach["runways"]):
                    continue
                for approach_transition in approach["transitions"]:
                    if approach_transition["sequence"] and approach_transition["sequence"][0] == connection_fix:
                        connections.append(
                            {
                                "fromProcedure": star["id"],
                                "fromTransition": star_transition["id"],
                                "waypoint": connection_fix,
                                "toProcedure": approach["id"],
                                "toTransition": approach_transition["id"],
                                "status": "confirmed-by-published-fix",
                                "evidence": [star["source"], approach["source"]],
                            }
                        )
    return connections


def current_chart_key(airport: str, procedure_type: str, chart_code: str | None) -> str | None:
    if not chart_code:
        return None
    normalized = re.sub(r"[^A-Z0-9]", "", chart_code.upper())
    airport_prefix = airport[2:]
    if normalized.startswith(airport_prefix):
        normalized = normalized[len(airport_prefix) :]
    return f"{airport}_{procedure_type}_{normalized}" if normalized else None


def build_source_divergences(procedures: list[dict[str, Any]], provided_catalog_path: Path) -> list[dict[str, Any]]:
    if not provided_catalog_path.exists():
        return [{"type": "provided-catalog-unavailable", "source": str(provided_catalog_path)}]

    provided_catalog = json.loads(provided_catalog_path.read_text(encoding="utf-8"))
    provided_by_key: dict[str, dict[str, Any]] = {}
    unmatched_provided = []
    for chart in provided_catalog.get("charts", []):
        combined_text = "\n".join(chart.get("pageTexts", []))
        identifier = re.search(r"\b(SB[A-Z]{2})_(SID|STAR|IAC)_([A-Z0-9]+)\b", combined_text, re.I)
        amendment = re.search(r"(?:AIRAC\s+)?AMDT\s+([0-9]{4}A[0-9])", combined_text, re.I)
        if identifier:
            key = f"{identifier.group(1).upper()}_{identifier.group(2).upper()}_{identifier.group(3).upper()}"
            provided_by_key[key] = {
                "file": chart.get("file"),
                "name": chart.get("name"),
                "amendment": amendment.group(1).upper() if amendment else None,
            }
        else:
            unmatched_provided.append({"file": chart.get("file"), "name": chart.get("name"), "reason": "chart-identifier-not-extracted"})

    divergences = []
    matched_keys = set()
    for procedure in procedures:
        source = procedure["source"]
        key = current_chart_key(procedure["airport"], procedure["type"], source.get("chartCode"))
        if not key:
            continue
        provided = provided_by_key.get(key)
        if not provided:
            divergences.append(
                {
                    "type": "official-current-chart-not-in-provided-folder",
                    "procedure": procedure["id"],
                    "chart": source.get("chartCode"),
                    "currentAmendment": source.get("amendment"),
                    "currentEffectiveDate": source.get("effectiveDate"),
                    "authoritativeSource": "AISWEB/DECEA",
                }
            )
            continue
        matched_keys.add(key)
        if provided.get("amendment") and provided["amendment"] != source.get("amendment"):
            divergences.append(
                {
                    "type": "provided-chart-version-differs-from-current",
                    "procedure": procedure["id"],
                    "chart": source.get("chartCode"),
                    "providedAmendment": provided.get("amendment"),
                    "currentAmendment": source.get("amendment"),
                    "currentEffectiveDate": source.get("effectiveDate"),
                    "providedFile": provided.get("file"),
                    "authoritativeSource": "AISWEB/DECEA",
                }
            )

    for key, provided in provided_by_key.items():
        if key not in matched_keys:
            divergences.append(
                {
                    "type": "provided-chart-not-matched-to-current-aisweb",
                    "chartKey": key,
                    "providedAmendment": provided.get("amendment"),
                    "providedFile": provided.get("file"),
                }
            )
    divergences.extend({"type": "provided-chart-not-machine-readable", **entry} for entry in unmatched_provided)
    return divergences


def build_audit(
    procedures: list[dict[str, Any]],
    connections: list[dict[str, Any]],
    waypoints: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    missing: dict[tuple[str, str], dict[str, Any]] = {}
    terminal_points: dict[str, dict[str, Any]] = {}
    coordinate_divergences = []

    for procedure in procedures:
        referenced = set()
        for transition in procedure["transitions"]:
            referenced.update(transition["sequence"])
        for missed in procedure["missedApproach"]:
            referenced.update(missed["sequence"])

        for ident in sorted(referenced):
            published = procedure["publishedPoints"].get(ident)
            if ident not in waypoints:
                key = (ident, procedure["id"])
                missing[key] = {
                    "fix": ident,
                    "procedure": procedure["id"],
                    "chart": procedure["source"].get("chartCode"),
                    "page": (published or {}).get("sourcePage"),
                    "publishedCoordinate": (published or {}).get("published"),
                    "reason": "Nao encontrado em data/waypoints.json",
                }
                if published:
                    terminal_points.setdefault(
                        ident,
                        {
                            "ident": ident,
                            "latitude": published["latitude"],
                            "longitude": published["longitude"],
                            "published": published["published"],
                            "source": {
                                "procedure": procedure["id"],
                                "chart": procedure["source"].get("chartCode"),
                                "codingTablePage": published["sourcePage"],
                            },
                        },
                    )
            elif published:
                properties = waypoints[ident].get("properties", {})
                distance = haversine_meters(
                    float(properties["latitude"]),
                    float(properties["longitude"]),
                    published["latitude"],
                    published["longitude"],
                )
                if distance > 100:
                    coordinate_divergences.append(
                        {
                            "fix": ident,
                            "procedure": procedure["id"],
                            "distanceMeters": round(distance, 1),
                            "waypointsJson": [properties["latitude"], properties["longitude"]],
                            "codingTable": [published["latitude"], published["longitude"]],
                        }
                    )
                    terminal_points.setdefault(
                        ident,
                        {
                            "ident": ident,
                            "latitude": published["latitude"],
                            "longitude": published["longitude"],
                            "published": published["published"],
                            "reason": "waypoints-coordinate-divergence",
                            "source": {
                                "procedure": procedure["id"],
                                "chart": procedure["source"].get("chartCode"),
                                "codingTablePage": published["sourcePage"],
                            },
                        },
                    )

    type_counts = Counter(procedure["type"] for procedure in procedures)
    structured = [procedure["id"] for procedure in procedures if procedure["status"] == "structured"]
    incomplete = [procedure["id"] for procedure in procedures if procedure["status"] != "structured"]
    all_routes = [route for procedure in procedures for route in [*procedure["transitions"], *procedure["missedApproach"]]]
    all_segments = [segment for route in all_routes for segment in route["segments"]]
    known_points = set(waypoints) | set(terminal_points)
    unresolved_coordinates = sorted(
        {
            ident
            for route in all_routes
            for ident in route["sequence"]
            if ident not in known_points
        }
    )
    audit = {
        "auditDate": date.today().isoformat(),
        "sourceCycle": "AISWEB AMDT 34/26 - effective 2026-08-06",
        "totals": {
            "SID": type_counts["SID"],
            "STAR": type_counts["STAR"],
            "IAC": type_counts["IAC"],
            "missedApproaches": sum(bool(procedure["missedApproach"]) for procedure in procedures if procedure["type"] == "IAC"),
            "transitions": sum(len(procedure["transitions"]) for procedure in procedures),
            "starToIacConnections": len(connections),
        },
        "procedures": [
            {
                "id": procedure["id"],
                "name": procedure["name"],
                "type": procedure["type"],
                "airport": procedure["airport"],
                "status": procedure["status"],
            }
            for procedure in procedures
        ],
        "implemented": structured,
        "stillMissing": incomplete,
        "missingWaypoints": list(missing.values()),
        "coordinateDivergences": coordinate_divergences,
        "qualityChecks": {
            "uniqueProcedureIds": len({procedure["id"] for procedure in procedures}) == len(procedures),
            "uniqueTransitionIdsPerProcedure": all(
                len({route["id"] for route in procedure["transitions"]}) == len(procedure["transitions"])
                for procedure in procedures
            ),
            "emptyPublishedLegs": sum(
                not leg.get("fixIdent") and not leg.get("pathTerminator")
                for procedure in procedures
                for group in procedure["publishedGroups"]
                for leg in group["legs"]
            ),
            "unresolvedCoordinates": unresolved_coordinates,
            "rfSegments": sum(segment.get("pathTerminator") == "RF" for segment in all_segments),
            "rfSegmentsWithPublishedCenter": sum(
                segment.get("pathTerminator") == "RF" and bool(segment.get("arcCenterFix"))
                for segment in all_segments
            ),
            "connectionRule": "Somente FIX terminal STAR identico ao FIX inicial IAC, no mesmo aerodromo e com pista compativel; nunca por proximidade.",
        },
        "notConfirmed": [
            "Cartas OMNI sem tabela de codificacao permanecem textuais; nenhuma geometria foi inferida.",
            "Pernas vetoriais ou condicionadas sem ponto terminal publicado permanecem sem geometria.",
        ],
    }
    return audit, terminal_points


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the modular TMA Sao Paulo IFR procedure database.")
    parser.add_argument("--manifest", type=Path, default=Path("tmp/pdfs/aisweb-current/manifest.json"))
    parser.add_argument("--tables", type=Path, default=Path("tmp/pdfs/aisweb-current/tables"))
    parser.add_argument("--chart-catalog", type=Path, default=Path("tmp/pdfs/aisweb-current/catalog.json"))
    parser.add_argument("--provided-catalog", type=Path, default=Path("tmp/pdfs/sp-chart-catalog.json"))
    parser.add_argument("--waypoints", type=Path, default=Path("data/waypoints.json"))
    parser.add_argument("--boundaries", type=Path, default=Path("all_tmas_boundaries.json"))
    parser.add_argument("--output", type=Path, default=Path("data/tmas/tma-sp.json"))
    parser.add_argument("--audit-output", type=Path, default=Path("data/tmas/tma-sp-audit.json"))
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    chart_catalog = json.loads(args.chart_catalog.read_text(encoding="utf-8"))
    waypoints = waypoint_index(args.waypoints)
    procedures = [build_procedure(item, args.tables, chart_catalog) for item in manifest["procedures"]]
    procedures.sort(key=lambda item: (item["airport"], item["type"], item["name"]))
    connections = build_connections(procedures)
    audit, terminal_points = build_audit(procedures, connections, waypoints)
    audit["sourceDivergences"] = build_source_divergences(procedures, args.provided_catalog)
    boundary_data = json.loads(args.boundaries.read_text(encoding="utf-8"))
    local_sp_boundaries = [
        feature.get("properties", {}).get("name")
        for feature in boundary_data.get("features", [])
        if "sao paulo" in unicodedata.normalize(
            "NFKD", feature.get("properties", {}).get("name", "")
        ).encode("ascii", "ignore").decode("ascii").lower()
    ]
    audit["tmaBoundaryAudit"] = {
        "status": "local-layer-incomplete",
        "localRecords": local_sp_boundaries,
        "finding": "A camada local possui somente um setor da TMA Sao Paulo; o ENR 2.1 vigente publica multiplos setores.",
        "impact": "A divergencia foi registrada e a camada de limites nao foi inferida nem alterada nesta entrega de procedimentos IFR.",
    }
    audit["authoritativeReferences"] = [
        {
            "name": "AISWEB Cartas Aerodromos/TMA",
            "url": "https://aisweb.decea.mil.br/?i=cartas",
            "cycle": "AMDT 34/26",
            "effectiveDate": "2026-08-06",
        },
        {
            "name": "AIP Brasil ENR 2.1 - TMA Sao Paulo",
            "url": "https://aisweb.decea.mil.br/eaip/A%2014-2026_2026_08_06/eAIP/ENR%202.1-pt-BR.html",
            "cycle": "A 14/2026",
            "effectiveDate": "2026-08-06",
        },
        {
            "name": "AIXM Brasil completo",
            "cycle": "2608A1",
            "effectiveDate": "2026-08-06",
            "role": "cross-check; coverage is partial for legacy procedure features",
        },
    ]

    airport_records = []
    for icao in AIRPORTS:
        airport_procedures = [procedure for procedure in procedures if procedure["airport"] == icao]
        airport_records.append(
            {
                "icao": icao,
                "name": AIRPORTS[icao],
                "procedureCounts": dict(Counter(procedure["type"] for procedure in airport_procedures)),
                "status": "current-procedures-published" if airport_procedures else "no-current-procedure-found",
            }
        )

    module = {
        "schemaVersion": 2,
        "id": "tma-sp",
        "name": "TMA Sao Paulo",
        "authority": "DECEA/AISWEB",
        "effectiveDate": "2026-08-06",
        "amendment": "AMDT 34/26",
        "coordinateSources": ["data/waypoints.json", "published coding-table terminal points"],
        "airports": airport_records,
        "terminalPoints": terminal_points,
        "procedures": procedures,
        "connections": connections,
        "auditFile": "data/tmas/tma-sp-audit.json",
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(module, ensure_ascii=False, indent=2), encoding="utf-8")
    args.audit_output.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"module": str(args.output), "audit": str(args.audit_output), "totals": audit["totals"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
