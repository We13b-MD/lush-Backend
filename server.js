require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Robust CORS Middleware supporting Live Server, Localhost, 127.0.0.1 and Private Network Access
// Enable CORS using standard battle-tested cors middleware
app.use(cors({
  origin: true, // reflect request origin back dynamically
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Access-Control-Request-Private-Network', 'x-admin-token'],
  optionsSuccessStatus: 204
}));

// Additional middleware for private network headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});

const DB_FILE = path.join(__dirname, 'lush_database.json');

// CheapDataHub Configuration
const CHEAPDATAHUB_API_KEY = process.env.CHEAPDATAHUB_API_KEY;
const CHEAPDATAHUB_AIRTIME_URL = 'https://www.cheapdatahub.ng/api/v1/resellers/airtime/purchase/';

// Admin Dashboard Password (set ADMIN_PASSWORD env var on Render for production)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// PostgreSQL (Supabase) Connection
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
      servername: 'aws-0-eu-north-1.pooler.supabase.com'
    },
    max: 10,
    idleTimeoutMillis: 2000,
    connectionTimeoutMillis: 25000
  });
  initPostgresDB();
} else {
  console.log('[PostgreSQL]: DATABASE_URL missing. Operating in local JSON DB mode.');
}

// Auto-create Supabase PostgreSQL Table & Idempotency Unique Index on Startup
async function initPostgresDB() {
  if (!pool) return;
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS lush_claims (
        id BIGSERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        raw_number VARCHAR(30),
        name VARCHAR(100),
        city VARCHAR(100),
        email VARCHAR(150),
        amount NUMERIC DEFAULT 0,
        prize_won VARCHAR(100),
        value NUMERIC DEFAULT 0,
        description TEXT,
        prev_balance NUMERIC DEFAULT 0,
        current_balance NUMERIC DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        provider_response JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lush_claims_phone ON lush_claims (phone_number);
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS value NUMERIC DEFAULT 0;
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS prev_balance NUMERIC DEFAULT 0;
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS current_balance NUMERIC DEFAULT 0;
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS provider_response JSONB;
      ALTER TABLE lush_claims ADD COLUMN IF NOT EXISTS prize_won VARCHAR(100);
    `;
    await pool.query(createTableQuery);

    const createAnalyticsTableQuery = `
      CREATE TABLE IF NOT EXISTS lush_analytics (
        session_id VARCHAR(100) PRIMARY KEY,
        impressions INTEGER DEFAULT 1,
        viewable INTEGER DEFAULT 0,
        clicks_spin INTEGER DEFAULT 0,
        clicks_buy INTEGER DEFAULT 0,
        exposure_time INTEGER DEFAULT 0,
        clicks_tap INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      ALTER TABLE lush_analytics ADD COLUMN IF NOT EXISTS clicks_tap INTEGER DEFAULT 0;
    `;
    await pool.query(createAnalyticsTableQuery);

    console.log('[Supabase PostgreSQL]: Connected to Supabase DB & verified table schema!');
    await syncLocalDataToPostgres();
  } catch (err) {
    console.log('[PostgreSQL Note]: Supabase remote connection pending/offline (' + err.message + '). Fallback to local JSON DB mode active.');
  }
}

// Sync helper: uploads local json claims to Supabase PostgreSQL on startup
async function syncLocalDataToPostgres() {
  if (!pool) return;
  try {
    const db = loadLocalDatabase();
    if (!db.claims || db.claims.length === 0) return;

    console.log(`[Supabase PostgreSQL Sync]: Found ${db.claims.length} local claims. Syncing missing records...`);
    let syncedCount = 0;

    for (const claim of db.claims) {
      const checkRes = await pool.query('SELECT id FROM lush_claims WHERE phone_number = $1', [claim.number]);
      if (checkRes.rows.length === 0) {
        const details = (claim.termiiResponse && claim.termiiResponse.data && claim.termiiResponse.data.details) || {};
        const valueAmount = parseFloat(details.paid_amount || details.amount || claim.value || claim.prizeAmount || 0);
        const descriptionText = details.api_response || details.ident || claim.description || `Airtime ₦${claim.prizeAmount} to ${claim.number}`;
        const prevBalance = parseFloat(details.balance_before || claim.prevBalance || 0);
        const currentBalance = parseFloat(details.balance_after || claim.currentBalance || 0);
        const providerDataStr = JSON.stringify(claim.termiiResponse || claim.providerResponse || {});

        await pool.query(`
          INSERT INTO lush_claims (phone_number, raw_number, name, city, email, amount, value, description, prev_balance, current_balance, status, provider_response, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          claim.number,
          claim.rawNumber || claim.number,
          claim.name || 'Anonymous',
          claim.city || 'Unknown',
          claim.email || '',
          claim.prizeAmount || claim.amount || 0,
          valueAmount,
          descriptionText,
          prevBalance,
          currentBalance,
          claim.status || 'success',
          providerDataStr,
          claim.timestamp || new Date()
        ]);
        syncedCount++;
      }
    }
    if (syncedCount > 0) {
      console.log(`[Supabase PostgreSQL Sync]: Successfully synced ${syncedCount} missing local records to Supabase claims table!`);
    } else {
      console.log('[Supabase PostgreSQL Sync]: Supabase table is already fully up-to-date.');
    }
  } catch (err) {
    console.error('[Supabase PostgreSQL Sync Error]:', err.message);
  }
}

