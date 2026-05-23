const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const https = require('https');

// ── FIREBASE ADMIN ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function fetchFB(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return Math.round(n).toString();
}

async function syncPage(pageId, pageName, pageToken) {
  console.log(`  📄 Syncing: ${pageName} (${pageId})`);
  
  try {
    // Lấy thông tin page
    const info = await fetchFB(
      `https://graph.facebook.com/v20.0/${pageId}?fields=name,fan_count,followers_count&access_token=${pageToken}`
    );
    if (info.error) {
      console.log(`  ❌ Lỗi: ${info.error.message}`);
      return false;
    }

    const newFol = info.followers_count || info.fan_count || 0;

    // Lấy reach
    let reach = '—', reachNum = 0;
    try {
      const ins = await fetchFB(
        `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_impressions_unique&period=day&access_token=${pageToken}`
      );
      if (ins.data?.[0]?.values?.length > 0) {
        reachNum = ins.data[0].values[ins.data[0].values.length - 1].value || 0;
        reach = fmtNum(reachNum);
      }
    } catch(e) {}

    // Lấy views
    let views = '—';
    try {
      const vw = await fetchFB(
        `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_views_total&period=day&access_token=${pageToken}`
      );
      if (vw.data?.[0]?.values?.length > 0) {
        views = fmtNum(vw.data[0].values[vw.data[0].values.length - 1].value || 0);
      }
    } catch(e) {}

    // Tìm page trong Firebase theo pid hoặc tên
    let existingDoc = null;
    const byPid = await db.collection('pages').where('pid', '==', pageId).limit(1).get();
    if (!byPid.empty) {
      existingDoc = { id: byPid.docs[0].id, ...byPid.docs[0].data() };
    } else {
      const byName = await db.collection('pages').where('name', '==', pageName).limit(1).get();
      if (!byName.empty) {
        existingDoc = { id: byName.docs[0].id, ...byName.docs[0].data() };
      }
    }

    const prevFol = existingDoc ? 
      (parseFloat((existingDoc.followers || '0').replace(/[KM]/g, m => m === 'K' ? '000' : '000000').replace(/[^0-9]/g, '')) || 0) : 0;
    const folChange = newFol - prevFol;
    
    let score = 75;
    if (folChange > 1000) score = Math.min(100, score + 20);
    else if (folChange > 0) score = Math.min(100, score + 5);
    else if (folChange < -1000) score = Math.max(10, score - 25);
    else if (folChange < 0) score = Math.max(10, score - 10);

    const now = new Date().toLocaleString('vi-VN');
    const update = {
      name: pageName,
      pid: pageId,
      followers: fmtNum(newFol),
      reach,
      views,
      fol_change: folChange,
      score: Math.round(score),
      status: score < 40 ? 'error' : score < 70 ? 'warn' : 'active',
      last_sync: now,
      auto_synced: true
    };

    if (existingDoc) {
      await db.collection('pages').doc(existingDoc.id).update(update);
      console.log(`  ✓ Cập nhật: ${pageName} — ${fmtNum(newFol)} followers, reach: ${reach}`);
    } else {
      await db.collection('pages').add({
        ...update,
        emoji: '📄',
        cat: 'Khác',
        trend: '+0%',
        mgr: '—'
      });
      console.log(`  ✓ Thêm mới: ${pageName}`);
    }
    return true;
  } catch(e) {
    console.log(`  ❌ Lỗi: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('🚀 Q2T Media — Bắt đầu sync Facebook API...');
  const now = new Date().toLocaleTimeString('vi-VN');

  // Đọc tokens từ Firebase
  const tokensSnap = await db.collection('tokens').get();
  const tokens = tokensSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (tokens.length === 0) {
    console.log('⚠️ Chưa có token nào!');
    return;
  }

  console.log(`📋 Tìm thấy ${tokens.length} token`);
  let synced = 0, errors = 0;

  for (const t of tokens) {
    if (!t.token || t.token.length < 20) continue;
    console.log(`\n🔄 Xử lý token: ${t.name || t.id}`);

    try {
      // Lấy danh sách tất cả page từ User Token
      const accounts = await fetchFB(
        `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token&limit=100&access_token=${t.token}`
      );

      if (accounts.error) {
        console.log(`❌ Token lỗi: ${accounts.error.message}`);
        await db.collection('tokens').doc(t.id).update({ status: 'err' });
        errors++;
        continue;
      }

      if (accounts.data && accounts.data.length > 0) {
        console.log(`✓ Tìm thấy ${accounts.data.length} page`);
        
        for (const page of accounts.data) {
          // Dùng page token riêng của từng page
          const pageToken = page.access_token || t.token;
          const ok = await syncPage(page.id, page.name, pageToken);
          if (ok) synced++;
          else errors++;
          
          // Lưu page token vào Firebase để dùng sau
          const existing = await db.collection('tokens').where('page_id', '==', page.id).limit(1).get();
          if (existing.empty && page.id !== t.page_id) {
            await db.collection('tokens').add({
              name: page.name,
              page_id: page.id,
              token: page.access_token,
              status: 'ok',
              parent_token: t.id
            });
          }
        }

        await db.collection('tokens').doc(t.id).update({ 
          status: 'ok',
          last_sync: now,
          pages_count: accounts.data.length
        });

      } else {
        // Thử dùng như Page Token trực tiếp
        if (t.page_id) {
          const ok = await syncPage(t.page_id, t.name || 'Page', t.token);
          if (ok) synced++;
          else errors++;
        }
        await db.collection('tokens').doc(t.id).update({ status: 'ok' });
      }

    } catch(e) {
      console.log(`❌ Lỗi: ${e.message}`);
      await db.collection('tokens').doc(t.id).update({ status: 'err' });
      errors++;
    }
  }

  // Lưu thời gian sync
  await db.collection('settings').doc('sync').set({
    last_sync: now,
    last_sync_full: new Date().toISOString(),
    synced_count: synced,
    error_count: errors
  });

  console.log(`\n✅ Sync xong! ${synced} page thành công, ${errors} lỗi`);
}

main().catch(e => {
  console.error('❌ Lỗi nghiêm trọng:', e);
  process.exit(1);
});
