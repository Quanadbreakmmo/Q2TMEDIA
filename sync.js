const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const https = require('https');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function fetchFB(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n/1000000).toFixed(1).replace('.0','')+'M';
  if (n >= 10000) return Math.round(n/1000)+'K';
  if (n >= 1000) return (n/1000).toFixed(1).replace('.0','')+'K';
  return Math.round(n).toString();
}

// ── Đổi User Token → Page Token không hết hạn ──
async function exchangeToPageTokens(userToken) {
  const accounts = await fetchFB(
    `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token&limit=200&access_token=${userToken}`
  );
  if (accounts.error || !accounts.data) return null;
  return accounts.data; // Mỗi page có access_token riêng không hết hạn
}

async function syncOnePage(pageId, pageName, pageToken, now) {
  try {
    const info = await fetchFB(
      `https://graph.facebook.com/v20.0/${pageId}?fields=name,fan_count,followers_count&access_token=${pageToken}`
    );
    if (info.error) { console.log(`  ❌ ${pageName}: ${info.error.message}`); return false; }

    const newFol = info.followers_count || info.fan_count || 0;

    // Reach hôm nay
    let reach = '—';
    try {
      const ins = await fetchFB(
        `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_impressions_unique&period=day&access_token=${pageToken}`
      );
      if (ins.data?.[0]?.values?.length > 0) {
        const rv = ins.data[0].values[ins.data[0].values.length-1].value || 0;
        reach = fmtNum(rv);
      }
    } catch(e) {}

    // Views
    let views = '—';
    try {
      const vw = await fetchFB(
        `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_views_total&period=day&access_token=${pageToken}`
      );
      if (vw.data?.[0]?.values?.length > 0) {
        views = fmtNum(vw.data[0].values[vw.data[0].values.length-1].value || 0);
      }
    } catch(e) {}

    // Tìm page trong Firebase
    let existingDoc = null;
    const byPid = await db.collection('pages').where('pid','==',pageId).limit(1).get();
    if (!byPid.empty) existingDoc = { id: byPid.docs[0].id, ...byPid.docs[0].data() };
    else {
      const byName = await db.collection('pages').where('name','==',pageName).limit(1).get();
      if (!byName.empty) existingDoc = { id: byName.docs[0].id, ...byName.docs[0].data() };
    }

    const prevFol = existingDoc ? (parseFloat((existingDoc.followers||'0').replace(/[KM]/g,m=>m==='K'?'000':'000000').replace(/[^0-9]/g,''))||0) : 0;
    const folChange = newFol - prevFol;
    let score = 75;
    if (folChange > 1000) score = Math.min(100, score+20);
    else if (folChange > 0) score = Math.min(100, score+5);
    else if (folChange < -1000) score = Math.max(10, score-25);
    else if (folChange < 0) score = Math.max(10, score-10);

    const update = {
      name: pageName, pid: pageId,
      followers: fmtNum(newFol), reach, views,
      fol_change: folChange,
      score: Math.round(score),
      status: score < 40 ? 'error' : score < 70 ? 'warn' : 'active',
      last_sync: now, auto_synced: true
    };

    if (existingDoc) {
      await db.collection('pages').doc(existingDoc.id).update(update);
    } else {
      await db.collection('pages').add({ ...update, emoji:'📄', cat:'Khác', trend:'+0%', mgr:'—' });
    }
    console.log(`  ✓ ${pageName}: ${fmtNum(newFol)} followers, reach: ${reach}`);
    return true;
  } catch(e) {
    console.log(`  ❌ ${pageName}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('🚀 Q2T Media Sync — ' + new Date().toLocaleString('vi-VN'));
  const now = new Date().toLocaleTimeString('vi-VN');

  const tokensSnap = await db.collection('tokens').get();
  const tokens = tokensSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (tokens.length === 0) { console.log('⚠️ Chưa có token!'); return; }
  console.log(`📋 ${tokens.length} token`);

  let synced = 0, errors = 0;

  for (const t of tokens) {
    if (!t.token || t.token.length < 20) continue;
    console.log(`\n🔄 Token: ${t.name||t.id}`);

    try {
      // Thử lấy danh sách page (User Token)
      const pages = await exchangeToPageTokens(t.token);

      if (pages && pages.length > 0) {
        console.log(`  📑 ${pages.length} page`);

        for (const p of pages) {
          // Dùng Page Token riêng — KHÔNG HẾT HẠN!
          const pageToken = p.access_token || t.token;
          const ok = await syncOnePage(p.id, p.name, pageToken, now);
          if (ok) synced++; else errors++;

          // Lưu Page Token vào Firebase để dùng sau
          const existTok = await db.collection('tokens').where('page_id','==',p.id).limit(1).get();
          if (existTok.empty) {
            await db.collection('tokens').add({
              name: p.name, page_id: p.id,
              token: p.access_token, // Page Token không hết hạn
              status: 'ok', type: 'page'
            });
          } else {
            // Cập nhật page token mới
            await db.collection('tokens').doc(existTok.docs[0].id).update({
              token: p.access_token, status: 'ok', last_sync: now
            });
          }
        }

        await db.collection('tokens').doc(t.id).update({
          status: 'ok', last_sync: now, pages_count: pages.length
        });

      } else if (t.page_id) {
        // Page Token trực tiếp
        const ok = await syncOnePage(t.page_id, t.name||'Page', t.token, now);
        if (ok) { synced++; await db.collection('tokens').doc(t.id).update({ status:'ok', last_sync:now }); }
        else { errors++; await db.collection('tokens').doc(t.id).update({ status:'err' }); }
      }

    } catch(e) {
      console.log(`❌ Lỗi: ${e.message}`);
      await db.collection('tokens').doc(t.id).update({ status: 'err' });
      errors++;
    }
  }

  await db.collection('settings').doc('sync').set({
    last_sync: now,
    last_sync_iso: new Date().toISOString(),
    synced: synced, errors: errors
  });

  console.log(`\n✅ Xong! ${synced} page ✓, ${errors} lỗi`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