// Rate Limiter: Max 10 requests per 15 minutes per IP address
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests from this IP. Please try again later.' }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Fallback JSON DB Helpers
function loadLocalDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = { claims: [], analytics: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.claims) data.claims = [];
    if (!data.analytics) data.analytics = [];
    return data;
  } catch (err) {
    return { claims: [], analytics: [] };
  }
}

function saveLocalDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Format Phone Number to 2348012345678
function formatPhone(phone) {
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '234' + cleaned.substring(1);
  } else if (!cleaned.startsWith('234') && cleaned.length === 10) {
    cleaned = '234' + cleaned;
  }
  return cleaned;
}

// Helper: Detect Nigerian Network Provider ID
// 1 = MTN, 2 = GLO, 3 = AIRTEL, 4 = 9MOBILE
function getProviderId(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.startsWith('234')) {
    num = '0' + num.substring(3);
  } else if (!num.startsWith('0') && num.length === 10) {
    num = '0' + num;
  }
  const prefix = num.substring(0, 4);

  const mtnPrefixes = ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916', '07025', '07026', '0704'];
  const gloPrefixes = ['0805', '0807', '0705', '0815', '0811', '0905', '0915'];
  const airtelPrefixes = ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'];
  const ninetmobilePrefixes = ['0809', '0817', '0818', '0909', '0908'];

  if (gloPrefixes.includes(prefix)) return 2;
  if (airtelPrefixes.includes(prefix)) return 3;
  if (ninetmobilePrefixes.includes(prefix)) return 4;
  if (mtnPrefixes.includes(prefix)) return 1;

  return 1; // Default fallback to MTN
}

