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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('🚀 Q2T Media Sync — ' + new Date().toLocaleString('vi-VN'));
  const now = new Date().toLocaleTimeString('vi-VN');

  // ── Đọc TẤT CẢ dữ liệu Firebase 1 LẦN DUY NHẤT ──
  const [tokensSnap, pagesSnap] = await Promise.all([
    db.collection('tokens').get(),
    db.collection('pages').get()
  ]);

  const tokens = tokensSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const existingPages = {};
  pagesSnap.docs.forEach(d => {
    const data = d.data();
    if (data.pid) existingPages[data.pid] = { id: d.id, ...data };
    existingPages[data.name] = { id: d.id, ...data };
  });

  // Lọc bỏ token page (type=page) chỉ giữ user token
  const userTokens = tokens.filter(t => t.token && t.token.length > 20 && t.type !== 'page');

  if (userTokens.length === 0) { console.log('⚠️ Chưa có token!'); return; }
  console.log(`📋 ${userTokens.length} user token`);

  // ── Lấy dữ liệu từ Facebook ──
  const pageUpdates = {}; // pageId -> update object
  const newPageTokens = {}; // pageId -> page token

  for (const t of userTokens) {
    console.log(`\n🔄 Token: ${t.name||t.id}`);
    try {
      const accounts = await fetchFB(
        `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token&limit=200&access_token=${t.token}`
      );

      if (accounts.error) {
        console.log(`  ❌ ${accounts.error.message}`);
        continue;
      }

      if (!accounts.data || accounts.data.length === 0) {
        console.log(`  ⚠️ Không có page`);
        continue;
      }

      console.log(`  📑 ${accounts.data.length} page`);

      // Lấy dữ liệu từng page từ Facebook (không gọi Firebase)
      for (const p of accounts.data) {
        const pageToken = p.access_token || t.token;
        newPageTokens[p.id] = { name: p.name, token: pageToken };

        try {
          // Thông tin cơ bản
          const info = await fetchFB(
            `https://graph.facebook.com/v20.0/${p.id}?fields=name,fan_count,followers_count&access_token=${pageToken}`
          );
          if (info.error) { console.log(`  ❌ ${p.name}: ${info.error.message}`); continue; }

          const newFol = info.followers_count || info.fan_count || 0;

          // Reach
          let reach = '—';
          try {
            const ins = await fetchFB(
              `https://graph.facebook.com/v20.0/${p.id}/insights?metric=page_impressions_unique&period=day&access_token=${pageToken}`
            );
            if (ins.data?.[0]?.values?.length > 0) {
              reach = fmtNum(ins.data[0].values[ins.data[0].values.length-1].value || 0);
            }
          } catch(e) {}

          // Tính score
          const existing = existingPages[p.id] || existingPages[p.name];
          const prevFol = existing ? (parseFloat((existing.followers||'0').replace(/[KM]/g,m=>m==='K'?'000':'000000').replace(/[^0-9]/g,''))||0) : 0;
          const folChange = newFol - prevFol;
          let score = existing?.score || 75;
          if (folChange > 1000) score = Math.min(100, score+15);
          else if (folChange > 0) score = Math.min(100, score+5);
          else if (folChange < -500) score = Math.max(10, score-15);
          else if (folChange < 0) score = Math.max(10, score-5);

          pageUpdates[p.id] = {
            name: p.name, pid: p.id,
            followers: fmtNum(newFol), reach,
            fol_change: folChange,
            score: Math.round(score),
            status: score < 40 ? 'error' : score < 70 ? 'warn' : 'active',
            last_sync: now, auto_synced: true,
            // Giữ lại doanh thu cũ nếu có
            ...(existing?.rev_total ? {
              rev_in: existing.rev_in,
              rev_re: existing.rev_re,
              rev_st: existing.rev_st,
              rev_total: existing.rev_total,
              bonus_perf: existing.bonus_perf,
              rev_updated: existing.rev_updated
            } : {})
          };

          console.log(`  ✓ ${p.name}: ${fmtNum(newFol)} followers, reach: ${reach}`);
          await sleep(200); // Tránh rate limit Facebook
        } catch(e) {
          console.log(`  ❌ ${p.name}: ${e.message}`);
        }
      }
    } catch(e) {
      console.log(`❌ Token lỗi: ${e.message}`);
    }
  }

  // ── Ghi Firebase dùng BATCH (tối đa 500 operations/batch) ──
  console.log(`\n💾 Lưu ${Object.keys(pageUpdates).length} page vào Firebase...`);
  
  const pageEntries = Object.entries(pageUpdates);
  let synced = 0;

  // Chia thành batch 400 operations
  for (let i = 0; i < pageEntries.length; i += 400) {
    const batch = db.batch();
    const chunk = pageEntries.slice(i, i + 400);

    for (const [pageId, update] of chunk) {
      const existing = existingPages[pageId] || existingPages[update.name];
      if (existing) {
        batch.update(db.collection('pages').doc(existing.id), update);
      } else {
        const newRef = db.collection('pages').doc();
        batch.set(newRef, { ...update, emoji:'📄', cat:'Khác', trend:'+0%', mgr:'—' });
      }
      synced++;
    }

    await batch.commit();
    console.log(`  ✓ Batch ${Math.floor(i/400)+1}: ${chunk.length} page`);
  }

  // Cập nhật settings sync (1 lần duy nhất)
  await db.collection('settings').doc('sync').set({
    last_sync: now,
    last_sync_iso: new Date().toISOString(),
    synced, errors: 0
  });

  console.log(`\n✅ Xong! ${synced} page cập nhật thành công!`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
