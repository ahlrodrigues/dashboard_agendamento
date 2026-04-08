const fs = require('fs');
const filepath = './config.json';
const local = './config.local.json';
const cfile = fs.existsSync(local) ? local : filepath;
const config = JSON.parse(fs.readFileSync(cfile, 'utf8'));
const baseUrl = config.url_base.replace(/\/+$/, "");
const token = config.basic_auth ? Buffer.from(`${config.basic_auth.username}:${config.basic_auth.password}`).toString("base64") : "";
const appToken = config.app_token_auth || {};
async function run() {
  const url = `${baseUrl}/api/ura/ordemservico/list/`;
  const body = new URLSearchParams();
  body.append('limit', '1');
  body.append('status', '0');
  if(appToken.app) body.append('app', appToken.app);
  if(appToken.token) body.append('token', appToken.token);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if(token) headers['Authorization'] = `Basic ${token}`;
  try {
     const res = await fetch(url, { method: 'POST', headers, body });
     const text = await res.text();
     console.log(text.substring(0, 1000));
  } catch(e) { console.log(e); }
}
run();
