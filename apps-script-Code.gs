/**
 * הסולטיז – הרשמה לצילומים "גילאים 1 עד 100 מנסים את הטרנדים הכי ויראליים"
 * Web app: הגנת reCAPTCHA, טופס, העלאת תמונה (חובה) וסרטון (רשות),
 * כל הרשמה נכנסת כשורה ב-Google Sheet בזמן אמת.
 *
 * שימור מידע:
 *  - הפרטים נשמרים (טבלה + קובץ גיבוי JSON) לפני העלאת הקבצים.
 *  - מזהה הגשה ייחודי => ניסיונות חוזרים לא יוצרים כפילויות.
 *  - reconcile() רץ כל 15 דקות: משחזר שורות חסרות מהגיבוי, משלים קבצים שעלו, מסמן תקועים.
 *  - תקלה => מייל התראה לבעלים עם כל הפרטים.
 */

// ---------- הגדרות ----------
var CONFIG = {
  title: 'גילאים 1 עד 100 מנסים את הטרנדים הכי ויראליים – הרשמה לצילומים',
  days: ['13.12', '14.12'],
  hours: ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00',
          '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00',
          '19:30', '20:00', '20:30', 'גמיש'],
  maxPhotoBytes: 30 * 1024 * 1024,
  maxVideoBytes: 300 * 1024 * 1024,
  sessionTtlSec: 6 * 60 * 60,
  maxSubmissionsPerHour: 120,
  stuckAfterMin: 60
};

var STATUS = {
  UPLOADING: 'מעלה קבצים…',
  DONE: 'הושלם',
  DONE_NO_VIDEO_FAIL: 'נשמר – הסרטון לא עלה',
  NO_PHOTO: 'נשמר – התמונה לא עלתה',
  STUCK: 'נשמר – ההעלאה לא הושלמה'
};

var HEADERS = ['מס׳', 'תאריך ושעת הרשמה', 'מי הפנה אותך?', 'שם מלא של המשתתף', 'גיל המשתתף',
               'טלפון ליצירת קשר', 'באיזה יום אפשר להגיע?', 'באיזו שעה נוח להגיע?',
               'תמונה', 'סרטון', 'סטטוס', 'מזהה הגשה'];
var COL = { num: 1, ts: 2, ref: 3, name: 4, age: 5, phone: 6, days: 7, hour: 8, photo: 9, video: 10, status: 11, id: 12 };

function props_() { return PropertiesService.getScriptProperties(); }
function cache_() { return CacheService.getScriptCache(); }
function now_(fmt) { return Utilities.formatDate(new Date(), 'Asia/Jerusalem', fmt || 'dd/MM/yyyy HH:mm'); }

// ---------- Web app / API ----------
// הדף עצמו מתארח מחוץ לגוגל (GitHub Pages) כדי שהתחברות לחשבונות גוגל לא תפריע למשתתפים.
// כאן רק API: הדף שולח POST עם {fn, args} ומקבל JSON.
var PUBLIC_PAGE_URL = 'https://thesaltiz.github.io/1-100/';
var API = { ping: function () { return 'pong'; }, beginSubmission: beginSubmission, newSession: newSession, startUpload: startUpload, uploadChunk: uploadChunk, finalize: finalize };
var ALLOWED_ORIGINS = ['https://thesaltiz.github.io', 'https://nave-napa.github.io'];

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API[req.fn];
    if (!fn) throw new Error('פעולה לא מוכרת');
    out = { ok: true, result: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return HtmlService.createHtmlOutput('<div dir="rtl" style="font-family:sans-serif;text-align:center;padding:40px">' +
    '<h2>הרשמה לצילומים – הסולטיז</h2><p><a target="_top" href="' + PUBLIC_PAGE_URL + '">לטופס ההרשמה לחצו כאן</a></p></div>')
    .setTitle('הרשמה לצילומים – הסולטיז');
}

