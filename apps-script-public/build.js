// 公開用AIプロキシ Code.gs を、正となる ../apps-script/Code.gs のAI関数から生成する。
// 個人用（Gmail/カード同期/pantry保存）は一切含めない。手編集せず、これを実行して再生成する:
//   node apps-script-public/build.js
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "apps-script", "Code.gs");
const OUT = path.join(__dirname, "Code.gs");
const src = fs.readFileSync(SRC, "utf8");

// 複数行関数（col0 の "\n}" で終わる）を名前で抜き出す
function grab(name){
  const m = src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"));
  if(!m) throw new Error("function not found: " + name);
  return m[0];
}
// 1行関数
function grab1(name){
  const m = src.match(new RegExp("function " + name + "\\([^\\n]*\\}"));
  if(!m) throw new Error("1-line function not found: " + name);
  return m[0];
}
function grabRe(re){
  const m = src.match(re);
  if(!m) throw new Error("pattern not found: " + re);
  return m[0];
}

const header = `/**
 * 公開用AIプロキシ（Apps Script）— 設定ゼロで使える「ノーセットアップ版」の裏側。
 * ★個人用プロジェクトとは別物。Gmail/カード同期/pantry保存/個人データには一切触れない。
 *   提供するのは doPost のAIアクション（ai/receipt/recipes/recipe/itemsFromText/recipeHelp/ping）だけ。
 * ★このファイルは apps-script-public/build.js が ../apps-script/Code.gs のAI関数から生成する（手編集しない）。
 * 秘密情報(PUBLIC_TOKEN/GEMINI_API_KEY)は ScriptProperties があれば優先。git には CHANGE_ME のみ。
 */
var CONFIG = {
  PUBLIC_TOKEN: 'CHANGE_ME_public_token',    // 公開ページに埋める（秘密ではない・下のレート上限で保護）
  GEMINI_API_KEY: 'CHANGE_ME_gemini_api_key',
  GEMINI_MODEL: 'gemini-2.5-flash',
  TZ: 'Asia/Tokyo',
  DAILY_CAP: 500                              // 全体の1日あたり呼び出し上限（Gemini無料枠を守る）
};
(function(){
  try{
    var props = PropertiesService.getScriptProperties().getProperties();
    ['PUBLIC_TOKEN','GEMINI_API_KEY','GEMINI_MODEL'].forEach(function(k){
      if(props[k] != null && props[k] !== '') CONFIG[k] = props[k];
    });
    if(props.DAILY_CAP && !isNaN(+props.DAILY_CAP)) CONFIG.DAILY_CAP = +props.DAILY_CAP;
  }catch(e){}
})();

/** 公開プロキシはAI専用。GET（カード同期など個人機能）は一切提供しない。 */
function doGet(e){
  return ContentService.createTextOutput(JSON.stringify({ ok:false, error:'not available' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 全体の1日あたり回数上限。超えたら当日は断る（無料枠の枯渇・乱用を防ぐ）。 */
function rateOk_(){
  try{
    var props = PropertiesService.getScriptProperties();
    var key = 'cnt_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd');
    var n = parseInt(props.getProperty(key) || '0', 10) + 1;
    props.setProperty(key, String(n));
    return n <= CONFIG.DAILY_CAP;
  }catch(e){ return true; }   // 計測に失敗しても機能自体は止めない
}

/** ノーセットアップ版アプリからの受け口（AIアクションのみ）。token は公開トークンで照合。 */
function doPost(e){
  var out;
  try{
    var p = (e && e.parameter) ? e.parameter : {};
    var body = {};
    try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }catch(err){ body = {}; }
    var action = String(body.action || p.action || '');
    if(p.token !== CONFIG.PUBLIC_TOKEN){
      out = { ok:false, error:'unauthorized' };
    } else if(action === 'ping'){
      out = { ok:true, gemini: geminiConfigured_() };
    } else if(!rateOk_()){
      out = { ok:false, error:'本日の無料利用の上限に達しました。時間をおいて（明日以降）お試しください' };
    } else if(action === 'ai'){            out = { ok:true, item: extractFoodInfo_(body.image, body.mime, body.today) }; }
      else if(action === 'receipt'){       out = { ok:true, receipt: extractReceipt_(body.image, body.mime, body.today) }; }
      else if(action === 'recipes'){       out = { ok:true, recipes: suggestRecipes_(body.items, body.meal, body.genre) }; }
      else if(action === 'recipe'){        out = { ok:true, recipe: recipeDetail_(body.name, body.uses, body.buy) }; }
      else if(action === 'itemsFromText'){ out = { ok:true, items: extractItemsFromText_(body.text) }; }
      else if(action === 'recipeHelp'){    out = { ok:true, help: recipeHelp_(body.name, body.ings, body.stock) }; }
      else { out = { ok:false, error:'unknown action' }; }
  }catch(err){
    out = { ok:false, error: String((err && err.message) || err).slice(0, 200) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ===== 以下は ../apps-script/Code.gs から自動コピーしたAI関数（手編集しない） =====
`;

const parts = [
  header,
  grabRe(/var COOK_MEALS_ = \[[^\]]*\];/),
  grabRe(/var COOK_GENRES_ = \[[^\]]*\];/),
  grab1("whitelist_"),
  "",
  grab("geminiConfigured_"),
  grab("geminiJson_"),
  grab("extractFoodInfo_"),
  grab("extractReceipt_"),
  grab("extractItemsFromText_"),
  grab("recipeHelp_"),
  grab("suggestRecipes_"),
  grab("recipeDetail_")
];
const outStr = parts.join("\n\n") + "\n";
fs.writeFileSync(OUT, outStr);
console.log("wrote", OUT, "(" + outStr.length + " bytes)");
