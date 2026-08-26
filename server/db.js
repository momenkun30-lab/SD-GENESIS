const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('خطأ: متغير البيئة MONGODB_URI غير معرّف. أضِفه في إعدادات الاستضافة.');
}

let client;
let db;

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(process.env.MONGODB_DB_NAME || 'release_dock');

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

  console.log('متصل بقاعدة بيانات MongoDB بنجاح');
  return db;
}

function getDb() {
  if (!db) throw new Error('قاعدة البيانات غير متصلة بعد — استدعِ connect() أولًا عند بدء تشغيل الخادم');
  return db;
}

module.exports = { connect, getDb };
