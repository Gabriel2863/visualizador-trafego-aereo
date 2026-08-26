"""Extrai SID, STAR e IAC com trajetória codificada do AIXM oficial do AISWEB."""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
GML_ID = "{http://www.opengis.net/gml/3.2}id"
LEG_TYPES = {"ArrivalLeg", "ArrivalFeederLeg", "DepartureLeg", "InitialLeg", "IntermediateLeg", "FinalLeg", "MissedApproachLeg"}
PROCEDURE_TYPES = {"StandardInstrumentArrival": "STAR", "StandardInstrumentDeparture": "SID", "InstrumentApproachProcedure": "IAC"}
POINT_TYPES = {"DesignatedPoint", "Navaid", "RunwayCentrelinePoint"}


def local(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def first(element: ET.Element | None, name: str) -> ET.Element | None:
    if element is None:
        return None
    return next((child for child in element.iter() if local(child) == name), None)


def direct(element: ET.Element | None, name: str) -> ET.Element | None:
    if element is None:
        return None
    return next((child for child in element if local(child) == name), None)


def text(element: ET.Element | None, name: str, default: str = "") -> str:
    found = first(element, name)
    return (found.text or "").strip() if found is not None else default


def direct_text(element: ET.Element | None, name: str, default: str = "") -> str:
    found = direct(element, name)
    return (found.text or "").strip() if found is not None else default


def uuid(element: ET.Element) -> str:
    return element.attrib.get(GML_ID, "").removeprefix("uuid.") or text(element, "identifier")


def href(element: ET.Element | None) -> str:
    return element.attrib.get(XLINK_HREF, "").rsplit(":", 1)[-1] if element is not None else ""


def baseline(element: ET.Element, time_slice_name: str) -> ET.Element | None:
    slices = [item for item in element.iter() if local(item) == time_slice_name]
    return next((item for item in slices if text(item, "interpretation") == "BASELINE"), slices[-1] if slices else None)


def numeric(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def trajectory(element: ET.Element) -> list[list[float]]:
    trajectory_element = direct(element, "trajectory")
    if trajectory_element is None:
        return []
    coordinates: list[list[float]] = []
    for position in trajectory_element.iter():
        if local(position) not in {"pos", "posList"} or not position.text:
            continue
        values = [float(value) for value in position.text.split()]
        for index in range(0, len(values) - 1, 2):
            point = [values[index], values[index + 1]]
            if not coordinates or coordinates[-1] != point:
                coordinates.append(point)
    return coordinates


def altitude(element: ET.Element, field: str, interpretation: str) -> dict | None:
    limit = direct(element, field)
    value = numeric(limit.text if limit is not None else None)
    if value is None:
        return None
    unit = limit.attrib.get("uom", "FT").upper()
    value_ft = value * 100 if unit == "FL" else value * 3.28084 if unit == "M" else value
    meanings = {
        "ABOVE_LOWER": "at-or-above", "BELOW_UPPER": "at-or-below", "AT": "at", "AT_LOWER": "at",
        "BETWEEN": "between-bound", "RECOMMENDED": "recommended", "EXPECT_LOWER": "expected",
        "AS_ASSIGNED": "as-assigned",
    }
    return {"raw": f"{value:g} {unit}", "valueFt": round(value_ft), "meaning": meanings.get(interpretation, "published")}


def parse_point(element: ET.Element, kind: str) -> dict | None:
    slice_element = baseline(element, f"{kind}TimeSlice")
    position = first(direct(slice_element, "location"), "pos")
    values = [float(value) for value in (position.text or "").split()] if position is not None else []
    if len(values) < 2:
        return None
    designator = direct_text(slice_element, "designator") or direct_text(slice_element, "name") or uuid(element)[:8]
    if kind == "RunwayCentrelinePoint":
        designator = f"RW{designator}"
    return {"ident": designator, "latitude": values[0], "longitude": values[1], "pointRef": uuid(element), "pointType": kind}


def parse_leg(element: ET.Element, kind: str) -> dict | None:
    slice_element = baseline(element, f"{kind}TimeSlice")
    if slice_element is None:
        return None
    start_point = direct(slice_element, "startPoint")
    point_link = next((item for item in start_point.iter() if item.attrib.get(XLINK_HREF)) , None) if start_point is not None else None
    interpretation = direct_text(slice_element, "altitudeInterpretation")
    course_value = numeric(direct_text(slice_element, "course"))
    course_type = direct_text(slice_element, "courseType")
    speed_element = direct(slice_element, "speedLimit")
    speed_value = numeric(speed_element.text if speed_element is not None else None)
    return {
        "id": uuid(element),
        "pointRef": href(point_link),
        "pathTerminator": direct_text(slice_element, "legTypeARINC", direct_text(slice_element, "pathTerminator", "LEG")),
        "geometry": trajectory(slice_element),
        "course": {"true": course_value} if course_value is not None and "TRUE" in course_type else {"magnetic": course_value} if course_value is not None else None,
        "distanceNm": numeric(direct_text(slice_element, "length")),
        "lowerLimitAltitude": altitude(slice_element, "lowerLimitAltitude", interpretation),
        "upperLimitAltitude": altitude(slice_element, "upperLimitAltitude", interpretation),
        "speedLimitKt": speed_value,
        "speedLimitDescription": direct_text(slice_element, "speedInterpretation", "BELOW_UPPER") if speed_value is not None else None,
        "verticalAngle": numeric(direct_text(slice_element, "verticalAngle")),
        "fixRole": text(start_point, "role") if start_point is not None else None,
        "navigationSpecification": text(slice_element, "performance") or None,
        "sourcePage": "AIXM",
    }


def parse_procedure(element: ET.Element, kind: str) -> dict | None:
    slice_element = baseline(element, f"{kind}TimeSlice")
    if slice_element is None:
        return None
    transitions = []
    for flight_transition in (child for child in slice_element if local(child) == "flightTransition"):
        transition = first(flight_transition, "ProcedureTransition")
        if transition is None:
            continue
        leg_refs = []
        for transition_leg in (child for child in transition if local(child) == "transitionLeg"):
            sequence = numeric(text(transition_leg, "seqNumberARINC")) or 0
            leg_refs.append((sequence, href(first(transition_leg, "theSegmentLeg"))))
        runway_refs = [href(item) for item in transition.iter() if local(item) == "runway" and href(item)]
        transitions.append({
            "id": direct_text(transition, "transitionId", direct_text(transition, "type", f"trans-{len(transitions) + 1}")),
            "name": direct_text(transition, "transitionId", direct_text(transition, "type", "Transição")),
            "kind": direct_text(transition, "type"),
            "legRefs": [reference for _, reference in sorted(leg_refs)],
            "runwayRefs": runway_refs,
        })
    name = direct_text(slice_element, "name")
    procedure_type = PROCEDURE_TYPES[kind]
    modes = ["RNP"] if re.search(r"\bRNP\b", name, re.I) else ["ILS"] if re.search(r"\bILS\b|\bLOC\b", name, re.I) else ["RNAV"] if direct_text(slice_element, "RNAV") == "YES" else []
    return {
        "id": f"AIXM-{uuid(element)}",
        "name": name or f"{procedure_type} AIXM",
        "type": procedure_type,
        "airportRef": href(direct(slice_element, "airportHeliport")),
        "modes": modes,
        "effectiveDate": text(slice_element, "beginPosition"),
        "transitions": transitions,
    }


def parse(source: Path) -> tuple[list[dict], dict[str, dict], dict[str, str], dict[str, str], dict[str, dict]]:
    procedures: list[dict] = []
    legs: dict[str, dict] = {}
    runway_directions: dict[str, str] = {}
    airports: dict[str, str] = {}
    points: dict[str, dict] = {}
    for _, element in ET.iterparse(source, events=("end",)):
        kind = local(element)
        if kind in LEG_TYPES:
            record = parse_leg(element, kind)
            if record:
                legs[record["id"]] = record
            element.clear()
        elif kind in PROCEDURE_TYPES:
            record = parse_procedure(element, kind)
            if record:
                procedures.append(record)
            element.clear()
        elif kind == "RunwayDirection":
            slice_element = baseline(element, "RunwayDirectionTimeSlice")
            runway_directions[uuid(element)] = direct_text(slice_element, "designator")
            element.clear()
        elif kind == "AirportHeliport":
            slice_element = baseline(element, "AirportHeliportTimeSlice")
            airports[uuid(element)] = direct_text(slice_element, "designator")
            element.clear()
        elif kind in POINT_TYPES:
            record = parse_point(element, kind)
            if record:
                points[uuid(element)] = record
            element.clear()
    return procedures, legs, runway_directions, airports, points


def build(procedures: list[dict], legs: dict[str, dict], runways: dict[str, str], airports: dict[str, str], points: dict[str, dict]) -> dict:
    output_procedures = []
    published_points: dict[str, list[dict]] = defaultdict(list)
    for procedure in procedures:
        airport = airports.get(procedure.pop("airportRef"), "")
        if not airport:
            continue
        runway_values = set()
        output_transitions = []
        for transition in procedure["transitions"]:
            runway_values.update(runways.get(reference, "") for reference in transition.pop("runwayRefs"))
            segment_records = []
            sequence = []
            previous_ident = None
            previous_point = None
            for reference in transition.pop("legRefs"):
                source_leg = legs.get(reference)
                if not source_leg:
                    continue
                leg = {**source_leg}
                point = points.get(leg.pop("pointRef", ""))
                if point:
                    ident = point["ident"]
                    destination_point = {**point, "source": "AIXM 2608A1"}
                elif leg["geometry"]:
                    ident = f"AX{reference[:6].upper()}"
                    latitude, longitude = leg["geometry"][-1]
                    destination_point = {"ident": ident, "latitude": latitude, "longitude": longitude, "pointRef": reference, "pointType": "TrajectoryEndpoint", "source": "AIXM 2608A1 — ponto geométrico"}
                else:
                    continue
                if not any(existing["pointRef"] == destination_point["pointRef"] for existing in published_points[ident]):
                    published_points[ident].append(destination_point)
                if ident not in sequence:
                    sequence.append(ident)
                segment_records.append({**leg, "origin": previous_ident, "destination": ident, "originPoint": previous_point, "destinationPoint": destination_point})
                previous_ident = ident
                previous_point = destination_point
            if segment_records:
                output_transitions.append({**transition, "sequence": sequence, "segments": segment_records})
        if not output_transitions:
            continue
        runway_values.discard("")
        output_procedures.append({
            **procedure,
            "airport": airport,
            "runways": sorted(runway_values) or re.findall(r"RWY\s*(\d{2}[LRC]?)", procedure["name"], re.I),
            "status": "structured-aixm",
            "source": {"authority": "AISWEB/DECEA", "chartCode": "AIXM", "amendment": "2608A1", "effectiveDate": procedure.pop("effectiveDate")},
            "transitions": output_transitions,
        })
    return {
        "schemaVersion": 1,
        "authority": "AISWEB/DECEA",
        "amendment": "2608A1",
        "effectiveDate": "2026-08-06",
        "notice": "Somente pernas com trajetória codificada no AIXM são desenhadas. O conjunto não substitui cartas, AIP ou NOTAM vigentes.",
        "publishedPoints": dict(published_points),
        "procedures": output_procedures,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    result = build(*parse(arguments.source))
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = defaultdict(int)
    for procedure in result["procedures"]:
        counts[procedure["type"]] += 1
    print(f"Procedimentos: {len(result['procedures'])} {dict(counts)} | pontos: {len(result['publishedPoints'])}")


if __name__ == "__main__":
    main()
