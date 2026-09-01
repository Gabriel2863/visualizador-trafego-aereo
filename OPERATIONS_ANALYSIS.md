# Aba de Análise Operacional

Esta área é um módulo independente do mapa. Ela não altera o carregamento de TMAs, aeródromos, procedimentos IFR, waypoints, camadas ou regras de pesquisa já existentes.

## Objetivo

Permitir a comparação didática e explicável de cenários de rota a partir de valores informados pelo usuário. O índice resultante combina tempo estimado, consumo relativo, margem de segurança simulada e fluidez de setor conforme os pesos definidos na interface.

O módulo não é uma ferramenta ATS certificada e não gera instruções operacionais. Ele não substitui AIP, NOTAM, meteorologia oficial, avaliação de risco, coordenação ATS nem decisão humana.

## Dados

O cenário inicial fica em `data/operational-analysis/default-scenario.json`:

- `defaults`: valores carregados ao abrir ou restaurar o painel;
- `alternatives`: opções de comparação com fatores de cenário;
- `dataSources`: inventário de fontes atuais e futuras;
- `notice`: aviso obrigatório exibido na interface.

Os perfis de estudo ficam em `data/operational-analysis/aircraft-profiles.json`. Eles existem para testar a estrutura da análise e são explicitamente identificados como didáticos. Antes de usar qualquer perfil analítico, ele deve ser substituído por dados com origem, versão e aprovação documentadas.

Os valores padrão são deliberadamente identificados como modelo local. Não representam performance publicada, histórico real, rotas liberadas ou capacidade operacional vigente.

## Cálculo atual

Para cada alternativa, a aba estima:

- tempo de bloco a partir de distância, velocidade, vento e atraso em solo;
- índice relativo de consumo a partir de distância, vento contrário e ocupação informada;
- margem simulada a partir de carga de setor, complexidade meteorológica e margem operacional;
- impacto relativo em conexões a partir de tempo, carga de setor e risco de conexão informado;
- índice final ponderado pelos critérios de tempo, consumo, segurança, fluidez e passageiros escolhidos pelo usuário.

Os resultados sempre mostram as premissas usadas e devem ser tratados somente como comparação de cenários.

## Rota publicada e restrições

A aba descobre TMA, aeródromo, tipo, procedimento e transição a partir de `data/tmas/catalog.json` e dos índices já usados pelo mapa. Os arquivos são carregados sob demanda.

Quando uma transição é selecionada, a distância é calculada pela soma dos segmentos publicados com `distance_nm`. A aba também identifica pernas com limite de altitude ou velocidade para informar a revisão. Ela não altera o procedimento, não cria rota nova e não desenha ou libera qualquer trajetória no mapa.

As seguintes condições atuam como bloqueios, e não como perda de pontos:

- condição meteorológica ou restrição operacional declarada pelo usuário;
- publicação/vigência ainda não confirmada para uma rota publicada;
- procedimento sem geometria estruturada suficiente;
- carga de setor igual ou acima do limite definido;
- margem simulada abaixo do mínimo exigido.

Se houver bloqueio, nenhuma alternativa recebe recomendação.

## Histórico local em CSV

O painel aceita um CSV local sem enviar seu conteúdo à aplicação, ao servidor ou a serviços externos. A coluna obrigatória é `block_minutes`. As demais colunas aceitas são:

```text
recorded_at,origin,destination,procedure,aircraft_profile,route_distance_nm,block_minutes,departure_delay_min,sector_load_percent,weather_complexity
```

Com ao menos três registros compatíveis, o laboratório mostra tempo médio, erro absoluto médio e viés da estimativa. O ajuste histórico é limitado, explicável e aplicado somente à sessão atual do navegador. O botão da interface gera um modelo CSV com nomes de coluna compatíveis.

## Cenários e privacidade

Os cenários salvos ficam apenas no `localStorage` do navegador atual. Cada cenário guarda as premissas, a rota selecionada e um resumo do resultado para permitir comparação lado a lado. O histórico CSV importado não é salvo automaticamente e desaparece ao recarregar a página ou ao limpar o histórico.

## Evolução segura

Futuras integrações devem ser adicionadas como adaptadores de dados separados, sem alterar o mapa:

1. histórico de trajetórias e tempos por fase;
2. perfil de performance por tipo de aeronave;
3. meteorologia e limitações publicadas;
4. demanda, capacidade e carga de setores;
5. critérios auditáveis de segurança e revisão humana.

Cada fonte precisa ter origem, data de vigência, qualidade, licença e nível de confiança explícitos. Nenhuma integração deve aplicar automaticamente uma rota ou uma decisão ATS.

## Aprendizados aplicados do projeto HAVEN

O projeto europeu HAVEN (*Highly Automated and Virtualised ATS Platform for En-route and TMA Operations*) é uma iniciativa SESAR 3 coordenada pela Thales LAS France. Segundo a ficha oficial da Comissão Europeia, seu início é previsto para setembro de 2026 e a conclusão para agosto de 2029. O foco inclui plataformas ATS para rota e TMA, IA, arquitetura aberta, implantação flexível, operações baseadas em trajetória, balanceamento demanda-capacidade, segurança, cibersegurança, padronização e certificação.

Referências consultadas:

- [Comissão Europeia — CORDIS, HAVEN](https://cordis.europa.eu/project/id/101286541)
- [SESAR 3 — Inteligência Artificial em ATM](https://sesar.eu/ai)

O módulo incorpora quatro princípios inspirados por essa direção de pesquisa:

1. **Humano no circuito:** a aba compara cenários e expõe suas premissas; ela não libera rotas, não emite instruções e não executa decisões ATS.
2. **Explicabilidade:** cada resultado apresenta tempo, distância, carga de setor e margem simulada, além dos pesos escolhidos pelo usuário.
3. **Arquitetura modular:** o laboratório fica em arquivos próprios e recebe dados por adaptadores futuros, sem acoplar seu cálculo ao carregamento do mapa ou às cartas IFR.
4. **Validação antes de operação:** qualquer dado histórico, de performance, meteorologia ou capacidade deve passar por controle de origem, vigência, qualidade, segurança e revisão humana antes de influenciar análises.

Virtualização em nuvem, automação avançada, certificação e integração operacional em tempo real não fazem parte desta primeira aba. Esses temas devem ser tratados como etapas futuras, com requisitos de segurança e governança definidos antes da implementação.
