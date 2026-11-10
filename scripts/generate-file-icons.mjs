import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "node_modules", "material-icon-theme");
const manifest = JSON.parse(readFileSync(join(pkg, "dist", "material-icons.json"), "utf8"));

const extensions = `go mod sum ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx markdown yaml yml toml ini env
py pyi ipynb rb rs java kt kts swift c h cpp hpp cc cxx cs fs php sh bash zsh fish ps1 bat cmd sql prisma graphql gql
proto html htm css scss sass less styl vue svelte astro xml xsd svg png jpg jpeg gif webp ico bmp avif pdf zip tar gz tgz
rar 7z lock log txt csv tsv xls xlsx doc docx ppt pptx dart lua r scala ex exs erl hs clj tf tfvars hcl nix mk cmake gradle
vim wasm sol zig nim jl groovy pem key crt cer ttf otf woff woff2 mp3 wav flac mp4 mov webm mkv http rest conf cfg
properties tmpl hbs ejs pug twig liquid njk jinja j2 diff patch sqlite db drawio mermaid mmd puml excalidraw lockb
avro parquet ndjson jsonl rst adoc tex bib vtt srt ics env.example`.split(/\s+/).filter(Boolean);

const languageByExtension = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  json: "json", jsonc: "jsonc", json5: "json5", md: "markdown", markdown: "markdown", mdx: "mdx",
  yaml: "yaml", yml: "yaml", py: "python", pyi: "python", rb: "ruby", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", cs: "csharp", fs: "fsharp",
  php: "php", sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "shellscript",
  ps1: "powershell", bat: "bat", cmd: "bat", sql: "sql", html: "html", htm: "html",
  css: "css", scss: "scss", sass: "sass", less: "less", xml: "xml", xsd: "xml", lua: "lua",
  swift: "swift", dart: "dart", r: "r", go: "go", groovy: "groovy", diff: "diff", patch: "diff",
  vue: "vue", svelte: "svelte", ini: "ini", properties: "properties", toml: "toml",
};

const fileNames = `package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml yarn.lock bun.lockb bun.lock
tsconfig.json jsconfig.json go.mod go.sum go.work dockerfile docker-compose.yml docker-compose.yaml compose.yml
compose.yaml makefile readme.md license license.md licence .gitignore .gitattributes .gitmodules .env .env.local
.env.example .env.development .env.production .editorconfig .prettierrc .prettierrc.json .prettierignore .eslintrc
.eslintrc.json .eslintrc.js eslint.config.js eslint.config.mjs vite.config.ts vite.config.js vitest.config.ts
turbo.json claude.md agents.md cargo.toml cargo.lock requirements.txt pyproject.toml poetry.lock gemfile gemfile.lock
.nvmrc .npmrc .node-version tailwind.config.js tailwind.config.ts next.config.js next.config.mjs next.config.ts
jest.config.js jest.config.ts biome.json .dockerignore jenkinsfile changelog.md contributing.md security.md
renovate.json .gitlab-ci.yml wrangler.toml wrangler.json vercel.json netlify.toml .babelrc babel.config.js
webpack.config.js rollup.config.js postcss.config.js postcss.config.mjs nodemon.json .oxlintrc.json
playwright.config.ts cypress.config.ts .golangci.yml .golangci.yaml procfile vagrantfile .terraform.lock.hcl
openapi.yaml openapi.json swagger.yaml swagger.json .mcp.json mcp.json .cursorrules code_of_conduct.md
codeowners .htaccess robots.txt favicon.ico manifest.json deno.json bunfig.toml .tool-versions mise.toml
justfile taskfile.yml taskfile.yaml skill.md`.split(/\s+/).filter(Boolean);

