# Arquitetura de dados aeronáuticos

## Objetivo

Esta arquitetura separa TMAs, aeródromos e procedimentos IFR em arquivos pequenos e carregados sob demanda. O mapa continua sendo uma aplicação estática, mas deixa de depender de listas de cartas codificadas manualmente no JavaScript.

As regras centrais são:

- `data/waypoints.json` é a única fonte de coordenadas usada pelo interpretador IFR;
- cada procedimento fica em um JSON próprio e não contém latitude, longitude ou geometria embutida;
- TMAs e aeródromos possuem arquivos e índices independentes;
- SID, STAR e IAC são interpretados pelo mesmo código genérico;
- pernas principais e aproximação perdida permanecem separadas;
- arquivos antigos são preservados como fontes de migração e compatibilidade.

## Estrutura

```text
data/
├── waypoints.json
└── tmas/
    ├── catalog.json
    ├── curitiba/
    │   ├── tma.json
    │   └── airports/
    │       ├── index.json
    │       ├── SBCT/
    │       │   ├── airport.json
    │       │   └── procedures/
    │       │       ├── index.json
    │       │       ├── SID/*.json
    │       │       ├── STAR/*.json
    │       │       └── IAC/*.json
    │       └── SBBI/...
    ├── sao-paulo/...
    └── sem-tma-associada/...
```

`sem-tma-associada` é um agrupamento técnico para aeródromos com procedimentos existentes que não estão contidos em nenhuma geometria TMA da base local. Ele não representa espaço aéreo publicado e evita associações inventadas.

## Catálogo nacional

`data/tmas/catalog.json` é o ponto de entrada do carregamento dinâmico. Cada item informa:

- `id`: identificador estável da TMA;
- `slug`: nome de diretório;
- `name`: nome publicado ou nome do agrupamento técnico;
- `file`: caminho do `tma.json`;
- `airportCount`: quantidade de aeródromos hierárquicos;
- `procedureCount`: quantidade de cartas disponíveis;
- `selectable`: disponibilidade no seletor IFR;
- `technicalGroup`: indica que o item não é uma TMA publicada.

O catálogo possui as 40 famílias TMA da base AIXM e um agrupamento técnico.

## TMA

Cada `tma.json` contém somente metadados e referências:

```json
{
  "schemaVersion": 1,
  "id": "CURITIBA",
  "name": "TMA Curitiba",
  "airports": ["SBBI", "SBCT", "SBJV"],
  "airportsIndex": "data/tmas/curitiba/airports/index.json",
  "boundarySource": "data/tmas/brazil-tmas-aixm.json",
  "sectorIds": ["CURITIBA SECT 01"]
}
```

Os dados completos dos aeródromos não são duplicados nesse arquivo. As geometrias permanecem em `data/tmas/brazil-tmas-aixm.json`.

## Aeródromos

`airports/index.json` fornece somente os dados necessários para montar o seletor: ICAO, nome, caminhos e contagem por tipo de procedimento.

Cada `airport.json` preserva os dados existentes da base AISWEB/AIXM:

```json
{
  "schemaVersion": 1,
  "icao": "SBCT",
  "name": "Aeroporto Internacional de Curitiba / Afonso Pena",
  "city": "CURITIBA",
  "tma": "CURITIBA",
  "latitude": -25.531666667,
  "longitude": -49.176111111,
  "elevation_ft": 2989,
  "runways": ["11/29", "15/33"],
  "proceduresIndex": "data/tmas/curitiba/airports/SBCT/procedures/index.json"
}
```

As coordenadas do aeródromo descrevem o próprio aeródromo. Coordenadas de FIXES e trajetórias IFR continuam exclusivas de `data/waypoints.json`.

## Índice de procedimentos

Cada aeródromo possui `procedures/index.json` com três listas:

```json
{
  "schemaVersion": 1,
  "airport": "SBCT",
  "coordinateSource": "data/waypoints.json",
  "types": {
    "SID": [],
    "STAR": [],
    "IAC": []
  }
}
```

As entradas informam nome, arquivo, pistas, modalidades, quantidade de transições, aproximações perdidas e avisos. O navegador só baixa o procedimento escolhido. O mapa operacional baixa apenas as cartas compatíveis com a TMA, pistas e filtros ativos.

## Schema de procedimento

Cada carta possui esta estrutura:

```json
{
  "schemaVersion": 1,
  "procedure": {
    "id": "SBCT-IAC-VOR-Z-RWY15",
    "airport": "SBCT",
    "name": "IAC VOR Z RWY 15",
    "type": "IAC",
    "runway": "15",
    "runways": ["15"],
    "modes": ["VOR/DME"],
    "source": {},
    "source_history": []
  },
  "points": {
    "SIBUM": {
      "ident": "SIBUM",
      "coordinate_ref": "waypoint:1234.0",
      "role": "IAF",
      "altitude": { "at": null, "min": 7500, "max": null }
    }
  },
  "legs": [
    {
      "id": "leg-1",
      "from": "SIBUM",
      "to": "TEDUG",
      "via": [],
      "path_terminator": "TF",
      "course": 245,
      "course_reference": "MAG",
      "distance_nm": null
    }
  ],
  "transitions": [
    {
      "id": "entrada-sibum",
      "name": "Entrada SIBUM",
      "sequence": ["SIBUM", "TEDUG"],
      "leg_ids": ["leg-1"]
    }
  ],
  "missed_approach": [],
  "warnings": []
}
```

O schema é extensível. Além dos campos do exemplo, as pernas podem guardar limites inferior/superior, velocidade, ângulo vertical, fly-over, sentido de curva, especificação de navegação, centro e raio RF e página da fonte.

## Resolução de FIXES e coordenadas

