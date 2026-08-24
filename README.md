# Visualizador de Tráfego Aéreo

Site web interativo para estudo e visualização de dados aeronáuticos.

## Estrutura

- `index.html` — página principal
- `map_interface.js` — lógica do mapa e da interface
- `styles.css` — estilos
- `data/waypoints.json` — base de 7.938 waypoints
- `data/procedures.json` — procedimentos IFR atualmente cadastrados
- `all_tmas_boundaries.json` — geometrias das TMA
- `all_tmas_coordinates.json` — dados tabulares das TMA
- `aeronautical_data.json` — dados aeronáuticos complementares
- `scripts/import-waypoints.py` — conversor do Excel de waypoints para JSON

## Execução local

Como o site carrega arquivos JSON com `fetch()`, não é recomendado abrir `index.html` diretamente com `file://`.

Com Python instalado, na pasta do projeto:

```bash
python -m http.server 8000
```

Depois abra:

`http://localhost:8000`

## GitHub Pages

O projeto é um site estático e pode ser publicado pelo GitHub Pages.

Os documentos brutos utilizados como fonte (AIP, cartas e planilhas) não são necessários para o funcionamento publicado do site e devem permanecer fora do repositório público, salvo se houver autorização para redistribuí-los.

## Atualização dos waypoints

O script `scripts/import-waypoints.py` pode converter uma nova versão do `waypoint.xlsx` para `data/waypoints.json`.

Exemplo:

```bash
python scripts/import-waypoints.py waypoint.xlsx
```

O arquivo Excel deve conter as colunas obrigatórias:

- `ident`
- `latitude`
- `longitude`
- `tipo`
