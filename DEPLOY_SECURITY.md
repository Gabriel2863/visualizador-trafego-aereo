# Implantação protegida no GitHub Pages

O projeto mantém os arquivos legíveis no repositório para desenvolvimento, mas o
GitHub Pages recebe somente o artefato gerado em `dist/`.

## Build local

Requer Node.js 20 ou superior:

```bash
npm ci
npm run build
```

O build gera:

- `dist/index.html` apontando para os bundles de produção;
- `dist/assets/app.min.js` minificado e ofuscado;
- `dist/assets/app.min.css` minificado;
- somente imagens e dados necessários ao funcionamento;
- nenhum source map ou arquivo-fonte JavaScript/CSS.

## Configuração do GitHub Pages

Em **Settings → Pages → Build and deployment → Source**, selecione
**GitHub Actions**. O workflow `Deploy protected build to GitHub Pages` executa a
cada push no branch `main` e também pode ser iniciado manualmente.

## Verificação

Após o deploy:

1. confirme que o workflow terminou sem erros;
2. abra o site e teste mapa, pesquisa, rotas, IFR, vetores, TMA-SP e Área de Estudos;
3. confirme no navegador que são carregados `assets/app.min.js` e
   `assets/app.min.css`;
4. confirme que `map_interface.js`, `styles.css` e arquivos `.map` não estão no
   artefato publicado.

## Limite técnico

Todo código e dado enviado ao navegador pode ser analisado. Para proteger lógica
ou dados realmente confidenciais, mova-os para uma API/backend e retorne ao site
somente o resultado necessário.