// ---------- הקמה חד-פעמית ----------
function setup() {
  var p = props_();
  var folder, backup, ss;
  folder = p.getProperty('FOLDER_ID') ? DriveApp.getFolderById(p.getProperty('FOLDER_ID'))
         : DriveApp.createFolder('הרשמה – גילאים 1 עד 100 (תמונות וסרטונים)');
  p.setProperty('FOLDER_ID', folder.getId());
  backup = p.getProperty('BACKUP_ID') ? DriveApp.getFolderById(p.getProperty('BACKUP_ID'))
         : folder.createFolder('_גיבוי הרשמות (לא למחוק)');
  p.setProperty('BACKUP_ID', backup.getId());
  ss = p.getProperty('SHEET_ID') ? SpreadsheetApp.openById(p.getProperty('SHEET_ID'))
     : SpreadsheetApp.create('הרשמה – גילאים 1 עד 100 מנסים טרנדים');
  p.setProperty('SHEET_ID', ss.getId());
  if (!p.getProperty('OWNER_EMAIL')) p.setProperty('OWNER_EMAIL', Session.getEffectiveUser().getEmail());

  var sh = ss.getSheets()[0];
  sh.setName('נרשמים');
  sh.setRightToLeft(true);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#5B3DF5').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 40);
  [50, 130, 150, 180, 70, 130, 130, 110, 100, 100, 170, 120].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(1, COL.id, sh.getMaxRows(), 1).setFontColor('#999999').setFontSize(8);
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).createFilter();
  // הגנה רכה: כל עריכה ידנית מציגה אזהרה (מונע מחיקה בטעות)
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    sh.protect().setDescription('הטבלה מתעדכנת אוטומטית מהטופס – לא למחוק שורות').setWarningOnly(true);
  }
  // מנגנון שחזור אוטומטי כל 15 דקות
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'reconcile'; });
  if (!has) ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(15).create();
  return { sheetUrl: ss.getUrl(), folderUrl: folder.getUrl() };
}

// ---------- התראות ----------
function alertOwner_(subject, body) {
  try {
    var key = 'ALERT_' + now_('yyyyMMddHH');
    var n = Number(props_().getProperty(key) || 0);
    if (n >= 20) return;                      // לא להציף
    props_().setProperty(key, String(n + 1));
    MailApp.sendEmail(props_().getProperty('OWNER_EMAIL'), '⚠️ טופס הרשמה (הסולטיז): ' + subject, body);
  } catch (e) { console.error('alert failed', e); }
}

// ---------- גיבוי JSON (מקור אמת שני, בלתי תלוי בטבלה) ----------
function backupFolder_() { return DriveApp.getFolderById(props_().getProperty('BACKUP_ID')); }

function writeBackup_(rec) {
  var name = rec.id + '.json';
  var content = JSON.stringify(rec, null, 2);
  var it = backupFolder_().getFilesByName(name);
  if (it.hasNext()) it.next().setContent(content);
  else backupFolder_().createFile(name, content, MimeType.PLAIN_TEXT);
}

function readBackup_(id) {
  var it = backupFolder_().getFilesByName(id + '.json');
  return it.hasNext() ? JSON.parse(it.next().getBlob().getDataAsString()) : null;
}

// ---------- טבלה ----------
function sheet_() { return SpreadsheetApp.openById(props_().getProperty('SHEET_ID')).getSheetByName('נרשמים') ||
                           SpreadsheetApp.openById(props_().getProperty('SHEET_ID')).getSheets()[0]; }

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, COL.id, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

function link_(fileId, label) {
  return fileId ? '=HYPERLINK("https://drive.google.com/file/d/' + fileId + '/view","' + label + '")' : '';
}

function rowValues_(rec, num) {
  return [
    num, rec.createdAt, rec.referrer, rec.name, rec.age, "'" + rec.contactPhone, rec.days.join(', '),
    "'" + rec.hour, link_(rec.photoId, '📷 תמונה'), link_(rec.videoId, '🎬 סרטון'), rec.status, rec.id
  ];
}

// כתיבה/עדכון שורה לפי מזהה (idempotent)
function upsertRow_(rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_();
    var row = findRow_(sh, rec.id);
    var num;
    if (!row) { row = sh.getLastRow() + 1; num = row - 1; }
    else num = sh.getRange(row, COL.num).getValue() || row - 1;
    var v = rowValues_(rec, num);
    sh.getRange(row, 1, 1, v.length).setValues([v]).setVerticalAlignment('middle');
    var color = rec.status === STATUS.DONE ? (row % 2 ? '#ffffff' : '#F4F1FF') :
                rec.status === STATUS.UPLOADING ? '#FFF8E1' : '#FDE7EA';
    sh.getRange(row, 1, 1, v.length).setBackground(color);
    SpreadsheetApp.flush();
    return num;
  } finally {
    lock.releaseLock();
  }
}

