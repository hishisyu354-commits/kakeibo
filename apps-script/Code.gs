/**
 * 家計簿ツール群サーバー（Google Apps Script・1プロジェクトで共用）
 *
 * 1) 食費家計簿の自動同期（doGet / JSONP）
 *    Gmail に届く「三菱UFJ-VISAデビットのご利用のお知らせメール」を読み取り、
 *    食費家計簿アプリが取得できる JSON（JSONP）として返します。
 *    ※ 食費専用（このデビットは食費だけに使う）前提なので、届いた通知は全部そのまま食費になります。
 *    （三井住友カード等に切り替える場合は GMAIL_QUERY を差出人・件名に合わせて変えるだけ）
 *
 * 2) 食材ストッカーのAI連携（doPost / JSON）
 *    - action=ai      … 食品パッケージ写真 → 食材名・賞味期限の読み取り（Gemini API 無料枠）
 *    - action=recipes … 在庫リスト → 料理の提案（Gemini API 無料枠）
 *    - action=pantry  … 在庫スナップショットの保存（毎朝のメール通知用）
 *    - action=ping    … 接続テスト
 *    さらに setupNotifyTrigger() を1回実行すると、毎朝 期限が近い食材をメールでお知らせします。
 *
 * セットアップは同じフォルダの SETUP.md を参照してください。
 * まず下の CONFIG を自分の値に変えてから、デプロイしてください。
 */

var CONFIG = {
  // アプリ側 URL に ?token=... で付ける秘密キー（長めのランダム文字列にする）
  TOKEN: 'CHANGE_ME_to_a_long_random_string',

  // ---- 食材ストッカー（AI）用 ----
  // Google AI Studio (https://aistudio.google.com/apikey) で無料発行したAPIキー
  GEMINI_API_KEY: 'CHANGE_ME_gemini_api_key',
  // 使うモデル（無料枠あり）。エラーが出る場合は 'gemini-2.5-flash-lite' や 'gemini-2.0-flash' に変更
  GEMINI_MODEL: 'gemini-2.5-flash',
  // 期限通知メールの宛先（空なら自分のGoogleアカウントのメールアドレス）
  NOTIFY_EMAIL: '',
  // アプリから日数が送られてこない場合の既定値（何日前から知らせるか）
  NOTIFY_DAYS: 3,

  // ---- 食費家計簿（カード同期）用 ----
  // 食費専用デビットの下4桁（例 '1234'）。本文にこの4桁を含むメールだけ対象にします。
  // 通知メールに下4桁が載っていない場合は空 '' のままでOK（そのデビットのメール全部が対象）。
  CARD_LAST4: '',

  // 何日前までのメールを見るか（家計簿の対象期間をカバーできればOK）
  LOOKBACK_DAYS: 45,

  // Gmail 検索クエリ：三菱UFJ-VISAデビットの「ご利用のお知らせ」
  //   差出人 mail@debit.bk.mufg.jp ／ 件名「【三菱UFJ-VISAデビット】ご利用のお知らせ」
  GMAIL_QUERY: 'from:debit.bk.mufg.jp subject:(ご利用のお知らせ)',

  TZ: 'Asia/Tokyo'
};

