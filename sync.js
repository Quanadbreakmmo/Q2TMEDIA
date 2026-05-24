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

// Lấy doanh thu từ Facebook Monetization API
async function getPageRevenue(pageId, pageToken) {
  const rev = { content: 0, bonus: 0, total: 0 };
  try {
    // Lấy tổng doanh thu tháng
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), 1);
    const sinceTs = Math.floor(since.getTime() / 1000);
    const untilTs = Math.floor(now.getTime() / 1000);

    // In-stream ads revenue
    const instreamUrl = `https://graph.facebook.com/v20.0/${pageId}/insights?metric=page_video_view_time&period=month&since=${sinceTs}&until=${untilTs}&access_token=${pageToken}`;
    const instream = await fetchFB(instreamUrl);
    
    // Monetization summary
    const monUrl = `https://graph.facebook.com/v20.0/${pageId}?fields=is_eligible_for_monetization&access_token=${pageToken}`;
    const mon = await fetchFB(monUrl);
    
    if (!mon.error) {
      // Page có thể kiếm tiền - lấy earnings
      const earningsUrl = `https://graph.facebook.com/v20.0/${pageId}/earnings?access_token=${pageToken}`;
      const earnings = await fetchFB(earningsUrl);
      if (!earnings.error && earnings.data) {
        earnings.data.forEach(e => {
          if (e.payment_type === 'content_monetization') rev.content += e.amount || 0;
          else if (e.payment_type === 'bonus') rev.bonus += e.amount || 0;
          else rev.content += e.amount || 0;
        });
        rev.total = rev.content + rev.bonus;
      }
    }
  } catch(e) {}
  return rev;
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

    // Doanh thu (chạy 1 lần/ngày)
    const rev = await getPageRevenue(pageId, pageToken);

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

    // Thêm doanh thu nếu có
    if (rev.total > 0) {
      update.rev_in = '$' + rev.content.toFixed(2);
      update.rev_re = '$0.00';
      update.rev_st = '$0.00';
      update.rev_su = '$0.00';
      update.bonus_perf = '$' + rev.bonus.toFixed(2);
      update.bonus_creator = '$0.00';
      update.bonus_milestone = '$0.00';
      update.bonus_other = '$0.00';
      update.rev_total = '$' + rev.total.toFixed(2);
      update.rev_updated = now;
      console.log(`  💰 Doanh thu: $${rev.total.toFixed(2)} (Content: $${rev.content.toFixed(2)}, Bonus: $${rev.bonus.toFixed(2)})`);
    }

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
      // Lấy danh sách page từ User Token
      const accounts = await fetchFB(
        `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token&limit=200&access_token=${t.token}`
      );

      if (!accounts.error && accounts.data && accounts.data.length > 0) {
        console.log(`  📑 ${accounts.data.length} page`);
        for (const p of accounts.data) {
          const pageToken = p.access_token || t.token;
          const ok = await syncOnePage(p.id, p.name, pageToken, now);
          if (ok) synced++; else errors++;

          // Lưu Page Token vào Firebase
          const existTok = await db.collection('tokens').where('page_id','==',p.id).limit(1).get();
          if (existTok.empty) {
            await db.collection('tokens').add({
              name: p.name, page_id: p.id,
              token: p.access_token,
              status: 'ok', type: 'page'
            });
          } else {
            await db.collection('tokens').doc(existTok.docs[0].id).update({
              token: p.access_token, status: 'ok', last_sync: now
            });
          }
        }
        await db.collection('tokens').doc(t.id).update({ status:'ok', last_sync:now, pages_count:accounts.data.length });
      } else if (t.page_id) {
        const ok = await syncOnePage(t.page_id, t.name||'Page', t.token, now);
        if (ok) { synced++; await db.collection('tokens').doc(t.id).update({ status:'ok', last_sync:now }); }
        else { errors++; await db.collection('tokens').doc(t.id).update({ status:'err' }); }
      } else {
        console.log(`  ⚠️ Token hợp lệ nhưng không có page`);
        await db.collection('tokens').doc(t.id).update({ status:'ok' });
      }
    } catch(e) {
      console.log(`❌ ${e.message}`);
      await db.collection('tokens').doc(t.id).update({ status:'err' });
      errors++;
    }
  }

  await db.collection('settings').doc('sync').set({
    last_sync: now,
    last_sync_iso: new Date().toISOString(),
    synced, errors
  });

  console.log(`\n✅ Xong! ${synced} page ✓, ${errors} lỗi`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
