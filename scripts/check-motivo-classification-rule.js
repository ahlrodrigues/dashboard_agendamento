const fs = require("fs");
const { execFileSync } = require("child_process");

function loadConfig() {
  const localPath = "./config.local.json";
  const defaultPath = "./config.json";
  const filePath = fs.existsSync(localPath) ? localPath : defaultPath;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function fetchMotivoCatalog(config) {
  const baseUrl = String(config.url_base || "").replace(/\/+$/, "");
  const app = String(config.app_token_auth?.app || "").trim();
  const token = String(config.app_token_auth?.token || "").trim();
  const url = `${baseUrl}/api/os/ocorrencia/motivo/list/?app=${encodeURIComponent(app)}&token=${encodeURIComponent(token)}`;
  const args = ["-s", url, "-H", "X-Requested-With: XMLHttpRequest"];
  if (config.basic_auth?.username && config.basic_auth?.password) {
    const auth = Buffer.from(`${config.basic_auth.username}:${config.basic_auth.password}`).toString("base64");
    args.push("-H", `Authorization: Basic ${auth}`);
  }
  const output = execFileSync("curl", args, { encoding: "utf8" });
  const body = JSON.parse(output);
  if (!Array.isArray(body)) {
    throw new Error("Resposta inesperada do catálogo de motivos.");
  }
  return body;
}

function findMotivo(items, descricao) {
  const target = String(descricao || "").trim().toLowerCase();
  return items.find((item) => String(item?.descricao || "").trim().toLowerCase() === target);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const config = loadConfig();
  const motivos = await fetchMotivoCatalog(config);

  const corretiva = findMotivo(motivos, "Corretiva");
  const preventiva = findMotivo(motivos, "Preventiva");
  const instalacaoKit = findMotivo(motivos, "Instalação de KIT");

  assert(corretiva, 'Motivo "Corretiva" não encontrado.');
  assert(preventiva, 'Motivo "Preventiva" não encontrado.');
  assert(instalacaoKit, 'Motivo "Instalação de KIT" não encontrado.');

  assert(corretiva.classificacoes_obrigatorio === false, '"Corretiva" deveria ter classificacoes_obrigatorio=false.');
  assert(preventiva.classificacoes_obrigatorio === false, '"Preventiva" deveria ter classificacoes_obrigatorio=false.');
  assert(instalacaoKit.classificacoes_obrigatorio === true, '"Instalação de KIT" deveria ter classificacoes_obrigatorio=true.');

  assert(Array.isArray(corretiva.classificacoes) && corretiva.classificacoes.length === 0, '"Corretiva" deveria ter classificacoes vazias.');
  assert(Array.isArray(preventiva.classificacoes) && preventiva.classificacoes.length === 0, '"Preventiva" deveria ter classificacoes vazias.');
  assert(Array.isArray(instalacaoKit.classificacoes) && instalacaoKit.classificacoes.length > 0, '"Instalação de KIT" deveria ter classificacoes preenchidas.');

  console.log("OK: regra de classificacao por motivo validada com sucesso.");
  console.log(`Corretiva: obrigatorio=${corretiva.classificacoes_obrigatorio}, classificacoes=${corretiva.classificacoes.length}`);
  console.log(`Preventiva: obrigatorio=${preventiva.classificacoes_obrigatorio}, classificacoes=${preventiva.classificacoes.length}`);
  console.log(`Instalação de KIT: obrigatorio=${instalacaoKit.classificacoes_obrigatorio}, classificacoes=${instalacaoKit.classificacoes.length}`);
}

run().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(1);
});
