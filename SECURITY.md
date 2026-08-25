# Política de Segurança

## Escopo

Este projeto é um visualizador web destinado a estudo. Ele não deve ser usado para
navegação operacional nem como substituto de publicações aeronáuticas oficiais.

## Proteção do código publicado

O deploy de produção é gerado por `npm run build` e publica somente o conteúdo de
`dist/`. O processo:

- minifica o CSS;
- minifica e ofusca o JavaScript;
- não gera source maps;
- não publica `map_interface.js`, `styles.css`, scripts auxiliares ou documentos;
- copia somente os dados declarados nos manifestos utilizados pela aplicação.

A ofuscação aumenta o esforço de engenharia reversa, mas não torna secreto o
código executado no navegador.

## Dados públicos no navegador

Os JSON necessários para renderizar o mapa e a Área de Estudos continuam
acessíveis ao visitante. Dados ou regras que precisem permanecer confidenciais
devem ser processados em um backend e não enviados ao frontend.

## Segredos

Nunca armazene tokens, chaves de API, senhas ou credenciais no HTML, JavaScript,
JSON público ou histórico Git. Use GitHub Actions Secrets ou um backend.

## Relato de vulnerabilidades

Ao identificar uma vulnerabilidade, evite publicar detalhes sensíveis em uma
issue pública antes que os mantenedores tenham oportunidade de corrigi-la.
