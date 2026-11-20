const { StorageClient } = require('@supabase/storage-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'app-files';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('خطأ: SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير معرّفين في متغيرات البيئة.');
}

const storageClient = new StorageClient(`${SUPABASE_URL}/storage/v1`, {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
});

async function uploadBuffer(buffer, { folder, filename, contentType }) {
  if (buffer && buffer.__pre) return buffer.__pre;
  const ext = filename ? filename.split('.').pop() : 'bin';
  const path = `${folder}/${uuidv4()}.${ext}`;

  const { error } = await storageClient.from(BUCKET).upload(path, buffer, {
    contentType: contentType || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`فشل رفع الملف إلى Supabase Storage: ${error.message}`);

  const { data } = storageClient.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, publicId: path };
}

async function deleteByPublicId(publicId) {
  if (!publicId) return;
  try {
    const { error } = await storageClient.from(BUCKET).remove([publicId]);
    if (error) console.error('تعذر حذف الملف من Supabase Storage:', error.message);
  } catch (err) {
    console.error('تعذر حذف الملف من Supabase Storage:', err.message);
  }
}

async function createSignedUpload(folder, filename) {
  const ext = (filename || 'bin').split('.').pop().replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const path = `${folder}/${uuidv4()}.${ext}`;
  const { data, error } = await storageClient.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error(`تعذر إنشاء رابط الرفع: ${error.message}`);
  const pub = storageClient.from(BUCKET).getPublicUrl(path);
  return { signedUrl: data.signedUrl, path, publicUrl: pub.data.publicUrl };
}

function publicUrlFor(path) {
  return storageClient.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

module.exports = { uploadBuffer, deleteByPublicId, createSignedUpload, publicUrlFor };