// Send Airtime via CheapDataHub (Native HTTPS)
function sendCheapDataHubAirtime(phone, amount) {
  return new Promise((resolve) => {
    let localPhone = String(phone).replace(/\D/g, '');
    if (localPhone.startsWith('234')) {
      localPhone = '0' + localPhone.substring(3);
    }
    const providerId = getProviderId(localPhone);

    const payloadStr = JSON.stringify({
      provider_id: providerId,
      phone_number: localPhone,
      amount: Number(amount)
    });

    console.log(`[CheapDataHub Request Payload]:`, payloadStr);
    console.log(`[CheapDataHub API Key Used]:`, CHEAPDATAHUB_API_KEY ? (CHEAPDATAHUB_API_KEY.substring(0, 6) + '***') : 'NONE');

    const options = {
      hostname: 'www.cheapdatahub.ng',
      port: 443,
      path: '/api/v1/resellers/airtime/purchase/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr),
        'Authorization': `Bearer ${CHEAPDATAHUB_API_KEY}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 25000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('[CheapDataHub Response Body]:', body);
        let data = {};
        try {
          data = JSON.parse(body);
        } catch (e) {
          data = { raw: body };
        }
        const statusVal = String(data.status || data.Status || '').toLowerCase();
        const isSuccess = res.statusCode === 200 && (
          statusVal === 'true' || 
          statusVal === 'successful' || 
          statusVal === 'success' || 
          data.status === true || 
          data.success === true || 
          data.code === 200
        );
        resolve({ success: isSuccess, data: data });
      });
    });

    req.on('error', (err) => {
      console.error('[CheapDataHub HTTPS Error]:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[CheapDataHub Request Timeout]');
      resolve({ success: false, error: 'CheapDataHub API Timeout' });
    });

    req.write(payloadStr);
    req.end();
  });
}

// Idempotent Claim Endpoint (Postgres Atomic Lock)
async function handleClaim(req, res) {
  const params = req.method === 'POST' ? req.body : req.query;
  const { name, number, city, state, email, prize, timestamp, signature } = params;
  const userCity = city || state || 'Unknown';

  console.log(`\n===================================================`);
  console.log(`[API /claim-prize] Incoming Claim Request:`);
  console.log(`  - Name: ${name || 'Anonymous'}`);
  console.log(`  - Phone: ${number}`);
  console.log(`  - Location/State: ${userCity}`);
  console.log(`  - Email: ${email || 'None'}`);
  console.log(`  - Prize Claiming: ${prize || 'None'}`);
  console.log(`===================================================`);

  if (!number) {
    console.log(`[API Error]: Phone number missing in request`);
    return res.status(400).json({ status: 'error', message: 'Phone number is required' });
  }

  // -------------------------------------------------------------
  // SPIN OUTCOME VERIFICATION (Option B Secure Signature Check)
  // -------------------------------------------------------------
  if (!prize) {
    return res.status(400).json({ status: 'error', message: 'Prize info is required' });
  }

  if (prize === '₦200 Airtime' || prize === 'Super Flash Sale' || prize === '10% Discount') {
    if (!timestamp || !signature) {
      return res.status(400).json({ status: 'error', message: 'Security check failed: Verification signature missing.' });
    }
    // Verify timestamp to prevent replay attacks (valid for 10 minutes)
    const now = Date.now();
    if (now - Number(timestamp) > 10 * 60 * 1000 || Number(timestamp) > now + 60000) {
      return res.status(400).json({ status: 'error', message: 'Spin session expired. Please spin the wheel again.' });
    }
    // Recreate HMAC signature and compare
    const secret = ADMIN_PASSWORD || 'secret-salt';
    const pageMap = {
      '₦200 Airtime': 'page1_1',
      '10% Discount': 'page1_3',
      'Super Flash Sale': 'page1_2'
    };
    const expectedPage = pageMap[prize];
    const payload = `${prize}:${expectedPage}:${timestamp}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (signature !== expectedSignature) {
      console.warn(`[API Claim Verification Failed] Invalid signature for phone ${number}. Blocked.`);
      return res.status(403).json({ status: 'error', message: 'Security check failed. Invalid spin verification.' });
    }
  } else if (prize === 'Try Again') {
    return res.status(400).json({ status: 'error', message: 'Try Again is a non-winning outcome.' });
  } else {
    return res.status(400).json({ status: 'error', message: 'Invalid prize outcome.' });
  }

  // Set the actual airtime payout amount. Only '₦200 Airtime' earns direct airtime.
  // Other prizes like '10% Discount' or 'Super Flash Sale' are recorded but amount is 0.
  const prizeAmount = (prize === '₦200 Airtime') ? 200 : 0;

  const formattedPhone = formatPhone(number);
  console.log(`[Phone Formatted]: Raw "${number}" -> Formatted "${formattedPhone}"`);

  // -------------------------------------------------------------
  // EMAIL DEDUPLICATION CHECK (before any insert)
  // -------------------------------------------------------------
  if (email && email.trim()) {
    const normalizedEmail = email.trim().toLowerCase();
    if (pool) {
      try {
        const emailCheck = await pool.query('SELECT id, phone_number FROM lush_claims WHERE LOWER(email) = $1', [normalizedEmail]);
        if (emailCheck.rows.length > 0) {
          console.log(`[Email Dedup]: Email "${normalizedEmail}" already used by phone ${emailCheck.rows[0].phone_number}. Blocking.`);
          return res.json({ status: 'duplicate_email', message: 'This email address has already been used to claim a reward.' });
        }
      } catch (emailErr) {
        console.error('[Email Dedup Check Error]:', emailErr.message);
      }
    } else {
      const db = loadLocalDatabase();
      const emailMatch = db.claims.find(c => (c.email || '').toLowerCase() === normalizedEmail);
      if (emailMatch) {
        console.log(`[Email Dedup Local]: Email "${normalizedEmail}" already used. Blocking.`);
        return res.json({ status: 'duplicate_email', message: 'This email address has already been used to claim a reward.' });
      }
    }
  }

  // -------------------------------------------------------------
  // MODE 1: SUPABASE POSTGRESQL (Atomic Unique Lock Idempotency)
  // -------------------------------------------------------------
  if (pool) {
    try {
      console.log(`[Supabase PostgreSQL]: Attempting atomic insert for ${formattedPhone}...`);
      // Step A: Atomic Insert with Unique Phone Lock
      const insertQuery = `
        INSERT INTO lush_claims (phone_number, raw_number, name, city, email, amount, status, prize_won)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
        RETURNING id;
      `;
      const result = await pool.query(insertQuery, [
        formattedPhone,
        number,
        name || 'Anonymous',
        userCity,
        email || '',
        prizeAmount,
        prize
      ]);

      const claimId = result.rows[0].id;
      console.log(`[Supabase PostgreSQL]: Row inserted successfully! Assigned ID: ${claimId}`);

      // Step B: Send Airtime via CheapDataHub AFTER Postgres lock succeeds
      if (prizeAmount > 0) {
        console.log(`[CheapDataHub]: Initiating airtime payout for ${formattedPhone}...`);
        const cdhResult = await sendCheapDataHubAirtime(formattedPhone, prizeAmount);
        const finalStatus = cdhResult.success ? 'success' : 'failed';
        const details = (cdhResult.data && cdhResult.data.details) || {};

        const valueAmount = parseFloat(details.paid_amount || details.amount || prizeAmount);
        const descriptionText = details.api_response || details.ident || `Airtime ₦${prizeAmount} to ${formattedPhone}`;
        const prevBalance = parseFloat(details.balance_before || 0);
        const currentBalance = parseFloat(details.balance_after || 0);

        console.log(`[Supabase PostgreSQL]: Updating claim ID ${claimId} with CheapDataHub response data...`);
        await pool.query(
          `UPDATE lush_claims 
           SET status = $1, 
               value = $2, 
               description = $3, 
               prev_balance = $4, 
               current_balance = $5, 
               provider_response = $6
           WHERE id = $7`,
          [finalStatus, valueAmount, descriptionText, prevBalance, currentBalance, JSON.stringify(cdhResult), claimId]
        );
        console.log(`[Supabase PostgreSQL]: Row ID ${claimId} updated successfully with status: "${finalStatus}"`);

        if (!cdhResult.success) {
          const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed on provider';
          console.log('[Postgres Airtime Payout Failed]:', errMsg);
          return res.json({
            status: 'error',
            message: 'Airtime failed: ' + errMsg
          });
        }
      } else {
        await pool.query(`UPDATE lush_claims SET status = 'no_prize' WHERE id = $1`, [claimId]);
      }

      return res.json({
        status: 'success',
        message: `₦${prizeAmount} airtime sent to ${formattedPhone}`,
        id: claimId
      });

    } catch (err) {
      // Code 23505 = Postgres unique_violation (Duplicate phone lock triggered)
      if (err.code === '23505') {
        // Check if existing record was a failed attempt that can be re-tried
        try {
          const checkRes = await pool.query('SELECT id, status FROM lush_claims WHERE phone_number = $1', [formattedPhone]);
          const existingRow = checkRes.rows[0];

          if (existingRow && existingRow.status === 'failed') {
            console.log(`[Supabase Postgres]: Re-trying failed claim for ${formattedPhone}...`);
            const cdhResult = await sendCheapDataHubAirtime(formattedPhone, prizeAmount);
            const finalStatus = cdhResult.success ? 'success' : 'failed';
            const details = (cdhResult.data && cdhResult.data.details) || {};

            const valueAmount = parseFloat(details.paid_amount || details.amount || prizeAmount);
            const descriptionText = details.api_response || details.ident || `Airtime ₦${prizeAmount} to ${formattedPhone}`;
            const prevBalance = parseFloat(details.balance_before || 0);
            const currentBalance = parseFloat(details.balance_after || 0);

            await pool.query(
              `UPDATE lush_claims 
               SET status = $1, 
                   value = $2, 
                   description = $3, 
                   prev_balance = $4, 
                   current_balance = $5, 
                   provider_response = $6
               WHERE id = $7`,
              [finalStatus, valueAmount, descriptionText, prevBalance, currentBalance, JSON.stringify(cdhResult), existingRow.id]
            );

            if (!cdhResult.success) {
              const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed on provider';
              return res.json({ status: 'error', message: 'Airtime failed: ' + errMsg });
            }

            return res.json({
              status: 'success',
              message: `₦${prizeAmount} airtime sent to ${formattedPhone}`,
              id: existingRow.id
            });
          }
        } catch (checkErr) {
          console.error('[Postgres Re-try Check Error]:', checkErr.message);
        }

        console.log(`[Supabase Postgres Lock]: Duplicate attempt blocked for ${formattedPhone}`);
        return res.json({ status: 'duplicate', message: 'This number has already been submitted' });
      }
      console.log('[Postgres Query Fallback]: ' + err.message + '. Falling through to local JSON DB mode.');
    }
  }

  // -------------------------------------------------------------
  // MODE 2: FALLBACK LOCAL DB
  // -------------------------------------------------------------
  const db = loadLocalDatabase();
  const existing = db.claims.find(c => formatPhone(c.number) === formattedPhone);
  if (existing) {
    if (existing.status === 'failed') {
      console.log(`[Local DB]: Re-trying failed claim for ${formattedPhone}...`);
      const cdhResult = await sendCheapDataHubAirtime(formattedPhone, prizeAmount);
      const details = (cdhResult.data && cdhResult.data.details) || {};

      existing.status = cdhResult.success ? 'success' : 'failed';
      existing.value = parseFloat(details.paid_amount || details.amount || prizeAmount);
      existing.description = details.api_response || details.ident || `Airtime ₦${prizeAmount} to ${formattedPhone}`;
      existing.prevBalance = parseFloat(details.balance_before || 0);
      existing.currentBalance = parseFloat(details.balance_after || 0);
      existing.providerResponse = cdhResult;
      saveLocalDatabase(db);

      if (!cdhResult.success) {
        const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed on provider';
        return res.json({ status: 'error', message: 'Airtime failed: ' + errMsg });
      }

      return res.json({
        status: 'success',
        message: `₦${prizeAmount} airtime sent to ${formattedPhone}`,
        id: existing.id
      });
    }

    console.log(`[Local DB Idempotency Lock]: Duplicate claim blocked for ${formattedPhone}`);
    return res.json({ status: 'duplicate', message: 'This number has already been submitted' });
  }

  const newRecord = {
    id: Date.now(),
    name: name || 'Anonymous',
    number: formattedPhone,
    rawNumber: number,
    city: userCity,
    email: email || '',
    amount: prizeAmount,
    prizeWon: prize,
    value: prizeAmount,
    description: prizeAmount > 0 ? `Airtime ₦${prizeAmount} to ${formattedPhone}` : `${prize} to ${formattedPhone}`,
    prevBalance: 0,
    currentBalance: 0,
    timestamp: new Date().toISOString(),
    status: 'pending'
  };

  db.claims.push(newRecord);
  saveLocalDatabase(db);

  if (prizeAmount > 0) {
    const cdhResult = await sendCheapDataHubAirtime(formattedPhone, prizeAmount);
    const details = (cdhResult.data && cdhResult.data.details) || {};

    newRecord.status = cdhResult.success ? 'success' : 'failed';
    newRecord.value = parseFloat(details.paid_amount || details.amount || prizeAmount);
    newRecord.description = details.api_response || details.ident || `Airtime ₦${prizeAmount} to ${formattedPhone}`;
    newRecord.prevBalance = parseFloat(details.balance_before || 0);
    newRecord.currentBalance = parseFloat(details.balance_after || 0);
    newRecord.providerResponse = cdhResult;
    saveLocalDatabase(db);

    if (!cdhResult.success) {
      const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed on provider';
      console.log('[Airtime Payout Failed]:', errMsg);
      return res.json({
        status: 'error',
        message: 'Airtime failed: ' + errMsg
      });
    }
  } else {
    newRecord.status = 'no_prize';
    saveLocalDatabase(db);
  }

  return res.json({
    status: 'success',
    message: `₦${prizeAmount} airtime sent to ${formattedPhone}`,
    id: newRecord.id
  });
}

// Secure backend-driven spin outcome selector (Option B)
async function handleSpin(req, res) {
  let flashSaleAvailable = true;

  if (pool) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Lock the transaction to serialize concurrent Flash Sale checks
      await client.query('SELECT pg_advisory_xact_lock(98765);');

      const countRes = await client.query(
        "SELECT COUNT(*) FROM lush_claims WHERE prize_won = 'Super Flash Sale' AND status != 'failed'"
      );
      const count = parseInt(countRes.rows[0].count) || 0;
      if (count >= 2) {
        flashSaleAvailable = false;
      }
      await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      console.error('[PostgreSQL Spin Error]:', err.message);
    } finally {
      if (client) client.release();
    }
  } else {
    // Local DB fallback mode check
    const db = loadLocalDatabase();
    const count = db.claims.filter(c => c.prizeWon === 'Super Flash Sale' && c.status !== 'failed').length;
    if (count >= 2) {
      flashSaleAvailable = false;
    }
  }

  // Outcomes from dynamics.jpeg with their weights
  const outcomes = [
    { id: 'airtime', name: '₦200 Airtime', page: 'page1_1', weight: 50 },
    { id: 'discount', name: '10% Discount', page: 'page1_3', weight: 50 },
    { id: 'flash_sale', name: 'Super Flash Sale', page: 'page1_2', weight: flashSaleAvailable ? 0.02 : 0.0 },
    { id: 'try_again', name: 'Try Again', page: 'page1_5', weight: 30 }
  ];

  const totalWeight = outcomes.reduce((sum, o) => sum + o.weight, 0);
  let r = Math.random() * totalWeight;
  let chosen = outcomes[outcomes.length - 1];

  for (const o of outcomes) {
    r -= o.weight;
    if (r <= 0) {
      chosen = o;
      break;
    }
  }

  // Generate secure HMAC SHA-256 signature
  const timestamp = Date.now();
  const secret = ADMIN_PASSWORD || 'secret-salt';
  const payload = `${chosen.name}:${chosen.page}:${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  console.log(`[Spin Selected]: Outcome: "${chosen.name}" -> GWD Page: "${chosen.page}"`);

  return res.json({
    status: 'success',
    outcome: chosen.name,
    page: chosen.page,
    timestamp: timestamp,
    signature: signature
  });
}

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/api/spin', limiter, handleSpin);
app.post('/api/spin', limiter, handleSpin);

app.get('/api/claim-prize', limiter, handleClaim);
app.post('/api/claim-prize', limiter, handleClaim);

// Local analytics database upsert helper
function localAnalyticsUpsert(session_id, updater) {
  const db = loadLocalDatabase();
  let record = db.analytics.find(r => r.session_id === session_id);
  if (!record) {
    record = {
      session_id,
      impressions: 1,
      viewable: 0,
      clicks_spin: 0,
      clicks_buy: 0,
      exposure_time: 0,
      clicks_tap: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.analytics.push(record);
  }
  updater(record);
  record.updated_at = new Date().toISOString();
  saveLocalDatabase(db);
}

// Analytics API Endpoint: Init/Impression
app.post('/api/analytics/init', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ status: 'error', message: 'session_id is required' });
  }

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
        VALUES ($1, 1, 0, 0, 0, 0, 0)
        ON CONFLICT (session_id) DO NOTHING
      `, [session_id]);
      return res.json({ status: 'success' });
    } catch (err) {
      console.error('[Analytics Postgres Init Error]:', err.message);
    }
  }

  // Local fallback
  localAnalyticsUpsert(session_id, (rec) => {});
  return res.json({ status: 'success' });
});

