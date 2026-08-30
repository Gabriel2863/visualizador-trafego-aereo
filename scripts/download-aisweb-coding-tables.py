"""Baixa, com retomada, somente as tabelas de codificação listadas pela AISWEB.

Os PDFs são escritos em tmp/ (ou diretório indicado) e nunca devem entrar no
repositório. A saída desta etapa alimenta o importador de JSONs sem publicar
as cartas brutas.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import urllib.request
from pathlib import Path
from typing import Any


USER_AGENT = "Visualizador-Trafego-Aereo/1.0 (estudo; tabelas AISWEB)"


def safe(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value or "unknown").strip("-")


def destination(root: Path, item: dict[str, Any]) -> Path:
    return root / f"{item['airport']}_{item['type']}_{safe(item.get('chartCode') or item['title'])}_coding-table.pdf"


def fetch(item: dict[str, Any], root: Path) -> tuple[str, str]:
    target = destination(root, item)
    if target.exists() and target.stat().st_size > 64 and target.read_bytes()[:4] == b"%PDF":
        return "skipped", str(target)
    url = item.get("codingTableUrl")
    if not url:
        return "unavailable", item.get("chartCode") or item["title"]
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        content = response.read()
    if not content.startswith(b"%PDF"):
        raise RuntimeError(f"Resposta sem PDF para {item['airport']} {item['type']} {item['title']}")
    temporary = target.with_suffix(".part")
    temporary.write_bytes(content)
    temporary.replace(target)
    return "downloaded", str(target)


def main() -> None:
    parser = argparse.ArgumentParser(description="Baixa tabelas de codificação oficiais listadas em um catálogo AISWEB.")
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0, help="Limite para teste; 0 baixa todas as tabelas disponíveis.")
    args = parser.parse_args()

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    procedures = [item for item in catalog.get("procedures", []) if item.get("codingTableUrl")]
    if args.limit:
        procedures = procedures[:args.limit]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    result = {"downloaded": [], "skipped": [], "unavailable": [], "failures": []}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        submitted = {executor.submit(fetch, item, args.output_dir): item for item in procedures}
        for future in concurrent.futures.as_completed(submitted):
            item = submitted[future]
            try:
                status, detail = future.result()
                result[status].append(detail)
            except Exception as error:
                result["failures"].append({"airport": item["airport"], "type": item["type"], "title": item["title"], "error": str(error)})
    for value in result.values():
        value.sort(key=lambda item: str(item))
    print(json.dumps({key: len(value) for key, value in result.items()}, ensure_ascii=False))
    if result["failures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
