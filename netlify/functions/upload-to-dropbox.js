const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const DROPBOX_SHARE_URL = 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings';
const DROPBOX_LIST_SHARED_LINKS_URL = 'https://api.dropboxapi.com/2/sharing/list_shared_links';

const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function sanitizePathPart(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return cleaned || fallback;
}

function ensureLeadingSlash(path) {
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function toDropboxApiArg(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

async function getDropboxAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: requireEnv('DROPBOX_REFRESH_TOKEN'),
    client_id: requireEnv('DROPBOX_APP_KEY'),
    client_secret: requireEnv('DROPBOX_APP_SECRET'),
  });

  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropbox token refresh failed: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function createOrGetSharedLink(accessToken, path) {
  const createResponse = await fetch(DROPBOX_SHARE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });

  if (createResponse.ok) {
    const link = await createResponse.json();
    return link.url;
  }

  const createErrorText = await createResponse.text();
  if (!createErrorText.includes('shared_link_already_exists')) {
    throw new Error(`Dropbox share link failed: ${createErrorText}`);
  }

  const listResponse = await fetch(DROPBOX_LIST_SHARED_LINKS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path,
      direct_only: true,
    }),
  });

  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw new Error(`Dropbox existing link lookup failed: ${text}`);
  }

  const listData = await listResponse.json();
  return listData.links?.[0]?.url || '';
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const {
      fileName,
      fileType,
      fileData,
      stage,
      teamId,
      teamName,
      submittedBy,
    } = payload;

    if (!fileName || !fileData || !stage || !teamId) {
      return json(400, { error: 'Missing fileName, fileData, stage, or teamId.' });
    }

    if (!['draft', 'final'].includes(stage)) {
      return json(400, { error: 'Invalid submission stage.' });
    }

    const fileBuffer = Buffer.from(fileData, 'base64');
    if (fileBuffer.length > MAX_UPLOAD_BYTES) {
      return json(413, {
        error: 'File is too large for the Netlify upload endpoint.',
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }

    const accessToken = await getDropboxAccessToken();
    const uploadRoot = ensureLeadingSlash(process.env.DROPBOX_UPLOAD_ROOT || '/BIOMAG2026_Submissions');
    const safeTeamId = sanitizePathPart(teamId, 'unknown_team');
    const safeTeamName = sanitizePathPart(teamName, 'unnamed_team');
    const safeFileName = sanitizePathPart(fileName, 'submission.bin');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dropboxPath = `${uploadRoot}/${safeTeamId}_${safeTeamName}/${stage}/${timestamp}_${safeFileName}`;

    const uploadResponse = await fetch(DROPBOX_UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': toDropboxApiArg({
          path: dropboxPath,
          mode: 'add',
          autorename: true,
          mute: false,
          strict_conflict: false,
        }),
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      throw new Error(`Dropbox upload failed: ${text}`);
    }

    const uploadData = await uploadResponse.json();
    const sharedLink = await createOrGetSharedLink(accessToken, uploadData.path_display);

    return json(200, {
      fileName,
      fileType,
      fileSize: fileBuffer.length,
      stage,
      submittedBy,
      dropboxPath: uploadData.path_display,
      dropboxId: uploadData.id,
      sharedLink,
    });
  } catch (error) {
    console.error('upload-to-dropbox error:', error);
    return json(500, {
      error: error.message || 'Upload failed.',
    });
  }
};
