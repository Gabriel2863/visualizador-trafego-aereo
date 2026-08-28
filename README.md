# Visualizador de Tráfego Aéreo

Site web interativo para estudo e visualização de dados aeronáuticos.

## Estrutura

- `index.html` — página principal
- `map_interface.js` — lógica do mapa e da interface
- `styles.css` — estilos
- `data/waypoints.json` — 7.938 waypoints originais e referências globais de geometria IFR
- `data/tmas/catalog.json` — catálogo leve das 40 TMAs e seus índices sob demanda
- `data/tmas/<tma>/` — aeródromos e procedimentos SID/STAR/IAC em arquivos individuais
- `data/tmas/manifest.json` — fontes nacionais e módulos de contexto operacional
- `data/tmas/tma-sp.json` — fonte monolítica preservada para reconstruir os procedimentos de São Paulo
- `data/tmas/tma-sp-airports.json` — aeroportos da TMA São Paulo com coordenadas, elevação e fonte AISWEB
- `data/tmas/tma-sp-sectors.json` — 15 setores oficiais da TMA São Paulo, com limites, classes e frequências
- `data/tmas/tma-sp-audit.json` — auditoria de cobertura, fontes e divergências da TMA São Paulo
- `data/procedures.json` — base legada, preservada, mas não carregada pela interface atual
- `all_tmas_boundaries.json` — geometrias das TMA
- `all_tmas_coordinates.json` — dados tabulares das TMA
- `aeronautical_data.json` — dados aeronáuticos complementares
- `data/areas-ensaio.json` — limites laterais e verticais das áreas de ensaio em voo
- `data/studies/manifest.json` — categorias carregadas pelo painel flutuante de estudos
- `data/studies/*.json` — resumos organizados por assunto, sem incluir os documentos brutos
- `scripts/import-waypoints.py` — conversor do Excel de waypoints para JSON
- `scripts/migrate-data-architecture.mjs` — gera a hierarquia modular a partir das fontes existentes
- `scripts/validate-data-architecture.mjs` — valida catálogos, referências e schemas
- `scripts/build-secure.mjs` — gera o artefato protegido publicado no GitHub Pages
- `.github/workflows/deploy-pages.yml` — build e deploy automatizados do conteúdo de `dist/`

## Execução local

Como o site carrega arquivos JSON com `fetch()`, não é recomendado abrir `index.html` diretamente com `file://`.

Com Python instalado, na pasta do projeto:

```bash
python -m http.server 8000
```

Depois abra:

`http://localhost:8000`

## Uso em dispositivos móveis

Em telas de até 900 px, a interface reorganiza automaticamente o mapa e o painel
de controles. No modo retrato, o mapa fica acima do painel rolável; no modo
paisagem, mapa e controles permanecem lado a lado. A aba da TMA e o controle de
camadas iniciam recolhidos para preservar a área útil do mapa, e os principais
campos e botões usam áreas de toque ampliadas.

## GitHub Pages

O projeto é um site estático publicado pelo GitHub Pages por meio do workflow
`Deploy protected build to GitHub Pages`. O Pages recebe somente o conteúdo de
`dist/`: JavaScript minificado/ofuscado, CSS minificado e os dados estritamente
necessários ao funcionamento. Os arquivos-fonte originais e source maps não fazem
parte do artefato publicado.

Para gerar e conferir o mesmo artefato localmente, use Node.js 20 ou superior:

```bash
npm ci
npm run build
```

Na configuração do repositório, a fonte do Pages deve ser **GitHub Actions**. Veja
as verificações completas em `DEPLOY_SECURITY.md` e a política em `SECURITY.md`.

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

## Arquitetura de procedimentos IFR

O site usa `data/tmas/catalog.json` para descobrir TMAs e carrega, em sequência,
somente o índice da TMA, o aeródromo escolhido, o tipo SID/STAR/IAC e a carta
solicitada. Cada procedimento ocupa um JSON independente. O mapa operacional
também baixa apenas as cartas compatíveis com as pistas e filtros ativos.