O procedimento nunca contém coordenadas. Cada item de `points` possui `coordinate_ref`, que aponta para o `feature.id` de uma feição em `data/waypoints.json`.

O processo de desenho é:

1. carregar o JSON do procedimento;
2. localizar a transição escolhida;
3. obter as pernas por `leg_ids`;
4. procurar cada `coordinate_ref` no índice global de waypoints;
5. desenhar `from`, pontos `via` e `to` na ordem publicada;
6. aplicar curso, distância e restrições quando disponíveis;
7. desenhar `missed_approach` em camada visual separada.

Os 7.938 registros originais continuam intactos. Pontos de cabeceira, navaids ausentes e vértices de curvas que já existiam nas bases estruturadas foram acrescentados ao mesmo arquivo com:

- `generated_by: "data-architecture-v1"`;
- fonte e referência de origem;
- `hidden_on_map: true` para vértices puramente geométricos.

Esses pontos não aparecem na pesquisa nem na camada “Todos os fixos”, mas podem ser resolvidos pelo interpretador. Nenhuma coordenada foi inferida por proximidade ou criada sem fonte.

Se uma referência futura não existir, o procedimento continua carregando, a perna não resolvida é ignorada, o erro é registrado no console e o painel informa exatamente qual FIX não foi encontrado.

## Grafo, ramificações e curvas

`legs` é o conjunto de arestas do procedimento. `transitions` seleciona subconjuntos ordenados por `leg_ids`, permitindo várias entradas convergirem para o mesmo FIX sem assumir uma única sequência linear.

O campo `via` referencia pontos globais usados para preservar trajetórias curvas já presentes no AIXM. Pernas RF também podem usar `arc_center`, `arc_radius_nm` e `turn`. Assim, a geometria não fica embutida na carta e continua reproduzível.

## Aproximação perdida

`missed_approach` é uma lista independente. Cada item possui sua própria sequência e suas próprias pernas. O renderizador usa linha vermelha tracejada e não concatena automaticamente a aproximação perdida aos `legs` principais.

O modelo aceita direct, hold, curva, curso, distância, velocidade e altitude quando esses dados estiverem publicados.

## Como adicionar uma nova TMA

1. Crie `data/tmas/<slug>/tma.json`.
2. Crie `data/tmas/<slug>/airports/index.json`.
3. Adicione a entrada em `data/tmas/catalog.json`.
4. Se houver geometria, adicione-a à fonte nacional de limites e informe `boundarySource`.
5. Execute `npm test` e `npm run build`.

Se a TMA vier das bases atuais, prefira atualizar os arquivos de origem e executar `npm run migrate:data`.

## Como adicionar um aeródromo

1. Crie `airports/<ICAO>/airport.json` dentro da TMA.
2. Crie `airports/<ICAO>/procedures/index.json` com SID, STAR e IAC vazios.
3. Inclua o ICAO em `tma.json`.
4. Inclua a entrada leve em `airports/index.json`.
5. Use somente dados já publicados; não invente nome, posição, pista ou elevação.

## Como adicionar SID, STAR ou IAC

1. Confirme que todos os FIXES existem em `data/waypoints.json`.
2. Crie um JSON em `procedures/SID`, `procedures/STAR` ou `procedures/IAC`.
3. Preencha `procedure`, `points`, `legs`, `transitions`, `missed_approach` e `warnings`.
4. Em `points`, use `coordinate_ref`; não copie latitude/longitude.
5. Adicione o arquivo ao tipo correto em `procedures/index.json`.
6. Execute `npm test`.

Não é necessário alterar `map_interface.js` para adicionar uma carta compatível com o schema.

## Migração e geração

`scripts/migrate-data-architecture.mjs` reconstrói a hierarquia a partir das fontes existentes:

- `data/tmas/brazil-procedures-aixm.json`;
- `data/tmas/tma-sp.json`;
- `data/procedures.json`;
- `data/tmas/brazil-tmas-aixm.json`;
- `data/tmas/brazil-aerodromes-aixm.json`;
- `data/waypoints.json`.

Execute:

```bash
npm run migrate:data
npm test
```

O gerador consolida registros equivalentes, preserva o histórico das fontes e separa as STAR legadas DALIG 1A, RAXIT 1A e UMGUL 1A de SBCT sem perder as transições GEGOB e PAPIP.

## Compatibilidade e arquivos antigos

Continuam usados no runtime:

- `data/waypoints.json`;
- `data/tmas/catalog.json` e a hierarquia por TMA;
- `data/tmas/brazil-tmas-aixm.json` para os limites;
- `data/tmas/brazil-aerodromes-aixm.json` para a camada nacional;
- `data/tmas/tma-sp-airports.json` e `data/tmas/tma-sp-sectors.json` para o contexto enriquecido de São Paulo.

Continuam usados como fonte de geração, importação ou auditoria:

- `data/tmas/brazil-procedures-aixm.json`;
- `data/tmas/tma-sp.json`;
- `data/procedures.json`;
- `all_tmas_boundaries.json`;
- `all_tmas_coordinates.json`;
- `curitiba_tma_waypoints.json`.

Ficaram obsoletos somente para carregamento direto pelo navegador:

- o pacote monolítico nacional de procedimentos;
- o pacote monolítico de procedimentos da TMA São Paulo;
- a lista legada de Curitiba.

Eles não foram apagados. Permanecem disponíveis para reconstrução, conferência e compatibilidade durante a migração incremental.

## Validação

```bash
npm test
python scripts/validate-aixm-data.py
npm run build
```

`npm test` verifica catálogos, arquivos, contagens, referências, ausência de coordenadas nos procedimentos, procedimentos obrigatórios de Curitiba e preservação das fontes antigas.

O projeto é destinado a estudo. Para qualquer uso real, confirme carta, AIP e NOTAM vigentes.