// Analytics API Endpoint: Mark Viewable
app.post('/api/analytics/viewable', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ status: 'error', message: 'session_id is required' });
  }

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
        VALUES ($1, 1, 1, 0, 0, 0, 0)
        ON CONFLICT (session_id) DO UPDATE SET viewable = 1, updated_at = NOW()
      `, [session_id]);
      return res.json({ status: 'success' });
    } catch (err) {
      console.error('[Analytics Postgres Viewable Error]:', err.message);
    }
  }

  // Local fallback
  localAnalyticsUpsert(session_id, (rec) => {
    rec.viewable = 1;
  });
  return res.json({ status: 'success' });
});

// Analytics API Endpoint: Track Click
app.post('/api/analytics/click', async (req, res) => {
  const { session_id, click_type } = req.body;
  if (!session_id || !click_type) {
    return res.status(400).json({ status: 'error', message: 'session_id and click_type are required' });
  }

  if (pool) {
    try {
      if (click_type === 'spin') {
        await pool.query(`
          INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
          VALUES ($1, 1, 0, 1, 0, 0, 0)
          ON CONFLICT (session_id) DO UPDATE SET clicks_spin = lush_analytics.clicks_spin + 1, updated_at = NOW()
        `, [session_id]);
      } else if (click_type === 'buy') {
        await pool.query(`
          INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
          VALUES ($1, 1, 0, 0, 1, 0, 0)
          ON CONFLICT (session_id) DO UPDATE SET clicks_buy = lush_analytics.clicks_buy + 1, updated_at = NOW()
        `, [session_id]);
      } else if (click_type === 'tap_button') {
        await pool.query(`
          INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
          VALUES ($1, 1, 0, 0, 0, 0, 1)
          ON CONFLICT (session_id) DO UPDATE SET clicks_tap = lush_analytics.clicks_tap + 1, updated_at = NOW()
        `, [session_id]);
      }
      return res.json({ status: 'success' });
    } catch (err) {
      console.error('[Analytics Postgres Click Error]:', err.message);
    }
  }

  // Local fallback
  localAnalyticsUpsert(session_id, (rec) => {
    if (click_type === 'spin') rec.clicks_spin++;
    else if (click_type === 'buy') rec.clicks_buy++;
    else if (click_type === 'tap_button') {
      if (!rec.clicks_tap) rec.clicks_tap = 0;
      rec.clicks_tap++;
    }
  });
  return res.json({ status: 'success' });
});

// Analytics API Endpoint: Track Exposure Duration
app.post('/api/analytics/exposure', async (req, res) => {
  const { session_id, seconds } = req.body;
  const secs = parseInt(seconds) || 0;
  if (!session_id) {
    return res.status(400).json({ status: 'error', message: 'session_id is required' });
  }

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO lush_analytics (session_id, impressions, viewable, clicks_spin, clicks_buy, exposure_time, clicks_tap)
        VALUES ($1, 1, 0, 0, 0, $2, 0)
        ON CONFLICT (session_id) DO UPDATE SET exposure_time = lush_analytics.exposure_time + $2, updated_at = NOW()
      `, [session_id, secs]);
      return res.json({ status: 'success' });
    } catch (err) {
      console.error('[Analytics Postgres Exposure Error]:', err.message);
    }
  }

  // Local fallback
  localAnalyticsUpsert(session_id, (rec) => {
    rec.exposure_time += secs;
  });
  return res.json({ status: 'success' });
});