const folderNames = `src source lib libs docs doc documentation test tests __tests__ spec specs e2e scripts script
config configs .config .github .gitlab .vscode .idea node_modules dist build out public assets asset images img
icons fonts components component hooks utils util helpers helper api server client app apps packages package pkg
cmd internal plugins plugin styles style css sass types typings models model services service store stores routes
router pages views view layouts layout migrations db database schemas schema i18n locales locale .claude .cursor
.husky .devcontainer docker deploy deployment infra infrastructure terraform k8s kubernetes helm ci .circleci temp
tmp logs log mocks mock __mocks__ fixtures examples example vendor bin templates template prisma sql proto
graphql middleware middlewares controllers controller handlers handler repository repositories domain entities
entity ui static environment environments security auth admin shared common core contexts context providers
provider features feature modules module workers worker jobs queue events event github .git .changeset .storybook
stories benchmarks benchmark tools tool resources resource data public_html www intl translations
android ios mobile web desktop electron functions lambda serverless .netlify .vercel coverage .next .nuxt .turbo
generated gen .agents skills .worktrees worktrees repositories repos plans prompts content blog posts`.split(/\s+/).filter(Boolean);

const compound = /^(test|spec|d|stories|story|config|module|e2e|e2e-spec|mock|types|setup|schema|service|controller|component|routes|store|hooks|utils)\.[a-z0-9]+$/u;

const svgCache = new Map();
function svg(iconId) {
  if (svgCache.has(iconId)) return iconId;
  const def = manifest.iconDefinitions[iconId];
  if (def === undefined) return null;
  const file = join(pkg, "dist", def.iconPath);
  const text = readFileSync(file, "utf8").replace(/\s+/gu, " ").trim();
  svgCache.set(iconId, text);
  return iconId;
}

const ext = {};
const known = new Set(extensions);
for (const e of extensions) {
  const id = manifest.fileExtensions[e] ?? manifest.languageIds[languageByExtension[e] ?? ""] ?? null;
  if (id !== null && svg(id) !== null) ext[e] = id;
}
for (const [key, id] of Object.entries(manifest.fileExtensions)) {
  if (!key.includes(".") || !compound.test(key)) continue;
  if (!known.has(key.slice(key.lastIndexOf(".") + 1))) continue;
  if (svg(id) !== null) ext[key] = id;
}

const names = {};
const lowerFileNames = Object.fromEntries(Object.entries(manifest.fileNames).map(([k, v]) => [k.toLowerCase(), v]));
for (const n of fileNames) {
  const id = lowerFileNames[n] ?? null;
  if (id !== null && svg(id) !== null) names[n] = id;
}

const folders = {};
const foldersOpen = {};
for (const n of folderNames) {
  const closed = manifest.folderNames[n];
  const open = manifest.folderNamesExpanded[n];
  if (closed !== undefined && open !== undefined && svg(closed) !== null && svg(open) !== null) {
    folders[n] = closed;
    foldersOpen[n] = open;
  }
}

const defaults = {
  file: svg(manifest.file),
  folder: svg(manifest.folder),
  folderOpen: svg(manifest.folderExpanded),
};

const svgs = Object.fromEntries([...svgCache.entries()].sort(([a], [b]) => a.localeCompare(b)));
const out = `export const ICON_SVGS: Readonly<Record<string, string>> = ${JSON.stringify(svgs, null, 0)};
export const EXTENSION_ICONS: Readonly<Record<string, string>> = ${JSON.stringify(ext)};
export const FILE_NAME_ICONS: Readonly<Record<string, string>> = ${JSON.stringify(names)};
export const FOLDER_ICONS: Readonly<Record<string, string>> = ${JSON.stringify(folders)};
export const FOLDER_OPEN_ICONS: Readonly<Record<string, string>> = ${JSON.stringify(foldersOpen)};
export const DEFAULT_ICONS = ${JSON.stringify(defaults)} as const;
`;
writeFileSync(join(here, "..", "ui", "file-icons.generated.ts"), out);
console.log(
  `icons ${svgCache.size}, extensions ${Object.keys(ext).length}, names ${Object.keys(names).length}, folders ${Object.keys(folders).length}, bytes ${out.length}`,
);