// ---------- אנטי-ספאם + קליטת הפרטים (לפני ההעלאות) ----------
function safeText_(v, max) {
  var s = String(v == null ? '' : v).replace(/[\u0000-\u001F]/g, ' ').trim().substring(0, max || 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

// טלפון ישראלי: נייד 05X-XXXXXXX, קווי 0X-XXXXXXX, 07X-XXXXXXX; מקבל גם +972
function normalizePhone_(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d.indexOf('972') === 0) d = '0' + d.substring(3);
  if (/^05\d{8}$/.test(d) || /^07\d{8}$/.test(d)) return d.substring(0, 3) + '-' + d.substring(3);
  if (/^0[2-489]\d{7}$/.test(d)) return d.substring(0, 2) + '-' + d.substring(2);
  throw new Error('מספר הטלפון לא תקין. יש להזין מספר ישראלי, למשל 050-1234567');
}

function validate_(data) {
  var rec = {};
  rec.referrer = safeText_(String(data.referrer || '').replace(/\s+/g, ' '), 60);
  rec.name = safeText_(String(data.name || '').replace(/\s+/g, ' '), 60);
  if (rec.name.replace(/[^A-Za-z֐-׿؀-ۿЀ-ӿ]/g, '').length < 2) throw new Error('יש למלא שם מלא של המשתתף');
  rec.age = Number(data.age);
  if (!(rec.age >= 1 && rec.age <= 100 && Math.floor(rec.age) === rec.age)) throw new Error('יש לבחור גיל');
  rec.contactPhone = normalizePhone_(data.contactPhone);
  var day = data.day || (data.days && data.days.length === 1 ? data.days[0] : '');
  if (CONFIG.days.indexOf(day) === -1) throw new Error('יש לבחור יום אחד');
  rec.days = [day];
  if (CONFIG.hours.indexOf(data.hour) === -1) throw new Error('יש לבחור שעה');
  rec.hour = data.hour;
  return rec;
}

function verifyCaptcha_(captchaToken) {
  var secret = props_().getProperty('RECAPTCHA_SECRET');
  if (!secret) throw new Error('הגנת הספאם עדיין לא הוגדרה. פנו להפקה.');
  if (!captchaToken) throw new Error('יש לסמן "אני לא רובוט"');
  var res = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'post', payload: { secret: secret, response: captchaToken }, muteHttpExceptions: true
  });
  var j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j.success) throw new Error('האימות "אני לא רובוט" נכשל. סמנו שוב ונסו שוב.');
}

function beginSubmission(captchaToken, subId, data, files, origin) {
  var r = beginSubmission_(captchaToken, subId, data);
  // יצירת קישורי העלאה ישירה לדרייב (הדפדפן מעלה ישר לגוגל – מהיר בהרבה)
  r.uploads = {};
  if (files && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    files.forEach(function (f) {
      try { r.uploads[f.kind] = createSession_(subId, f.kind, f.name, f.type, f.size, origin, r.name).url; }
      catch (e) { console.error('session', e); }
    });
  }
  return r;
}

function beginSubmission_(captchaToken, subId, data) {
  if (!/^[0-9a-f-]{20,40}$/i.test(String(subId))) throw new Error('מזהה לא תקין. רעננו את הדף.');
  // ניסיון חוזר של אותה הגשה (למשל נפל אינטרנט) – מחזירים את אותו טוקן בלי כפילות
  var existingTok = cache_().get('sub_' + subId);
  if (existingTok && cache_().get('tok_' + existingTok)) return { token: existingTok, resumed: true, name: safeText_(String((data || {}).name || ''), 60) };

  var rec = validate_(data || {});
  verifyCaptcha_(captchaToken);

  var hk = 'SUBS_' + now_('yyyyMMddHH');
  var n = Number(props_().getProperty(hk) || 0);
  if (n >= CONFIG.maxSubmissionsPerHour) throw new Error('יש עומס כרגע. נסו שוב בעוד כמה דקות.');
  props_().setProperty(hk, String(n + 1));

  rec.id = subId;
  rec.createdAt = now_();
  rec.createdMs = Date.now();
  rec.status = STATUS.UPLOADING;
  rec.photoId = '';
  rec.videoId = '';
  rec.wantsVideo = !!(data && data.wantsVideo);
  rec.wantsPhoto = !!(data && data.wantsPhoto);

  var token = Utilities.getUuid();
  cache_().put('tok_' + token, subId, CONFIG.sessionTtlSec);
  cache_().put('sub_' + subId, token, CONFIG.sessionTtlSec);

  // שמירה כפולה: קודם גיבוי, אחר כך טבלה. אם אחד נכשל – השני מספיק, ו-reconcile ישלים.
  var saved = false, errs = [];
  try { writeBackup_(rec); saved = true; } catch (e) { errs.push('backup: ' + e); }
  try { upsertRow_(rec); saved = true; } catch (e) { errs.push('sheet: ' + e); }
  if (errs.length) alertOwner_('תקלה בשמירת הרשמה', 'שגיאות: ' + errs.join(' | ') + '\n\nפרטי ההרשמה:\n' + JSON.stringify(rec, null, 2));
  if (!saved) throw new Error('לא הצלחנו לשמור כרגע. נסו שוב בעוד רגע – הפרטים שמילאתם לא נמחקו.');
  return { token: token, name: rec.name };
}