// Helper to calculate analytics summary
async function getAnalyticsSummary() {
  if (pool) {
    try {
      const result = await pool.query(`
        SELECT 
          COALESCE(SUM(impressions), 0)::integer as total_impressions,
          COALESCE(SUM(viewable), 0)::integer as total_viewable,
          COALESCE(SUM(clicks_spin), 0)::integer as total_clicks_spin,
          COALESCE(SUM(clicks_buy), 0)::integer as total_clicks_buy,
          COALESCE(SUM(exposure_time), 0)::integer as total_exposure_time,
          COALESCE(SUM(clicks_tap), 0)::integer as total_clicks_tap
        FROM lush_analytics
      `);
      const row = result.rows[0] || {};
      const totalImpressions = parseInt(row.total_impressions) || 0;
      const totalViewable = parseInt(row.total_viewable) || 0;
      const totalClicksSpin = parseInt(row.total_clicks_spin) || 0;
      const totalClicksBuy = parseInt(row.total_clicks_buy) || 0;
      const totalClicksTap = parseInt(row.total_clicks_tap) || 0;
      const totalClicks = totalClicksSpin + totalClicksBuy;
      const totalExposureTime = parseInt(row.total_exposure_time) || 0;

      return {
        totalImpressions,
        totalViewable,
        viewabilityRate: totalImpressions > 0 ? (totalViewable / totalImpressions) * 100 : 0,
        totalClicksSpin,
        totalClicksBuy,
        totalClicksTap,
        totalClicks,
        totalExposureTime,
        avgExposureTime: totalImpressions > 0 ? (totalExposureTime / totalImpressions) : 0
      };
    } catch (err) {
      console.error('[Analytics Summary Postgres Error]:', err.message);
    }
  }

  // Fallback: Local JSON database mode
  try {
    const db = loadLocalDatabase();
    const analytics = db.analytics || [];
    const totalImpressions = analytics.reduce((sum, r) => sum + (r.impressions || 0), 0);
    const totalViewable = analytics.reduce((sum, r) => sum + (r.viewable || 0), 0);
    const totalClicksSpin = analytics.reduce((sum, r) => sum + (r.clicks_spin || 0), 0);
    const totalClicksBuy = analytics.reduce((sum, r) => sum + (r.clicks_buy || 0), 0);
    const totalClicksTap = analytics.reduce((sum, r) => sum + (r.clicks_tap || 0), 0);
    const totalClicks = totalClicksSpin + totalClicksBuy;
    const totalExposureTime = analytics.reduce((sum, r) => sum + (r.exposure_time || 0), 0);

    return {
      totalImpressions,
      totalViewable,
      viewabilityRate: totalImpressions > 0 ? (totalViewable / totalImpressions) * 100 : 0,
      totalClicksSpin,
      totalClicksBuy,
      totalClicksTap,
      totalClicks,
      totalExposureTime,
      avgExposureTime: totalImpressions > 0 ? (totalExposureTime / totalImpressions) : 0
    };
  } catch (err) {
    console.error('[Analytics Summary Local Error]:', err.message);
  }

  return {
    totalImpressions: 0,
    totalViewable: 0,
    viewabilityRate: 0,
    totalClicksSpin: 0,
    totalClicksBuy: 0,
    totalClicks: 0,
    totalExposureTime: 0,
    avgExposureTime: 0
  };
}

