const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('خطأ: متغير البيئة MONGODB_URI غير معرّف. أضِفه في إعدادات الاستضافة.');
}

// cached on globalThis so warm serverless invocations (Vercel) reuse the same connection
const cache = globalThis.__mongoCache || (globalThis.__mongoCache = { client: null, db: null, promise: null });
let db = cache.db;

async function connect() {
  if (cache.db) { db = cache.db; return db; }
  if (!cache.promise) {
    cache.promise = (async () => {
      const client = new MongoClient(MONGODB_URI, { maxPoolSize: Number(process.env.MONGO_POOL) || 5, minPoolSize: 0, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 8000 });
      await client.connect();
      cache.client = client;
      return client.db(process.env.MONGODB_DB_NAME || 'release_dock');
    })().catch((e) => { cache.promise = null; throw e; });
  }
  db = await cache.promise;
  cache.db = db;
  // locally: wait for indexes. On Vercel: create them once per instance in the background (createIndex is idempotent and cheap),
  // so a cold start is never slowed down and the indexes still exist even though nobody runs a script.
  if (!process.env.VERCEL) await ensureIndexes(db);
  else if (!cache.indexing) { cache.indexing = true; ensureIndexes(db).catch((e) => { cache.indexing = false; console.error('index setup failed:', e.message); }); }
  return db;
}

async function ensureIndexes(db) {

  // Existing indexes
  await db.collection('admins').createIndex({ username: 1 }, { unique: true });
  await db.collection('apps').createIndex({ slug: 1 }, { unique: true });
  await db.collection('apps').createIndex({ published: 1, updated_at: -1 });
  await db.collection('downloads').createIndex({ app_id: 1 });
  await db.collection('downloads').createIndex({ downloaded_at: 1 });

  // ===== NEW: Categories collection indexes =====
  await db.collection('categories').createIndex({ type: 1, visible: 1 });
  await db.collection('categories').createIndex({ type: 1, name: 1 });
  await db.collection('categories').createIndex({ type: 1, display_order: 1 });

  // ===== NEW: Designs category_id index (for fast filtering) =====
  await db.collection('designs').createIndex({ category_id: 1 });
  await db.collection('designs').createIndex({ type: 1, category_id: 1, visible: 1 });

  // videos / design categories (public lists sorted by display_order)
  await db.collection('videos').createIndex({ visible: 1, display_order: 1 });
  await db.collection('design_categories').createIndex({ type: 1, display_order: 1 });
  // AI assistant knowledge base
  await db.collection('ai_knowledge').createIndex({ active: 1, category: 1 });
  await db.collection('ai_knowledge').createIndex({ updated_at: -1 });
  await db.collection('ai_unanswered').createIndex({ count: -1, last_at: -1 });

  console.log('متصل بقاعدة بيانات MongoDB بنجاح');
}

function getDb() {
  if (!db) db = cache.db;
  if (!db) throw new Error('قاعدة البيانات غير متصلة بعد — استدعِ connect() أولًا عند بدء تشغيل الخادم');
  return db;
}

module.exports = { connect, getDb };