As cartas não armazenam latitude, longitude ou geometria. FIXES, cabeceiras e
vértices de trajetória apontam por `coordinate_ref` para `data/waypoints.json`,
que é a fonte única de coordenadas do interpretador. Ramificações são descritas
como um grafo de pernas e a aproximação perdida permanece separada.

As bases monolíticas `tma-sp.json`, `brazil-procedures-aixm.json` e
`data/procedures.json` não são mais carregadas pelo navegador, mas foram
preservadas como fontes de reconstrução e auditoria.

A especificação completa, os schemas e as instruções para adicionar TMA,
aeródromo, SID, STAR ou IAC estão em [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

Para reconstruir e validar a hierarquia:

```bash
npm run migrate:data
npm test
```

O arquivo `tma-sp-sectors.json` substitui, somente para São Paulo, o contorno
nacional incompleto. Ele contém os setores 01, 02, 02F, 03, 03F, 04 a 13 da
publicação ENR 2.1 vigente em 06/08/2026. Na interface, o setor com maior área
visível é identificado automaticamente na aba esquerda; 02F e 03F são desenhados
com contorno tracejado.

Para reconstruir a fonte de São Paulo a partir das tabelas de codificação oficiais previamente
baixadas:

```bash
python scripts/build-tma-sp.py
```

O gerador não inventa ligações por proximidade. Pernas sem ponto terminal publicado
e cartas textuais sem tabela de codificação permanecem identificadas na auditoria.

> Este projeto é destinado a estudo e visualização. Não deve ser usado para
> navegação operacional; sempre consulte a publicação aeronáutica oficial vigente.

## Vetores e camadas nacionais

O controle de camadas do mapa permite exibir todos os fixos disponíveis na base,
todos os aeródromos e as áreas de ensaio em voo. Essas opções funcionam em toda a
extensão do mapa do Brasil e são independentes do módulo de procedimentos da TMA SP.

Os vetores de medição não possuem limite de quantidade e podem ser apresentados em
milhas náuticas ou quilômetros:

- `O` — inicia um vetor na posição atual do mouse;
- `F` — fixa o final do vetor;
- `X` — apaga o vetor selecionado (clique na linha para selecionar);
- `Z` — apaga todos os vetores da tela.

Os atalhos ficam suspensos enquanto o cursor está em um campo de texto ou seleção,
evitando interferência na pesquisa e nos filtros de procedimentos.

## Layout operacional da TMA São Paulo

Ao aproximar o mapa de São Paulo, a aba esquerda identifica automaticamente o
setor com maior presença na tela e permite selecionar as pistas de SBSP, SBGR e
SBKP nas oito combinações usadas como referência nas imagens SAG.

A malha pode ser filtrada separadamente por SID, STAR, ILS/LOC e RNP. Os FIX com
restrição publicada recebem destaque e mostram altitude/nível e velocidade na
etiqueta e no painel de detalhes. Restrições são sempre associadas às cartas e
pistas ativas; valores ausentes não são inferidos.

## Área de estudos

O botão flutuante `Estudos` abre um painel lateral com pesquisa, categorias e
tópicos expansíveis. O conteúdo atual foi resumido a partir dos materiais da
pasta de estágio e está dividido em:

- visão geral do APP-SP;
- setores e regiões de coordenação;
- chegadas de SBGR, SBSP e SBKP;
- resumos e índice temático de CAOPs.

Os arquivos originais não são publicados. O painel apresenta conteúdo de revisão
e mantém um aviso para que toda informação seja confirmada na documentação
aeronáutica vigente.

### Como adicionar novos estudos

1. Crie um novo arquivo JSON em `data/studies/`, seguindo a estrutura dos arquivos
   existentes: identificação, descrição, tópicos, itens e referências.
2. Adicione a categoria em `data/studies/manifest.json`, indicando o caminho do
   novo arquivo.
3. Recarregue o site. As abas, a pesquisa e os cartões são montados
   automaticamente, sem alteração em `map_interface.js`.

Para acrescentar conteúdo a uma categoria existente, basta incluir outro objeto
no array `topics` do respectivo arquivo. Use `tags` para melhorar a pesquisa e
`sourceRefs` para registrar a origem do resumo.