// Admin Stats Endpoint
app.get('/api/stats', async (req, res) => {
  const summary = await getAnalyticsSummary();
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM lush_claims ORDER BY id DESC');
      return res.json({ totalClaims: result.rowCount, claims: result.rows, summary });
    } catch (err) {
      return res.status(500).json({ error: err.message, summary });
    }
  }
  const db = loadLocalDatabase();
  res.json({ totalClaims: db.claims.length, claims: db.claims, summary });
});

// =============================================
// ADMIN DASHBOARD API ENDPOINTS
// =============================================

// Admin: Verify Password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ status: 'ok' });
  }
  return res.status(401).json({ status: 'error', message: 'Invalid password' });
});

// Admin: Auth Middleware
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

// Admin: Protected Stats (requires password)
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const summary = await getAnalyticsSummary();
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM lush_claims ORDER BY id DESC');
      return res.json({ totalClaims: result.rowCount, claims: result.rows, summary });
    } catch (err) {
      return res.status(500).json({ error: err.message, summary });
    }
  }
  const db = loadLocalDatabase();
  res.json({ totalClaims: db.claims.length, claims: db.claims, summary });
});

// Admin: Retry a Failed Claim
app.post('/api/admin/retry/:id', adminAuth, async (req, res) => {
  const claimId = req.params.id;

  // PostgreSQL Mode
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM lush_claims WHERE id = $1', [claimId]);
      if (result.rows.length === 0) {
        return res.json({ status: 'error', message: 'Claim not found' });
      }
      const claim = result.rows[0];
      if (claim.status !== 'failed') {
        return res.json({ status: 'error', message: `Cannot retry claim with status "${claim.status}"` });
      }

      const phone = claim.phone_number;
      const amount = parseFloat(claim.amount) || 0;

      console.log(`[Admin Retry]: Retrying failed claim ID ${claimId} for ${phone}, ₦${amount}...`);
      const cdhResult = await sendCheapDataHubAirtime(phone, amount);
      const finalStatus = cdhResult.success ? 'success' : 'failed';
      const details = (cdhResult.data && cdhResult.data.details) || {};

      const valueAmount = parseFloat(details.paid_amount || details.amount || amount);
      const descriptionText = details.api_response || details.ident || `Airtime ₦${amount} to ${phone}`;
      const prevBalance = parseFloat(details.balance_before || 0);
      const currentBalance = parseFloat(details.balance_after || 0);

      await pool.query(
        `UPDATE lush_claims
         SET status = $1,
             value = $2,
             description = $3,
             prev_balance = $4,
             current_balance = $5,
             provider_response = $6
         WHERE id = $7`,
        [finalStatus, valueAmount, descriptionText, prevBalance, currentBalance, JSON.stringify(cdhResult), claimId]
      );

      console.log(`[Admin Retry]: Claim ID ${claimId} updated to "${finalStatus}"`);

      if (!cdhResult.success) {
        const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed';
        return res.json({ status: 'error', message: errMsg });
      }

      return res.json({ status: 'success', message: `₦${amount} airtime retried successfully for ${phone}` });

    } catch (err) {
      console.error('[Admin Retry Error]:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  // Fallback: Local JSON DB Mode
  const db = loadLocalDatabase();
  const claim = db.claims.find(c => String(c.id) === String(claimId));
  if (!claim) {
    return res.json({ status: 'error', message: 'Claim not found' });
  }
  if (claim.status !== 'failed') {
    return res.json({ status: 'error', message: `Cannot retry claim with status "${claim.status}"` });
  }

  const phone = claim.number || claim.phone_number;
  const amount = parseFloat(claim.amount || claim.prizeAmount) || 0;

  console.log(`[Admin Retry Local]: Retrying failed claim ID ${claimId} for ${phone}, ₦${amount}...`);
  const cdhResult = await sendCheapDataHubAirtime(phone, amount);
  const details = (cdhResult.data && cdhResult.data.details) || {};

  claim.status = cdhResult.success ? 'success' : 'failed';
  claim.value = parseFloat(details.paid_amount || details.amount || amount);
  claim.description = details.api_response || details.ident || `Airtime ₦${amount} to ${phone}`;
  claim.prevBalance = parseFloat(details.balance_before || 0);
  claim.currentBalance = parseFloat(details.balance_after || 0);
  claim.providerResponse = cdhResult;
  saveLocalDatabase(db);

  if (!cdhResult.success) {
    const errMsg = (cdhResult.data && (cdhResult.data.message || cdhResult.data.error || cdhResult.data.detail)) || cdhResult.error || 'Airtime topup failed';
    return res.json({ status: 'error', message: errMsg });
  }

  return res.json({ status: 'success', message: `₦${amount} airtime retried successfully for ${phone}` });
});

// Admin: Delete a Claim
app.delete('/api/admin/delete/:id', adminAuth, async (req, res) => {
  const claimId = req.params.id;

  // PostgreSQL Mode
  if (pool) {
    try {
      console.log(`[Admin Delete]: Request to delete claim ID ${claimId}...`);
      const result = await pool.query('DELETE FROM lush_claims WHERE id = $1 RETURNING id;', [claimId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ status: 'error', message: 'Claim not found' });
      }
      console.log(`[Admin Delete]: Claim ID ${claimId} successfully deleted from Postgres.`);
      return res.json({ status: 'success', message: 'Claim successfully deleted' });
    } catch (err) {
      console.error('[Admin Delete Error]:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  // Fallback: Local JSON DB Mode
  const db = loadLocalDatabase();
  const index = db.claims.findIndex(c => String(c.id) === String(claimId));
  if (index === -1) {
    return res.status(404).json({ status: 'error', message: 'Claim not found' });
  }

  console.log(`[Admin Delete Local]: Deleting claim ID ${claimId} from local JSON DB...`);
  db.claims.splice(index, 1);
  saveLocalDatabase(db);
  console.log(`[Admin Delete Local]: Claim ID ${claimId} successfully deleted.`);
  return res.json({ status: 'success', message: 'Claim successfully deleted' });
});

// Keep-Alive Self-Ping System (Prevents Render Free Tier from going to sleep)
const PUBLIC_URL = 'https://lush-backend-jwip.onrender.com';
console.log(`[Keep-Alive]: Active. Pinging ${PUBLIC_URL} every 10 minutes.`);
setInterval(() => {
  const url = `${PUBLIC_URL}/ping`;
  const reqLib = url.startsWith('https') ? require('https') : require('http');
  reqLib.get(url, (res) => {
    console.log(`[Keep-Alive]: Self-ping successful (Status: ${res.statusCode})`);
  }).on('error', (err) => {
    console.error('[Keep-Alive Error]:', err.message);
  });
}, 10 * 60 * 1000); // 10 minutes

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`  Lush Spin the Wheel Airtime Server (Active)`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`  CheapDataHub API Key: Configured`);
  console.log(`  CORS: Allowed for all origins (* / Live Server)`);
  console.log(`  Supabase Postgres: ${pool ? 'CONNECTED & ACTIVE' : 'PENDING'}`);
  console.log(`===================================================`);

  // Render Keep-Alive: Self-pings the server every 10 minutes to prevent container sleeping
  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_EXTERNAL_URL) {
    console.log(`[Keep-Alive]: Self-ping keep-alive activated for ${RENDER_EXTERNAL_URL}`);
    setInterval(() => {
      https.get(`${RENDER_EXTERNAL_URL}/ping`, (res) => {
        console.log(`[Keep-Alive]: Self-ping responded with status code: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error('[Keep-Alive]: Self-ping failed:', err.message);
      });
    }, 10 * 60 * 1000); // Self-ping every 10 minutes
  }
});
