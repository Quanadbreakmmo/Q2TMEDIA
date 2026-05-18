const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const https = require('https');

// ── FIREBASE ADMIN ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── HELPER: Gọi Facebook API ──
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

function parseNum(s) {
  if (!s || s === '—') return 0;
  s = s.toString().trim().replace(/,/g, '');
  if (s.toUpperCase().includes('M')) return parseFloat(s) * 1000000;
  if (s.toUpperCase().includes('K')) return parseFloat(s) * 1000;
  return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
}

function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return Math.round(n).toString();
}

async function main() {
  console.log('🚀 Q2T Media — Bắt đầu sync Facebook API...');
  const now = new Date().toLocaleTimeString('vi-VN');
  
  // Đọc tất cả tokens từ Firebase
  const tokensSnap = await db.collection('tokens').get();
  const tokens = tokensSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  
  if (tokens.length === 0) {
    console.log('⚠️ Chưa có token nào trong Firebase!');
    return;
  }
  
  console.log(`📋 Tìm thấy ${tokens.length} token`);
  
  let synced = 0, errors = 0;

  for (const t of tokens) {
    if (!t.token || t.token.length < 20) continue;
    
    try {
      console.log(`\n🔄 Đang sync: ${t.name || 'Token ' + t.id}`);
      
      // Bước 1: Lấy danh sách page từ User Token
      const accounts = await fetchFB(
        `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token,fan_count,followers_count&access_token=${t.token}`
      );

      if (accounts.error) {
        // Thử dùng như Page Token
        const pageInfo = await fetchFB(
          `https://graph.facebook.com/v20.0/me?fields=name,id,fan_count,followers_count&access_token=${t.token}`
        );
        
        if (pageInfo.error) {
          console.log(`❌ Token lỗi: ${pageInfo.error.message}`);
          await db.collection('tokens').doc(t.id).update({ status: 'err' });
          errors++;
          continue;
        }

        // Xử lý Page Token
        await syncOnePage(db, t, pageInfo, t.token, now);
        await db.collection('tokens').doc(t.id).update({
          status: 'ok', name: pageInfo.name, page_id: pageInfo.id
        });
        synced++;
        continue;
      }

      // User Token — sync tất cả page
      if (accounts.data && accounts.data.length > 0) {
        console.log(`✓ Tìm thấy ${accounts.data.length} page`);
        
        for (const pageData of accounts.data) {
          await syncOnePage(db, null, pageData, pageData.access_token || t.token, now);
          synced++;
        }
        
        // Cập nhật token status
        await db.collection('tokens').doc(t.id).update({
          status: 'ok',
          name: accounts.data[0].name,
          page_id: accounts.data[0].id
        });
      } else {
        console.log('⚠️ Token hợp lệ nhưng không có page nào');
        await db.collection('tokens').doc(t.id).update({ status: 'ok' });
      }

    } catch (e) {
      console.log(`❌ Lỗi: ${e.message}`);
      await db.collection('tokens').doc(t.id).update({ status: 'err' });
      errors++;
    }
  }

  // Cập nhật thời gian sync cuối
  await db.collection('settings').doc('sync').set({
    last_sync: now,
    last_sync_full: new Date().toISOString(),
    synced_count: synced,
    error_count: errors
  });

  console.log(`\n✅ Sync xong! ${synced} page thành công, ${errors} lỗi`);
}

async function syncOnePage(db, token, pageData, accessToken, now) {
  const pageId = pageData.id;
  const pageName = pageData.name;
  const newFol = pageData.followers_count || pageData.fan_count || 0;

  console.log(`  📄 ${pageName} — Followers: ${fmtNum(newFol)}`);

  // Lấy insights reach
  let reach = '—', reachNum = 0;
  try {
    const insights = await fetchFB(
      `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_impressions_unique&period=day&access_token=${accessToken}`
    );
    if (insights.data && insights.data[0] && insights.data[0].values) {
      const vals = insights.data[0].values;
      if (vals.length > 0) {
        reachNum = vals[vals.length - 1].value || 0;
        reach = fmtNum(reachNum);
      }
    }
  } catch(e) {
    console.log(`  ⚠️ Không lấy được reach: ${e.message}`);
  }

  // Lấy views (page_views_total)
  let views = '—';
  try {
    const viewsData = await fetchFB(
      `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_views_total&period=day&access_token=${accessToken}`
    );
    if (viewsData.data && viewsData.data[0] && viewsData.data[0].values) {
      const vals = viewsData.data[0].values;
      if (vals.length > 0) {
        views = fmtNum(vals[vals.length - 1].value || 0);
      }
    }
  } catch(e) {}

  // Tìm page trong Firebase
  const pagesSnap = await db.collection('pages')
    .where('pid', '==', pageId).limit(1).get();
  
  let existingPage = null;
  if (!pagesSnap.empty) {
    existingPage = { id: pagesSnap.docs[0].id, ...pagesSnap.docs[0].data() };
  } else {
    // Tìm theo tên
    const byName = await db.collection('pages')
      .where('name', '==', pageName).limit(1).get();
    if (!byName.empty) {
      existingPage = { id: byName.docs[0].id, ...byName.docs[0].data() };
    }
  }

  // Tính health score
  const prevFol = existingPage ? parseNum(existingPage.followers) : 0;
  const folChange = newFol - prevFol;
  let score = 75;
  if (folChange > 1000) score = Math.min(100, score + 20);
  else if (folChange > 0) score = Math.min(100, score + 5);
  else if (folChange < -1000) score = Math.max(10, score - 25);
  else if (folChange < 0) score = Math.max(10, score - 10);

  const pageUpdate = {
    name: pageName,
    pid: pageId,
    followers: fmtNum(newFol),
    reach: reach,
    views: views,
    fol_change: folChange,
    score: Math.round(score),
    status: score < 40 ? 'error' : score < 70 ? 'warn' : 'active',
    last_sync: now,
    auto_synced: true
  };

  if (existingPage) {
    await db.collection('pages').doc(existingPage.id).update(pageUpdate);
    console.log(`  ✓ Cập nhật: ${pageName} (${fmtNum(newFol)} followers, reach: ${reach})`);
  } else {
    // Tự động thêm page mới
    await db.collection('pages').add({
      ...pageUpdate,
      emoji: '📄',
      cat: 'Khác',
      trend: folChange >= 0 ? '+' + (prevFol > 0 ? ((folChange/prevFol)*100).toFixed(1) : '0') + '%' : (prevFol > 0 ? ((folChange/prevFol)*100).toFixed(1) : '0') + '%',
      mgr: '—'
    });
    console.log(`  ✓ Thêm page mới: ${pageName}`);
  }
}

main().catch(e => {
  console.error('❌ Lỗi nghiêm trọng:', e);
  process.exit(1);
});