/** アプリからの取得口（JSONP）。デプロイ後の /exec URL をアプリに貼ります。 */
function doGet(e){
  var p = (e && e.parameter) ? e.parameter : {};
  var callback = p.callback || '';
  var payload;
  if(p.token !== CONFIG.TOKEN){
    payload = { ok:false, error:'unauthorized' };
  } else {
    try { payload = { ok:true, transactions: fetchTransactions() }; }
    catch(err){ payload = { ok:false, error:String(err) }; }
  }
  var json = JSON.stringify(payload);
  if(callback){
    // JSONP（アプリは <script> で読み込むので CORS 不要）
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/** 対象メールを検索して取引配列を作る。id は Gmail のメッセージID（重複排除に使う）。 */
function fetchTransactions(){
  var query = CONFIG.GMAIL_QUERY + ' newer_than:' + CONFIG.LOOKBACK_DAYS + 'd';
  var threads = GmailApp.search(query, 0, 300);
  var out = [];
  for(var i=0;i<threads.length;i++){
    var msgs = threads[i].getMessages();
    for(var j=0;j<msgs.length;j++){
      var m = msgs[j];
      var body = m.getPlainBody() || '';
      if(CONFIG.CARD_LAST4 && !matchesLast4_(body)) continue; // 食費カード以外は除外
      var tx = parseMail(body, m.getDate());
      if(tx){ tx.id = m.getId(); out.push(tx); }
    }
  }
  return out;
}

/**
 * 利用通知メール本文から { date:'YYYY-MM-DD', amount:Number, memo:String } を抽出。
 * ★ 実物メールをもらったら、この正規表現を実物に合わせて確定します（SETUP.md 参照）。
 */
function parseMail(body, mailDate){
  // 金額：取引ラベル「ご利用金額」の直後の数字だけを信頼する。
  //  ・裸の「金額」は使わない（ご請求予定金額/合計金額/ご利用可能金額 等の複合ラベルを誤って拾うため）
  //  ・フォールバックはポイント/還元/残高などの行を除外した上で「◯円」→「¥◯」の順
  var amount = null;
  var mAmt = body.match(/ご利用金額[】\]：:\s]*[￥¥]?\s*([\d,]+)\s*円?/);
  if(!mAmt){
    var safe = body.split(/\r?\n/).filter(function(L){ return !/ポイント|還元|相当|残高|上限|可能額/.test(L); }).join('\n');
    mAmt = safe.match(/([\d,]{2,})\s*円/) || safe.match(/[￥¥]\s*([\d,]+)/);
  }
  if(mAmt) amount = parseInt(String(mAmt[1]).replace(/,/g,''), 10);
  if(!amount || amount <= 0) return null;

  // 日付：本文の日付 → なければメール受信日
  var date;
  var mDate = body.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if(mDate){ date = mDate[1] + '-' + pad2_(mDate[2]) + '-' + pad2_(mDate[3]); }
  else { date = Utilities.formatDate(mailDate, CONFIG.TZ, 'yyyy-MM-dd'); }

  // 店名：ラベルの後ろ（無ければ空 → アプリ側では「カード」と表示）
  var memo = '';
  var mShop = body.match(/(?:ご?利用先|ご?利用店名|加盟店(?:名)?)[：:\s]+([^\r\n]+)/);
  if(mShop){ memo = String(mShop[1]).trim().slice(0, 40); }

  return { date: date, amount: amount, memo: memo };
}

function pad2_(n){ n = String(n); return n.length < 2 ? '0' + n : n; }

/** 下4桁の照合：他の数字と地続きの偶然一致（承認番号など）を除外。全角数字も半角化して比較。 */
function matchesLast4_(body){
  var b = String(body).replace(/[０-９]/g, function(d){ return String.fromCharCode(d.charCodeAt(0) - 0xFEE0); });
  return new RegExp('(?:^|[^0-9])' + CONFIG.CARD_LAST4 + '(?![0-9])').test(b);
}

/** 動作確認用：エディタでこの関数を実行 → 実行ログに件数とサンプルが出れば成功（初回は権限承認あり）。 */
function testFetch(){
  var t = fetchTransactions();
  Logger.log('取得件数: ' + t.length);
  Logger.log(JSON.stringify(t.slice(0, 5), null, 2));
}

/* ================================================================
 * 食材ストッカー（pantry）— doPost / Gemini / 期限通知メール
 * ================================================================ */

/** 食材ストッカーからの受け口（fetch POST・JSON）。token はURLの ?token= で照合。 */
function doPost(e){
  var out;
  try{
    var p = (e && e.parameter) ? e.parameter : {};
    var body = {};
    try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }catch(err){ body = {}; }
    if(p.token !== CONFIG.TOKEN){
      out = { ok:false, error:'unauthorized' };
    } else {
      var action = String(body.action || p.action || '');
      if(action === 'ai')           out = { ok:true, item: extractFoodInfo_(body.image, body.mime, body.today) };
      else if(action === 'recipes') out = { ok:true, recipes: suggestRecipes_(body.items, body.meal, body.genre) };
      else if(action === 'recipe')  out = { ok:true, recipe: recipeDetail_(body.name, body.uses, body.buy) };
      else if(action === 'pantry')  out = savePantry_(body.items, body.notifyDays);
      else if(action === 'ping')    out = { ok:true, gemini: geminiConfigured_() };
      else out = { ok:false, error:'unknown action' };
    }
  }catch(err){
    out = { ok:false, error: String((err && err.message) || err).slice(0, 200) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function geminiConfigured_(){
  return !!(CONFIG.GEMINI_API_KEY && CONFIG.GEMINI_API_KEY.indexOf('CHANGE_ME') < 0);
}

/** Gemini API（無料枠）を JSON応答モードで呼ぶ。parts は generateContent の parts 配列。 */
function geminiJson_(parts){
  if(!geminiConfigured_()) throw new Error('Gemini APIキーが未設定です（Apps ScriptのCONFIG.GEMINI_API_KEYを設定してください）');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL
          + ':generateContent?key=' + encodeURIComponent(CONFIG.GEMINI_API_KEY);
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 8192 }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if(code === 429) throw new Error('AIの無料枠の上限です。少し時間をおいてお試しください');
  if(code !== 200) throw new Error('AI応答エラー（HTTP ' + code + '）');
  var data = JSON.parse(res.getContentText());
  var cand = data && data.candidates && data.candidates[0];
  var parts = cand && cand.content && cand.content.parts;
  var text = '';
  if(parts){ for(var i = 0; i < parts.length; i++){ if(parts[i] && typeof parts[i].text === 'string') text += parts[i].text; } }
  if(!text) throw new Error('AIの応答が空でした。もう一度お試しください');
  return JSON.parse(text);
}

/** 写真 → { name, expiry(YYYY-MM-DD|null), kind } */
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

/** 在庫リスト → 料理提案 { canMake:[], buyMore:[] } */
var COOK_MEALS_ = ['朝','昼','夜','おやつ','夜食'];
var COOK_GENRES_ = ['和食','洋食','中華','エスニック','麺・丼','スープ','サラダ・副菜'];
function whitelist_(v, list){ return (typeof v === 'string' && list.indexOf(v) >= 0) ? v : ''; }

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
    '「(期限間近)」が付いた食材を優先的に使ってください。\n' +
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

/** 1つの料理の詳しい作り方（材料・手順・コツ）を生成。料理タブでタップされたとき呼ぶ。 */
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

/** 在庫スナップショットを保存（毎朝の期限通知メールが読む） */
function savePantry_(items, notifyDays){
  if(!Array.isArray(items)) throw new Error('items がありません');
  // 通知に使うのは「在庫かつ期限あり」だけに絞って保存する
  // （ScriptProperties は1値あたり9KBまでのため、全件保存だと数百件で保存に失敗し通知が古いまま固まる）
  var clean = items.slice(0, 500).map(function(it){
    it = it || {};
    return {
      name: (typeof it.name === 'string') ? it.name.trim().slice(0, 40) : '',
      expiry: (typeof it.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.expiry)) ? it.expiry : null,
      state: it.state === 'out' ? 'out' : 'stock'
    };
  }).filter(function(it){ return it.name && it.state === 'stock' && it.expiry; });
  var days = (typeof notifyDays === 'number' && notifyDays >= 1 && notifyDays <= 14) ? Math.round(notifyDays) : CONFIG.NOTIFY_DAYS;
  // 念のためのサイズガード：9KBに収まらなければ期限が近い順に残して間引く
  clean.sort(function(a, b){ return a.expiry < b.expiry ? -1 : 1; });
  var data = { items: clean, notifyDays: days, updatedAt: new Date().toISOString() };
  var json = JSON.stringify(data);
  while(byteLen_(json) > 8800 && clean.length > 1){
    clean = clean.slice(0, Math.floor(clean.length * 0.8));
    data.items = clean;
    json = JSON.stringify(data);
  }
  PropertiesService.getScriptProperties().setProperty('PANTRY_DATA', json);
  return { ok: true, saved: clean.length };
}

function byteLen_(s){ return Utilities.newBlob(s, 'text/plain').getBytes().length; }

/** 毎朝の期限チェック（時間トリガーから呼ばれる）。期限切れ/間近があればメール。 */
function notifyExpiry(){
  var raw = PropertiesService.getScriptProperties().getProperty('PANTRY_DATA');
  if(!raw) return;
  var data;
  try{ data = JSON.parse(raw); }catch(e){ return; }
  var items = (data && data.items) || [];
  var days = (data && data.notifyDays) || CONFIG.NOTIFY_DAYS;
  var today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  var expired = [], soon = [];
  for(var i = 0; i < items.length; i++){
    var it = items[i];
    if(!it || it.state !== 'stock' || !it.expiry) continue;
    var d = dayDiff_(today, it.expiry);
    if(d < 0) expired.push(it.name + '（' + (-d) + '日超過）');
    else if(d <= days) soon.push(it.name + '（' + (d === 0 ? '今日まで' : 'あと' + d + '日・' + it.expiry.replace(/-/g, '/')) + '）');
  }
  if(!expired.length && !soon.length) return;
  var lines = [];
  if(expired.length) lines.push('【期限切れ】\n・' + expired.join('\n・'));
  if(soon.length) lines.push('【期限が近い】\n・' + soon.join('\n・'));
  lines.push('早めに使い切りましょう。料理の提案はアプリの「🍳料理」タブからどうぞ。');
  var to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if(!to) return;
  MailApp.sendEmail(to,
    '【食材ストッカー】期限が近い食材が' + (expired.length + soon.length) + '件あります',
    lines.join('\n\n'));
}

/** 通知トリガーの設定（エディタで1回実行）：毎朝8時台に notifyExpiry を実行。 */
function setupNotifyTrigger(){
  var triggers = ScriptApp.getProjectTriggers();
  for(var i = 0; i < triggers.length; i++){
    if(triggers[i].getHandlerFunction() === 'notifyExpiry') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('notifyExpiry').timeBased().everyDays(1).atHour(8).inTimezone(CONFIG.TZ).create();
  Logger.log('OK: 毎朝8時台（' + CONFIG.TZ + '）に期限チェックを実行します（メールは該当がある日だけ届きます）');
}

function dayDiff_(fromYmd, toYmd){
  var f = fromYmd.split('-'), t = toYmd.split('-');
  var a = new Date(+f[0], +f[1] - 1, +f[2]);
  var b = new Date(+t[0], +t[1] - 1, +t[2]);
  return Math.round((b - a) / 86400000);
}

/** 動作確認用：Gemini接続テスト（エディタで実行、初回は権限承認あり）。 */
function testGemini(){
  var out = geminiJson_([{ text: '{"ok": true} というJSONをそのまま返してください。' }]);
  Logger.log(JSON.stringify(out));
}
