const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('خطأ: متغير البيئة MONGODB_URI غير معرّف. أضِفه في إعدادات الاستضافة.');
}

const cache = globalThis.__mongoCache || (globalThis.__mongoCache = { client: null, db: null, promise: null });
let db = cache.db;

async function connect() {
  if (cache.db) { db = cache.db; return db; }
  if (!cache.promise) {
    cache.promise = (async () => {
      const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
      await client.connect();
      cache.client = client;
      return client.db(process.env.MONGODB_DB_NAME || 'release_dock');
    })().catch((e) => { cache.promise = null; throw e; });
  }
  db = await cache.promise;
  cache.db = db;
  if (!process.env.VERCEL) await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db) {
  await db.collection('admins').createIndex({ username: 1 }, { unique: true });
  await db.collection('apps').createIndex({ slug: 1 }, { unique: true });
  await db.collection('apps').createIndex({ published: 1, updated_at: -1 });
  await db.collection('downloads').createIndex({ app_id: 1 });
  await db.collection('downloads').createIndex({ downloaded_at: 1 });
  await db.collection('categories').createIndex({ type: 1, visible: 1 });
  await db.collection('categories').createIndex({ type: 1, name: 1 });
  await db.collection('categories').createIndex({ type: 1, display_order: 1 });
  await db.collection('designs').createIndex({ category_id: 1 });
  await db.collection('designs').createIndex({ type: 1, category_id: 1, visible: 1 });
  console.log('متصل بقاعدة بيانات MongoDB بنجاح');
}

function getDb() {
  if (!db) db = cache.db;
  if (!db) throw new Error('قاعدة البيانات غير متصلة بعد');
  return db;
}

module.exports = { connect, getDb };
