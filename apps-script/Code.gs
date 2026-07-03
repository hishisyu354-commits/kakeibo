/**
 * 食費家計簿 — カード利用通知メール → JSON 同期サーバー（Google Apps Script）
 *
 * 役割：Gmail に届く「三菱UFJ-VISAデビットのご利用のお知らせメール」を読み取り、
 *       食費家計簿アプリが取得できる JSON（JSONP）として返します。
 *       ※ 食費専用（このデビットは食費だけに使う）前提なので、届いた通知は全部そのまま食費になります。
 *       （三井住友カード等に切り替える場合は GMAIL_QUERY を差出人・件名に合わせて変えるだけ）
 *
 * セットアップは同じフォルダの SETUP.md を参照してください。
 * まず下の CONFIG を自分の値に変えてから、デプロイしてください。
 */

var CONFIG = {
  // アプリ側 URL に ?token=... で付ける秘密キー（長めのランダム文字列にする）
  TOKEN: 'CHANGE_ME_to_a_long_random_string',

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
