/**
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


var COOK_MEALS_ = ['朝','昼','夜','おやつ','夜食'];

var COOK_GENRES_ = ['和食','洋食','中華','エスニック','麺・丼','スープ','サラダ・副菜'];

function whitelist_(v, list){ return (typeof v === 'string' && list.indexOf(v) >= 0) ? v : ''; }



function geminiConfigured_(){
  return !!(CONFIG.GEMINI_API_KEY && CONFIG.GEMINI_API_KEY.indexOf('CHANGE_ME') < 0);
}

function geminiJson_(parts){
  if(!geminiConfigured_()) throw new Error('Gemini APIキーが未設定です（Apps ScriptのCONFIG.GEMINI_API_KEYを設定してください）');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL
          + ':generateContent?key=' + encodeURIComponent(CONFIG.GEMINI_API_KEY);
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 8192 }
  };
  var options = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  // 一時的な混雑/レート系(429/500/503/529)は数秒あけて自動リトライ（最大3回）
  var res, code, delays = [0, 1500, 3500];
  for(var attempt = 0; attempt < delays.length; attempt++){
    if(delays[attempt]) Utilities.sleep(delays[attempt]);
    res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    if(code === 200) break;
    if(code !== 429 && code !== 500 && code !== 503 && code !== 529) break;  // 再試行しても無駄なエラーは即中断
  }
  if(code === 429) throw new Error('AIの無料枠の上限か混雑です。少し時間をおいてお試しください');
  if(code === 503 || code === 529) throw new Error('AIが混雑しています。少し時間をおいてもう一度お試しください');
  if(code !== 200) throw new Error('AI応答エラー（HTTP ' + code + '）');
  var data = JSON.parse(res.getContentText());
  var cand = data && data.candidates && data.candidates[0];
  var parts = cand && cand.content && cand.content.parts;
  var text = '';
  if(parts){ for(var i = 0; i < parts.length; i++){ if(parts[i] && typeof parts[i].text === 'string') text += parts[i].text; } }
  if(!text) throw new Error('AIの応答が空でした。もう一度お試しください');
  var parsed = JSON.parse(text);
  // responseMimeType=application/json でも null や配列が返り得るため、オブジェクト以外は {} に丸める
  // （呼び出し側は out.xxx を読むだけなので、これでクラッシュせず各バリデーションが空扱いにする）
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

function extractFoodInfo_(imageB64, mime, todayStr){
  if(typeof imageB64 !== 'string' || !imageB64) throw new Error('画像がありません');
  if(imageB64.length > 8 * 1024 * 1024) throw new Error('画像が大きすぎます');
  var today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayStr)) ? String(todayStr)
            : Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  var prompt =
    'これは食品（またはそのパッケージ）の写真です。次のJSONだけを返してください:\n' +
    '{"name": string, "expiry": string|null, "kind": "賞味期限"|"消費期限"|null}\n' +
    '- name: 食材の短い一般名（日本語。例: 牛乳, 食パン, 豚こま肉, 卵, ヨーグルト）。ブランド名や容量は含めない\n' +
    '- expiry: パッケージに印字された賞味期限/消費期限を YYYY-MM-DD で。' +
    '「26.11.30」「2026.11.30」「26 11 30」のような表記は変換する（2桁の年は20XX年）。' +
    '「11.30」のように年が無い場合は、今日(' + today + ')以降で最も近い日付として解釈する。' +
    '印字が読み取れなければ null\n' +
    '- kind: 印字が「消費期限」なら"消費期限"、「賞味期限」なら"賞味期限"、不明なら null';
  var out = geminiJson_([
    { inline_data: { mime_type: (mime === 'image/png' ? 'image/png' : 'image/jpeg'), data: imageB64 } },
    { text: prompt }
  ]);
  var name = (typeof out.name === 'string') ? out.name.trim().slice(0, 40) : '';
  var expiry = (typeof out.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.expiry)) ? out.expiry : null;
  var kind = (out.kind === '消費期限' || out.kind === '賞味期限') ? out.kind : null;
  return { name: name, expiry: expiry, kind: kind };
}

function extractReceipt_(imageB64, mime, todayStr){
  if(typeof imageB64 !== 'string' || !imageB64) throw new Error('画像がありません');
  if(imageB64.length > 8 * 1024 * 1024) throw new Error('画像が大きすぎます');
  var today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayStr)) ? String(todayStr)
            : Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  var prompt =
    'これはお店のレシートの写真です。次のJSONだけを返してください:\n' +
    '{"store": string, "date": string|null, "total": number|null, "items": [string]}\n' +
    '- store: 店名（読み取れなければ空文字）\n' +
    '- date: 購入日を YYYY-MM-DD で。今日(' + today + ')より未来にはしない。読み取れなければ null\n' +
    '- total: 合計の支払金額（税込・数字のみ、通貨記号やカンマ不要）。読み取れなければ null\n' +
    '- items: 買った「食品・食材」の短い一般名の配列（例: 牛乳, 卵, 豚こま肉, トマト）。' +
    'レジ袋・日用品・非食品や、小計/割引/ポイント/合計などの行は含めない。ブランド名・容量・数量・金額は含めない。最大30個\n' +
    '- 食品が無ければ items は空配列でよい';
  var out = geminiJson_([
    { inline_data: { mime_type: (mime === 'image/png' ? 'image/png' : 'image/jpeg'), data: imageB64 } },
    { text: prompt }
  ]);
  var store = (typeof out.store === 'string') ? out.store.trim().slice(0, 40) : '';
  var date = (typeof out.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.date) && out.date <= today) ? out.date : null;
  var total = (typeof out.total === 'number' && isFinite(out.total) && out.total > 0) ? Math.round(out.total) : null;
  var items = Array.isArray(out.items) ? out.items.filter(function(x){ return typeof x === 'string' && x.trim(); })
                .map(function(x){ return x.trim().slice(0, 40); }).slice(0, 30) : [];
  return { store: store, date: date, total: total, items: items };
}

function extractItemsFromText_(text){
  var t = String(text || '').slice(0, 2000).trim();
  if(!t) return [];
  var prompt =
    'これは冷蔵庫に入れる食材を声で読み上げた文章です。含まれる「食材名」だけを抜き出してください。\n' +
    '文章:「' + t + '」\n' +
    '- 数量・単位・助詞・「買った」等の動詞は除き、一般的で短い食材名にする（例:「牛乳を2本」→「牛乳」）\n' +
    '- 塩・砂糖など常備調味料や食品でない語は除く\n' +
    '- 重複はまとめる。最大50個。\n' +
    '次のJSONだけを返す: {"items":[string]}';
  var out = geminiJson_([{ text: prompt }]);
  var arr = Array.isArray(out.items) ? out.items : [];
  var seen = {}, res = [];
  for(var i = 0; i < arr.length; i++){
    if(typeof arr[i] !== 'string') continue;
    var n = arr[i].trim().slice(0, 40);
    if(!n || seen[n]) continue;
    seen[n] = true; res.push(n);
    if(res.length >= 50) break;
  }
  return res;
}

function recipeHelp_(name, ings, stock){
  var clean = function(a, n){ return (Array.isArray(a) ? a : []).filter(function(x){ return typeof x==='string' && x.trim(); }).map(function(x){ return x.trim().slice(0,40); }).slice(0, n); };
  var ingList = clean(ings, 30);
  var stockList = clean(stock, 60);
  if(!ingList.length) throw new Error('材料がありません');
  var prompt =
    '料理「' + String(name||'').slice(0,60) + '」を作ります。\n' +
    '必要な材料: ' + ingList.join('、') + '\n' +
    '今ある在庫: ' + (stockList.join('、') || '（なし）') + '\n' +
    '在庫に無い（不足している）材料を挙げ、その代用案（在庫にある物や一般家庭で代わりになりがちな物）を提案してください。\n' +
    '次のJSONだけを返す: {"missing":[string],"subs":[{"missing":string,"alt":string}]}';
  var out = geminiJson_([{ text: prompt }]);
  var missing = clean(out.missing, 20);
  var subs = [];
  if(Array.isArray(out.subs)){
    for(var i = 0; i < out.subs.length && subs.length < 20; i++){
      var s = out.subs[i] || {};
      if(typeof s.missing==='string' && typeof s.alt==='string' && s.missing.trim() && s.alt.trim()){
        subs.push({ missing: s.missing.trim().slice(0,40), alt: s.alt.trim().slice(0,80) });
      }
    }
  }
  return { missing: missing, subs: subs };
}

function suggestRecipes_(items, meal, genre){
  if(!Array.isArray(items) || !items.length) throw new Error('在庫が空です');
  var names = items.filter(function(x){ return typeof x === 'string' && x.trim(); })
                   .map(function(x){ return x.trim().slice(0, 50); }).slice(0, 60);   // 名前40字+「(期限間近)」6字を収容
  if(!names.length) throw new Error('在庫が空です');
  var m = whitelist_(meal, COOK_MEALS_);
  var g = whitelist_(genre, COOK_GENRES_);
  var prompt =
    'あなたは一人暮らしの自炊アシスタントです。手元にある食材は次の通りです:\n' +
    names.join('、') + '\n' +
    '塩・砂糖・醤油・味噌・油・酢・こしょう・めんつゆ等の基本調味料は常備している前提。\n' +
    '食材は賞味期限が近い順に並べてあります。**期限が近い食材から優先的に使い切る**提案にしてください。\n' +
    '「今日まで」「あと◯日」が付いた食材は特に優先し、できるだけ多くの提案で使ってください。' +
    '「(期限切れ)」が付いた食材は加熱調理前提で使い、難しければ無理に使わなくて構いません。\n' +
    (m ? '「' + m + '」に合う料理を中心に提案してください。\n' : '') +
    (g ? 'ジャンルは「' + g + '」を中心にしてください。\n' : '') +
    '次のJSONだけを返してください:\n' +
    '{"canMake":[{"name":string,"uses":[string],"how":string}],' +
    '"buyMore":[{"name":string,"uses":[string],"buy":[string],"how":string}]}\n' +
    '- canMake: 今の食材だけで作れる料理を最大4つ（uses=上のリストから使う食材名）\n' +
    '- buyMore: あと1〜2品買い足せば作れるおすすめを最大3つ（buy=買い足す食材）\n' +
    '- how: 1〜2文の簡単な作り方。節約・簡単・目安15分以内・一人分。\n' +
    '- 作れる料理が無ければ canMake は空配列でよい';
  var out = geminiJson_([{ text: prompt }]);
  var str = function(s, n){ return (typeof s === 'string') ? s.slice(0, n) : ''; };
  var arr = function(a, n){
    return Array.isArray(a) ? a.filter(function(x){ return typeof x === 'string'; })
                               .map(function(x){ return x.slice(0, 30); }).slice(0, n) : [];
  };
  var norm = function(list, withBuy, max){
    if(!Array.isArray(list)) return [];
    return list.slice(0, max).map(function(x){
      x = x || {};
      return { name: str(x.name, 40), uses: arr(x.uses, 10), buy: withBuy ? arr(x.buy, 6) : [], how: str(x.how, 300) };
    }).filter(function(x){ return x.name; });
  };
  return { canMake: norm(out.canMake, false, 4), buyMore: norm(out.buyMore, true, 3) };
}

function recipeDetail_(name, uses, buy){
  name = (typeof name === 'string') ? name.trim().slice(0, 60) : '';
  if(!name) throw new Error('料理名がありません');
  var clean = function(a){
    return Array.isArray(a) ? a.filter(function(x){ return typeof x === 'string' && x.trim(); })
                               .map(function(x){ return x.trim().slice(0, 40); }).slice(0, 20) : [];
  };
  var u = clean(uses), b = clean(buy);
  var prompt =
    'あなたは一人暮らしの自炊アシスタントです。\n' +
    '次の料理の、一人分の詳しい作り方を教えてください：「' + name + '」\n' +
    (u.length ? '使う手元の食材：' + u.join('、') + '\n' : '') +
    (b.length ? '買い足す食材：' + b.join('、') + '\n' : '') +
    '塩・砂糖・醤油・味噌・油・酢・こしょう・めんつゆ等の基本調味料は常備している前提。\n' +
    '次のJSONだけを返してください:\n' +
    '{"title":string,"servings":string,"time":string,"ingredients":[{"item":string,"amount":string}],"steps":[string],"tips":string}\n' +
    '- ingredients: 分量つきの材料（一人分・最大12個）\n' +
    '- steps: 手順を1文ずつ順番に（最大10・火加減や時間の目安を入れ、料理初心者にも分かるように）\n' +
    '- time: 目安の調理時間（例「約15分」）\n' +
    '- servings: 分量の目安（例「1人分」）\n' +
    '- tips: コツを一言（無ければ空文字）';
  var out = geminiJson_([{ text: prompt }]);
  var str = function(s, n){ return (typeof s === 'string') ? s.slice(0, n) : ''; };
  var ings = Array.isArray(out.ingredients) ? out.ingredients.slice(0, 12).map(function(x){
    x = x || {};
    return { item: str(x.item, 40), amount: str(x.amount, 30) };
  }).filter(function(x){ return x.item; }) : [];
  var steps = Array.isArray(out.steps) ? out.steps.filter(function(x){ return typeof x === 'string' && x.trim(); })
                                            .map(function(x){ return x.slice(0, 300); }).slice(0, 12) : [];
  return {
    title: str(out.title, 60) || name,
    servings: str(out.servings, 20),
    time: str(out.time, 20),
    ingredients: ings,
    steps: steps,
    tips: str(out.tips, 300)
  };
}
