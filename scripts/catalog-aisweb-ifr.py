"""Cria um catálogo reproduzível das cartas IFR publicadas pela AISWEB.

Os PDFs das cartas e das tabelas de codificação são fontes brutas temporárias:
este script só grava metadados públicos (título, código, emenda e URL) no
arquivo de saída. A lista de aeródromos/tipos vem do pacote ostensivo vigente,
evitando uma lista manual no código.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import re
import time
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


CATALOG_URL = "https://aisweb.decea.mil.br/?i=cartas"
IFR_TYPES = ("SID", "STAR", "IAC")
USER_AGENT = "Visualizador-Trafego-Aereo/1.0 (estudo; catalogo AISWEB)"


def plain(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


class ChartRows(HTMLParser):
    """Extrai as linhas da tabela HTML sem depender de bibliotecas externas."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, Any]] = []
        self._row: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if tag == "tr":
            self._row = []
        elif tag == "td" and self._row is not None:
            self._cell = {"text": [], "hrefs": []}
        elif tag == "a" and self._cell is not None and attrs_map.get("href"):
            self._cell["hrefs"].append(attrs_map["href"])

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self._cell is not None and self._row is not None:
            self._cell["text"] = plain("".join(self._cell["text"]))
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            # Colunas: seleção, ICAO, tipo, título, emenda, data, uso, download.
            if len(self._row) >= 7 and self._row[1]["text"].upper().startswith("SB"):
                chart_link = next((url for url in self._row[3]["hrefs"] if "tabela=" in url), None)
                download_link = next((url for cell in self._row for url in cell["hrefs"] if "arquivo=" in url), None)
                title = self._row[3]["text"]
                chart_code = None
                if chart_link:
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(chart_link).query)
                    chart_code = query.get("t", [None])[0]
                    if chart_code and title.endswith(chart_code):
                        title = title[: -len(chart_code)].strip()
                self.rows.append({
                    "airport": self._row[1]["text"].upper(),
                    "type": self._row[2]["text"].upper(),
                    "title": title,
                    "amendment": self._row[4]["text"],
                    "effectiveDate": self._row[5]["text"],
                    "use": self._row[6]["text"],
                    "chartCode": chart_code,
                    "codingTableUrl": chart_link,
                    "chartDownloadUrl": download_link,
                })
            self._row = None


def request_bytes(url: str, data: bytes | None = None) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def current_search_token() -> str:
    page = request_bytes(CATALOG_URL).decode("utf-8", errors="replace")
    match = re.search(r'name="busca"\s+value="([^"]+)"', page, re.I)
    if not match:
        raise RuntimeError("Token de pesquisa AISWEB não encontrado na página de cartas.")
    return match.group(1)


def pair_rows(airport: str, procedure_type: str, token: str) -> list[dict[str, Any]]:
    payload = urllib.parse.urlencode({
        "icaocode": airport,
        "tipo": procedure_type,
        "carta": "",
        "pe": "0",
        "amdt": "0",
        "uso": "all",
        "busca": token,
    }).encode("utf-8")
    parser = ChartRows()
    parser.feed(request_bytes(CATALOG_URL, payload).decode("utf-8", errors="replace"))
    return [row for row in parser.rows if row["airport"] == airport and row["type"] == procedure_type]


def source_pairs(package: Path, only_airports: set[str]) -> list[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    with zipfile.ZipFile(package) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.lower().endswith(".pdf"):
                continue
            parts = Path(entry.filename).parts
            if len(parts) < 3:
                continue
            airport, procedure_type = parts[-3].upper(), parts[-2].upper()
            if procedure_type in IFR_TYPES and re.fullmatch(r"SB[A-Z0-9]{2}", airport):
                if not only_airports or airport in only_airports:
                    pairs.add((airport, procedure_type))
    return sorted(pairs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Consulta o catálogo público AISWEB para SID, STAR e IAC.")
    parser.add_argument("--package", type=Path, required=True, help="ZIP ostensivo da AISWEB, mantido fora do repositório.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--only-airport", action="append", default=[], help="Restringe a consulta; útil para validação.")
    parser.add_argument("--offset", type=int, default=0, help="Primeiro par aeródromo/tipo a consultar; permite retomada em lotes.")
    parser.add_argument("--max-pairs", type=int, default=0, help="Quantidade máxima de pares a consultar neste lote; 0 consulta todos.")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.15, help="Pausa respeitosa após cada consulta.")
    args = parser.parse_args()

    airports = {value.strip().upper() for value in args.only_airport if value.strip()}
    all_pairs = source_pairs(args.package, airports)
    pairs = all_pairs[max(0, args.offset):]
    if args.max_pairs:
        pairs = pairs[:args.max_pairs]
    if not pairs:
        raise SystemExit("Nenhum par aeródromo/tipo IFR foi encontrado no pacote informado.")
    token = current_search_token()
    failures: list[dict[str, str]] = []
    rows: list[dict[str, Any]] = []

    def fetch(pair: tuple[str, str]) -> list[dict[str, Any]]:
        airport, procedure_type = pair
        try:
            values = pair_rows(airport, procedure_type, token)
            if args.delay:
                time.sleep(args.delay)
            return values
        except Exception as error:  # A auditoria preserva a falha e evita catálogo silenciosamente parcial.
            failures.append({"airport": airport, "type": procedure_type, "error": str(error)})
            return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        for result in executor.map(fetch, pairs):
            rows.extend(result)

    unique: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["airport"], row["type"], row["title"], row.get("chartCode") or "")
        unique[key] = row
    procedures = sorted(unique.values(), key=lambda item: (item["airport"], item["type"], item["title"], item.get("chartCode") or ""))
    output = {
        "schemaVersion": 1,
        "authority": "AISWEB/DECEA",
        "catalogUrl": CATALOG_URL,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "sourcePackage": args.package.name,
        "procedureCount": len(procedures),
        "countsByType": dict(sorted(Counter(item["type"] for item in procedures).items())),
        "pairsRequested": len(pairs),
        "pairOffset": max(0, args.offset),
        "pairsAvailable": len(all_pairs),
        "failures": sorted(failures, key=lambda item: (item["airport"], item["type"])),
        "procedures": procedures,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"procedures": len(procedures), "counts": output["countsByType"], "failures": len(failures), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