// סטטוס לפי מה שהמשתתף ביקש להעלות ומה שבפועל עלה
function statusFor_(rec, stale, videoFailed) {
  var photoOk = rec.photoId || !rec.wantsPhoto;
  var videoOk = rec.videoId || !rec.wantsVideo;
  if (photoOk && videoOk) return STATUS.DONE;
  if (!stale && !videoFailed && rec.status === STATUS.UPLOADING) return STATUS.UPLOADING;
  if (!photoOk) return STATUS.NO_PHOTO;
  return STATUS.DONE_NO_VIDEO_FAIL;
}

function subForToken_(token) {
  var sub = token && cache_().get('tok_' + token);
  if (!sub) throw new Error('פג תוקף ההגשה. רעננו את הדף ונסו שוב.');
  return sub;
}

// ---------- העלאת קבצים (resumable ל-Drive, בחלקים) ----------
function createSession_(subId, kind, fileName, mimeType, size, origin, personName) {
  if (kind !== 'photo' && kind !== 'video') throw new Error('סוג קובץ לא תקין');
  size = Number(size);
  if (!(size > 0)) throw new Error('הקובץ ריק');
  if (kind === 'photo' && !/^image\//.test(mimeType)) throw new Error('יש לבחור קובץ תמונה');
  if (kind === 'video' && !/^video\//.test(mimeType)) throw new Error('יש לבחור קובץ וידאו');
  var max = kind === 'photo' ? CONFIG.maxPhotoBytes : CONFIG.maxVideoBytes;
  if (size > max) throw new Error(kind === 'photo' ? 'התמונה גדולה מדי' : 'הסרטון גדול מדי (עד ' + Math.round(max / 1048576) + 'MB)');

  if (personName === undefined) personName = (readBackup_(subId) || {}).name;
  var ext = (String(fileName).match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0];
  var safeName = String(personName || '').replace(/^'/, '').replace(/[\\\/:*?"<>|]/g, '').substring(0, 60).trim() || 'משתתף';
  // המזהה בשם ובתיאור הקובץ מאפשר לשייך קובץ להרשמה גם אם הדף נסגר
  var name = now_('yyyy-MM-dd_HH-mm') + '_' + safeName + '_' + (kind === 'photo' ? 'תמונה' : 'סרטון') + '_' + subId.substring(0, 8) + ext;
  var headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) };
  if (origin) headers.Origin = origin;
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'post', contentType: 'application/json; charset=UTF-8', headers: headers,
    payload: JSON.stringify({ name: name, parents: [props_().getProperty('FOLDER_ID')], mimeType: mimeType,
                              description: 'submission:' + subId + ' kind:' + kind }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('שגיאה בפתיחת ההעלאה (' + res.getResponseCode() + ')');
  var h = res.getAllHeaders();
  return { url: h['Location'] || h['location'], size: size };
}

// קישור העלאה ישירה חדש (לניסיון חוזר)
function newSession(token, kind, fileName, mimeType, size, origin) {
  var subId = subForToken_(token);
  if (ALLOWED_ORIGINS.indexOf(origin) === -1) throw new Error('מקור לא מורשה');
  return { url: createSession_(subId, kind, fileName, mimeType, size, origin).url };
}

// מסלול גיבוי: העלאה בחלקים דרך הסקריפט (אם ההעלאה הישירה נכשלה)
function startUpload(token, kind, fileName, mimeType, size) {
  var subId = subForToken_(token);
  var s = createSession_(subId, kind, fileName, mimeType, size, null);
  var uploadId = Utilities.getUuid();
  cache_().put('up_' + uploadId, JSON.stringify({ url: s.url, token: token, size: s.size, kind: kind }), 6 * 3600);
  return { uploadId: uploadId };
}

function uploadChunk(token, uploadId, start, b64) {
  subForToken_(token);
  var rec = cache_().get('up_' + uploadId);
  if (!rec) throw new Error('ההעלאה פגה. נסו שוב.');
  rec = JSON.parse(rec);
  if (rec.token !== token) throw new Error('הרשאה לא תקינה');
  var bytes = Utilities.base64Decode(b64);
  start = Number(start);
  var res = UrlFetchApp.fetch(rec.url, {
    method: 'put', contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + start + '-' + (start + bytes.length - 1) + '/' + rec.size },
    payload: bytes, followRedirects: false, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 308) return { done: false };
  if (code === 200 || code === 201) {
    var fileId = JSON.parse(res.getContentText()).id;
    cache_().put('file_' + fileId, JSON.stringify({ token: token, kind: rec.kind }), 6 * 3600);
    return { done: true, fileId: fileId };
  }
  throw new Error('שגיאה בהעלאה (' + code + ')');
}

function checkUploadedFile_(fileId, subId, kind) {
  if (!fileId) return '';
  try {
    var f = DriveApp.getFileById(String(fileId));
    return String(f.getDescription() || '') === 'submission:' + subId + ' kind:' + kind ? f.getId() : '';
  } catch (e) { return ''; }
}

// ---------- סיום: עדכון השורה עם הקבצים ----------
function finalize(token, photoId, videoId, videoFailed, data) {
  var subId = subForToken_(token);
  var rec = readBackup_(subId);
  if (!rec) throw new Error('ההרשמה לא נמצאה. פנו להפקה.');
  if (data) {   // הפרטים העדכניים מהטופס (אם שונו אחרי השמירה הראשונה)
    var upd = validate_(data);
    ['referrer', 'name', 'age', 'contactPhone', 'days', 'hour'].forEach(function (k) { rec[k] = upd[k]; });
    rec.wantsPhoto = !!data.wantsPhoto; rec.wantsVideo = !!data.wantsVideo;
  }
  var p = checkUploadedFile_(photoId, subId, 'photo');
  var v = checkUploadedFile_(videoId, subId, 'video');
  if (p) rec.photoId = p;
  if (v) rec.videoId = v;
  rec.status = statusFor_(rec, false, videoFailed);
  rec.updatedAt = now_();
  var errs = [];
  try { writeBackup_(rec); } catch (e) { errs.push('backup: ' + e); }
  var num = '';
  try { num = upsertRow_(rec); } catch (e) { errs.push('sheet: ' + e); }
  if (errs.length) alertOwner_('תקלה בעדכון הרשמה', errs.join(' | ') + '\n\n' + JSON.stringify(rec, null, 2));
  return { ok: true, number: num, status: rec.status };
}

// ---------- reconcile: רץ כל 15 דקות ----------
function reconcile() {
  var props = props_();
  var folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
  // מיפוי קבצים שעלו לפי מזהה ההגשה (מתוך ה-description)
  var filesBySub = {};
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var m = String(f.getDescription() || '').match(/submission:([0-9a-f-]+) kind:(photo|video)/i);
    if (m) { filesBySub[m[1]] = filesBySub[m[1]] || {}; filesBySub[m[1]][m[2]] = f.getId(); }
  }
  var sh = sheet_();
  var last = sh.getLastRow();
  var idsInSheet = {};
  if (last >= 2) sh.getRange(2, COL.id, last - 1, 1).getValues().forEach(function (r) { idsInSheet[String(r[0])] = true; });

  var restored = [], fixed = [];
  var bit = backupFolder_().getFiles();
  while (bit.hasNext()) {
    var bf = bit.next();
    var rec;
    try { rec = JSON.parse(bf.getBlob().getDataAsString()); } catch (e) { continue; }
    if (!rec || !rec.id) continue;
    var changed = false;
    var fs = filesBySub[rec.id] || {};
    if (!rec.photoId && fs.photo) { rec.photoId = fs.photo; changed = true; }
    if (!rec.videoId && fs.video) { rec.videoId = fs.video; changed = true; }
    if (rec.status === STATUS.UPLOADING || rec.status === STATUS.STUCK || rec.status === STATUS.NO_PHOTO) {
      var old = rec.status;
      var stale = Date.now() - (rec.createdMs || 0) > CONFIG.stuckAfterMin * 60000;
      if (rec.wantsPhoto === undefined) rec.wantsPhoto = true;   // הרשמות מלפני שהתמונה הפכה לרשות
      var st = statusFor_(rec, stale, false);
      if (st !== STATUS.UPLOADING || !stale) rec.status = st;
      if (stale && rec.status === STATUS.UPLOADING) rec.status = STATUS.STUCK;
      if (rec.status !== old) changed = true;
    }
    if (changed) { writeBackup_(rec); fixed.push(rec.name); }
    if (changed || !idsInSheet[rec.id]) {
      if (!idsInSheet[rec.id]) restored.push(rec.name);
      upsertRow_(rec);
    }
  }
  if (restored.length) alertOwner_('שוחזרו שורות לטבלה', 'ההרשמות הבאות היו חסרות בטבלה ושוחזרו מהגיבוי:\n' + restored.join('\n'));
  return { restored: restored.length, fixed: fixed.length };
}
